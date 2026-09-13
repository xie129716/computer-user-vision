#!/usr/bin/env node
/**
 * Install THIS checkout into a DSH profile.
 *
 * The plugin is normally installed from the package registry, but this fork is
 * not published there, so a checkout has to be placed into a profile by hand.
 * Doing that by hand is how the fork and the profile drift apart: the profile
 * keeps serving an older copy, and a fix that was made in the source appears to
 * do nothing. This script makes the copy explicit and repeatable.
 *
 * Everything is derived from the environment - the DSH home, the profile name,
 * the package directory - so nothing here is tied to one machine.
 *
 *   node tools/install.mjs [profile] [options]
 *
 *   profile            profile to install into (default: web)
 *   --dsh-home <dir>   DSH home (default: $DSH_HOME, else ~/.dsh)
 *   --dry-run          list what would be copied, change nothing
 *   --force            write even when a pnpm patch covers this package
 *
 * Exits 0 on success, 1 on a condition the caller must fix.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Package entries that make up an installed plugin. */
const ENTRIES = [
  'src',
  'client.js',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
  'skills',
];

function parseArgs(argv) {
  const out = { profile: 'web', dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'), dryRun: false, force: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dsh-home') { out.dshHome = argv[i + 1]; i += 1; }
    else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 0) out.profile = rest[0];
  return out;
}

/** A pnpm patch for this package would overwrite whatever we copy in. */
function findPatch(profileDir) {
  const patches = join(profileDir, 'patches');
  if (!existsSync(patches)) return null;
  const hit = readdirSync(patches).find((f) => f.startsWith('computer-user@') && f.endsWith('.patch'));
  return hit ? join(patches, hit) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  const profileDir = join(args.dshHome, 'profiles', args.profile);
  const target = join(profileDir, 'node_modules', 'computer-user');

  console.log(`package : ${PACKAGE_ROOT}  (v${version})`);
  console.log(`profile : ${profileDir}`);

  if (!existsSync(profileDir)) {
    console.error(`\n[FAIL] profile directory does not exist: ${profileDir}`);
    console.error('       Point --dsh-home / the profile name at a profile that DSH has already created.');
    return 1;
  }
  if (!existsSync(target)) {
    console.error(`\n[FAIL] ${target} does not exist, so this profile has never installed computer-user.`);
    console.error('       Add "computer-user" to the profile first; a copy alone will not register it.');
    return 1;
  }

  const patch = findPatch(profileDir);
  if (patch && !args.force) {
    console.error(`\n[FAIL] this profile installs computer-user through a pnpm patch:\n         ${patch}`);
    console.error('       The next `pnpm install` re-applies that patch and would silently undo this copy.');
    console.error('       Edit the patch, drop it from patchedDependencies, or pass --force to copy anyway.');
    return 1;
  }

  const copied = [];
  for (const entry of ENTRIES) {
    const from = join(PACKAGE_ROOT, entry);
    if (!existsSync(from)) continue;
    copied.push(`${entry}${statSync(from).isDirectory() ? '/' : ''}`);
    if (!args.dryRun) {
      mkdirSync(dirname(join(target, entry)), { recursive: true });
      cpSync(from, join(target, entry), { recursive: true, force: true });
    }
  }

  console.log(`\n${args.dryRun ? 'would copy' : 'copied'} ${copied.length} entries:`);
  for (const c of copied) console.log(`  ${c}`);
  if (args.dryRun) console.log('\n(dry run: nothing was written)');
  else console.log('\nRestart the DSH host so the server-side modules are re-read.');
  return 0;
}

process.exit(main());
