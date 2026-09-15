#!/usr/bin/env node
/**
 * computer-user-vision doctor — health check + version-independent self-repair.
 *
 * Why this exists: a local adaptation is only as durable as the way it was
 * installed. Two shapes survive a `pnpm install`, and they need different
 * evidence: a URL/git dependency pins the fork in the profile's own
 * package.json, while a `pnpm patch` rewrites a registry version on install.
 * What does NOT survive is a bare registry version with no patch — the next
 * install silently restores upstream. This script is the safety net: it
 * re-derives the *defects* from the installed source rather than replaying a
 * diff, so it keeps working across versions.
 *
 * Two classes of problem, handled differently:
 *
 *   1. API drift (repairable) — the plugin imports `settingsNamespace` by name
 *      from `@deepseek-ai/dsh-settings`, an export that the 0.1.5 line dropped.
 *      A missing named export fails the whole ES module, so no tool, card or
 *      command ever registers. The repair is small, syntactic, and idempotent.
 *
 *   2. Missing feature (not repairable here) — the element-ref targeting and the
 *      vision-facing screenshot are large, multi-file changes. They cannot be
 *      re-derived from a new upstream release, so this reports them instead of
 *      guessing, and the pinned dependency keeps them in place.
 *
 * Usage:
 *   node tools/computer-user-vision-doctor.mjs           # check, exit 1 if unhealthy
 *   node tools/computer-user-vision-doctor.mjs --heal    # repair what is repairable
 *   node tools/computer-user-vision-doctor.mjs --quiet   # only problems (postinstall)
 */
import { readFile, writeFile, access, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the profile that owns the installed package.
 *
 * This file ships in the repository's `tools/`, but it is meant to be COPIED
 * into a profile's `scripts/` and run from that profile's `postinstall`. Those
 * two layouts put the package in different places, so resolve both instead of
 * assuming one: from `<profile>/scripts/` the package sits beside `HERE/..`,
 * while from a checkout the profile has to be looked up under the DSH home. An
 * earlier version hard-coded `HERE/..`, so running it straight from a checkout
 * searched `<repo>/node_modules/computer-user-vision` and declared a perfectly healthy
 * profile "not installed".
 *
 * Overrides: CU_PROFILE_DIR (the profile directory), CU_PROFILE (its name).
 */
function resolveProfileDir() {
  const explicit = process.env.CU_PROFILE_DIR;
  if (explicit) return resolve(explicit);

  const beside = resolve(join(HERE, '..'));
  const hasPackage = (dir) => existsSync(join(dir, 'node_modules', 'computer-user-vision', 'package.json'));
  if (hasPackage(beside)) return beside;

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const candidate = join(dshHome, 'profiles', process.env.CU_PROFILE || 'web');
  if (hasPackage(candidate)) return candidate;

  // Nothing matched: report against the sibling path, which gives the clearest
  // "package not installed at …" message for the layout we were run from.
  return beside;
}

const PROFILE_DIR = resolveProfileDir();
const PKG_DIR = join(PROFILE_DIR, 'node_modules', 'computer-user-vision');
const SETTINGS_PKG = '@deepseek-ai/dsh-settings';

const argv = new Set(process.argv.slice(2));
const HEAL = argv.has('--heal');
const QUIET = argv.has('--quiet');

const problems = [];
const actions = [];
const say = (line) => { if (!QUIET) console.log(line); };

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/**
 * Replace a file's contents WITHOUT writing through its inode.
 *
 * pnpm hard-links node_modules files to its content-addressed store (verified on
 * this machine: an untouched plugin's file has two links, the store one and the
 * node_modules one). An in-place truncate+write would follow that link and
 * corrupt the SHARED store entry, poisoning every other project on the machine.
 * Writing a sibling temp file and renaming it swaps in a fresh inode instead.
 *
 * A package currently carrying a `pnpm patch` is copied rather than linked, so
 * this only matters in exactly the situation the doctor exists for: the patch
 * was dropped and the package is pristine and hard-linked again.
 * @param {string} path - the file to replace.
 * @param {string} contents - the new contents.
 */
async function replaceFileSafely(path, contents) {
  const tmp = `${path}.doctor-tmp`;
  await writeFile(tmp, contents, 'utf8');
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Does the installed settings package still export the module-level helper?
 * Resolved from this script's directory, which walks the same node_modules
 * chain the plugin itself uses.
 * @returns {Promise<boolean>}
 */
async function settingsHelperExists() {
  try {
    const mod = await import(SETTINGS_PKG);
    return typeof mod.settingsNamespace === 'function';
  } catch {
    return false;
  }
}

/**
 * Rewrite a by-name `settingsNamespace` import into a namespace import plus a
 * feature-detecting shim. Idempotent: a source that is already namespace-based
 * comes back unchanged.
 * @param {string} source - the plugin's `src/index.js`.
 * @returns {{source: string, changed: boolean}}
 */
function repairSettingsImport(source) {
  const match = source.match(/import\s*\{([^}]*)\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"];?/);
  if (!match) return { source, changed: false };
  const names = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.includes('settingsNamespace')) return { source, changed: false };

  let out = source.replace(match[0], `import * as settingsModule from '${SETTINGS_PKG}';`);

  if (!/function\s+settingsNamespaceCompat/.test(out)) {
    // Keep the helper immediately after the settings import so the shim reads
    // as one unit with the API it bridges.
    out = out.replace(
      /(import \* as settingsModule from '@deepseek-ai\/dsh-settings';\n)/,
      '$1\n' +
        '/** Namespace shim: the 0.1.5 line dropped the module helper, so fall back to the plain name. */\n' +
        'function settingsNamespaceCompat(value) {\n' +
        '  return settingsModule.settingsNamespace?.(value) ?? value;\n' +
        '}\n'
    );
  }
  // `settingsNamespace(` never matches the shim's own `settingsNamespace?.(`.
  out = out.replace(/settingsNamespace\(/g, 'settingsNamespaceCompat(');
  return { source: out, changed: out !== source };
}

/**
 * `SettingsScope.set(key, value)` was replaced by `update(patch)` in the 0.1.5
 * line. Only the known `scope.set(key, value)` shape is rewritten; anything
 * else is reported for a human instead of guessed at.
 * @param {string} source - the plugin's `src/index.js`.
 * @returns {{source: string, changed: boolean}}
 */
function repairScopeSetter(source) {
  if (!/\.set\(\s*key\s*,\s*value\s*\)/.test(source)) return { source, changed: false };
  const out = source.replace(/([A-Za-z_$][\w$]*)\.set\(\s*key\s*,\s*value\s*\)/g, '$1.update({ [key]: value })');
  return { source: out, changed: out !== source };
}

// ── 1. is the package even installed? ───────────────────────────────────────
if (!(await exists(PKG_DIR))) {
  console.error(`computer-user-vision doctor: package not installed at ${PKG_DIR}`);
  process.exit(HEAL ? 0 : 1);
}

const pkgJson = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8'));
say(`computer-user-vision ${pkgJson.version} at ${PKG_DIR}`);

// ── 2. will a reinstall keep the fork? ──────────────────────────────────────
// An earlier version of this check only understood `pnpm patch`, so it reported
// a perfectly durable URL-pinned install as a problem on every single install.
{
  const workspaceYaml = await readFile(join(PROFILE_DIR, 'pnpm-workspace.yaml'), 'utf8').catch(() => '');
  const profPkg = JSON.parse(await readFile(join(PROFILE_DIR, 'package.json'), 'utf8').catch(() => '{}'));
  const spec = String((profPkg && profPkg.dependencies && profPkg.dependencies['computer-user-vision']) || '');
  const isPinnedSpec = /^(https?:|git\+|file:|link:)/.test(spec);
  const inWorkspace = /patchedDependencies:[\s\S]*computer-user-vision@/.test(workspaceYaml);
  const inPackage = !!(profPkg.pnpm && profPkg.pnpm.patchedDependencies && profPkg.pnpm.patchedDependencies['computer-user-vision']);
  if (isPinnedSpec) {
    say(`  pinned by the profile dependency itself: ${spec}`);
  } else if (inWorkspace || inPackage) {
    say(`  patch registered in patchedDependencies (dependency spec: ${spec || 'unknown'})`);
  } else {
    problems.push(
      `the dependency spec is "${spec || 'missing'}" with no pnpm patch, so the next install would restore `
      + 'upstream computer-user and drop every local fix — repoint the dependency at the fork tarball'
    );
  }
}

// ── 3. is the vision adaptation present in the installed source? ────────────
const indexJsPath = join(PKG_DIR, 'src', 'index.js');
const toolsJsPath = join(PKG_DIR, 'src', 'tools.js');
let indexJs = await readFile(indexJsPath, 'utf8');
const toolsJs = await readFile(toolsJsPath, 'utf8');

const visionPresent = /routeAcceptsImages/.test(toolsJs) && /screen_per_pixel/.test(toolsJs);
if (visionPresent) {
  say('  vision adaptation present (image block + screen_per_pixel)');
} else {
  problems.push(
    'vision adaptation MISSING — this version was not adapted; the screenshot will only return a file path again'
  );
}

// The fork's structural marker. Upstream never had a merged executor and never
// had element refs, so a release that silently reverted to upstream is caught
// here even if it happened to carry the vision change.
const hasExecutor = await exists(join(PKG_DIR, 'src', 'act.ps1'));
const hasElementRefs = /lookupRef|computer_elements/.test(toolsJs);
if (hasExecutor && hasElementRefs) {
  say('  exact-click targeting present (src/act.ps1 + element ref resolution)');
} else {
  problems.push(
    `exact-click targeting MISSING (act.ps1: ${hasExecutor ? 'yes' : 'no'}, ref resolution: ${hasElementRefs ? 'yes' : 'no'}) `
    + '— clicks fall back to estimating pixel positions off a downscaled screenshot'
  );
}

// ── 4. repair the load-breaking API drift ───────────────────────────────────
const helperStillExists = await settingsHelperExists();
const needsImportRepair = /import\s*\{[^}]*settingsNamespace[^}]*\}\s*from\s*['"]@deepseek-ai\/dsh-settings['"]/.test(indexJs);

if (needsImportRepair && !helperStillExists) {
  if (HEAL) {
    const fixed = repairSettingsImport(indexJs);
    if (fixed.changed) {
      indexJs = fixed.source;
      await replaceFileSafely(indexJsPath, indexJs);
      actions.push(`rewrote the settingsNamespace import + shim in ${indexJsPath}`);
    }
  } else {
    problems.push(
      `${SETTINGS_PKG} does not export settingsNamespace, but src/index.js imports it by name — the module will fail to load; run with --heal`
    );
  }
} else if (needsImportRepair && helperStillExists) {
  say('  named settingsNamespace import is still valid on this DSH — no repair needed');
} else {
  say('  settings import is already generation-agnostic');
}

// ── 5. repair the scope.set write path ──────────────────────────────────────
// A `scope.set(key, value)` inside a `typeof scope.update === 'function'` guard
// is the intentional cross-generation fallback, so only a source with no
// update() path at all counts as un-repaired.
const hasUpdatePath = /\.update\(/.test(indexJs);
if (!hasUpdatePath && /\.set\(\s*key\s*,\s*value\s*\)/.test(indexJs)) {
  if (HEAL) {
    const fixed = repairScopeSetter(indexJs);
    if (fixed.changed) {
      indexJs = fixed.source;
      await replaceFileSafely(indexJsPath, indexJs);
      actions.push('rewrote scope.set(key, value) to SettingsScope.update(patch)');
    }
  } else {
    problems.push('src/index.js writes only through SettingsScope.set(), removed in the 0.1.5 line; run with --heal');
  }
} else {
  say('  settings write path uses the current API');
}

// ── 6. does it actually load? ───────────────────────────────────────────────
try {
  const mod = await import(pathToFileURL(indexJsPath).href);
  say(`  module loads (${mod.name})`);
} catch (error) {
  problems.push(`module fails to load: ${String(error && error.message)}`);
}

// ── report ──────────────────────────────────────────────────────────────────
for (const action of actions) say(`  healer: ${action}`);
for (const problem of problems) console.error(`  PROBLEM: ${problem}`);

if (problems.length === 0) {
  say('computer-user-vision doctor: healthy');
  process.exit(0);
}
if (HEAL) {
  // Postinstall must never fail an install; problems are surfaced, not thrown.
  console.error(`computer-user-vision doctor: ${problems.length} unresolved problem(s) after healing`);
  process.exit(0);
}
console.error(`computer-user-vision doctor: ${problems.length} problem(s)`);
process.exit(1);
