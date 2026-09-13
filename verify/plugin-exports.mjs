/**
 * Cross-plugin liveness audit.
 *
 * computer-user was silently dead because it imported a named export the
 * installed @deepseek-ai package no longer provides — a missing named export
 * fails the whole ES module and nothing warns. This scans every plugin in the
 * profile for that same class of defect, then actually imports each plugin entry
 * as the only honest liveness check (a silent load failure logs nothing).
 *
 * Usage: node verify/plugin-exports.mjs
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { PROFILE } from './_profile.mjs';

const require = createRequire(join(PROFILE, 'package.json'));
const profilePkg = JSON.parse(await readFile(join(PROFILE, 'package.json'), 'utf8'));
const deps = Object.keys(profilePkg.dependencies ?? {});

/**
 * Collect the JavaScript a plugin actually loads.
 *
 * `verify/` is skipped on purpose. It ships inside the package (so the suite is
 * reproducible from a release) but it is test code, and a test fixture that
 * deliberately quotes the broken import shape — doctor-heal.mjs does exactly that
 * — is not a missing export in the plugin. Scanning it produced a failure that
 * looked like a real regression.
 */
async function jsFiles(dir, out = [], depth = 0) {
  if (depth > 4) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    if (e.isDirectory() && e.name === 'verify') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await jsFiles(p, out, depth + 1);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"](@deepseek-ai\/[^'"]+)['"]/g;
const findings = [];
const copies = new Map();
let scanned = 0;

for (const dep of deps) {
  const dir = join(PROFILE, 'node_modules', dep);
  try { await stat(dir); } catch { continue; }
  const wanted = new Map();

  for (const file of await jsFiles(dir)) {
    scanned += 1;
    let src;
    try { src = await readFile(file, 'utf8'); } catch { continue; }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (!names.length) continue;
      const set = wanted.get(m[2]) ?? new Set();
      for (const n of names) set.add(n);
      wanted.set(m[2], set);
    }
  }

  for (const [pkg, names] of wanted) {
    let where;
    let mod;
    try {
      where = require.resolve(pkg);
      mod = await import(`file:///${where.replace(/\\/g, '/')}`);
    } catch (error) {
      findings.push({ dep, pkg, kind: 'uninspectable', detail: String(error && error.message).slice(0, 120) });
      continue;
    }
    if (!copies.has(pkg)) copies.set(pkg, where);
    const missing = [...names].filter((n) => !(n in mod));
    if (missing.length) findings.push({ dep, pkg, kind: 'missing-exports', missing });
  }
}

console.log(`scanned ${scanned} file(s) across ${deps.length} plugin(s)\n`);
console.log('resolved @deepseek-ai copies:');
for (const [pkg, where] of [...copies].sort()) console.log(`  ${pkg}\n      ${where.replace(/\\/g, '/')}`);

const fatal = findings.filter((f) => f.kind === 'missing-exports');
console.log('');
if (!fatal.length) console.log('NO missing named exports.');
else for (const f of fatal) console.log(`  ${f.dep} -> ${f.pkg}\n      missing: ${f.missing.join(', ')}`);
for (const f of findings.filter((x) => x.kind !== 'missing-exports')) console.log(`  (uninspectable) ${f.dep} -> ${f.pkg}: ${f.detail}`);

console.log('\nplugin entry import test:');
const bundles = (profilePkg.dsh?.profile?.bundles ?? []).filter((b) => !b.startsWith('@deepseek-ai/dsh-'));
const dead = [];
for (const bundle of bundles) {
  try {
    const entry = require.resolve(bundle);
    await import(`file:///${entry.replace(/\\/g, '/')}`);
    console.log(`  OK    ${bundle}`);
  } catch (error) {
    const line = String(error && error.message).split('\n')[0].slice(0, 150);
    console.log(`  FAIL  ${bundle}\n          ${line}`);
    dead.push(bundle);
  }
}
console.log(`\n${dead.length ? `${dead.length} plugin(s) fail to import.` : 'every plugin entry imports cleanly.'}`);

process.exit(fatal.length === 0 && dead.length === 0 ? 0 : 1);
