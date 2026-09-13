/**
 * Doctor self-repair validation.
 *
 * Reverts the installed src/index.js to the upstream (broken) shape, then runs
 * the doctor in check mode, heals, and re-checks. Restores the original file at
 * the end, so the package is left exactly as it was found.
 *
 * Usage: node verify/doctor-heal.mjs
 */
import { readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PKG_DIR, DOCTOR, PROFILE } from './_profile.mjs';

const INDEX = join(PKG_DIR, 'src', 'index.js');
const BACKUP = `${INDEX}.verify-backup`;

const run = (args) => {
  const r = spawnSync(process.execPath, [DOCTOR, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

await copyFile(INDEX, BACKUP);
let source = await readFile(INDEX, 'utf8');

// ── revert to the upstream (broken) shape ───────────────────────────────────
source = source.replace(
  /import \* as settingsModule from '@deepseek-ai\/dsh-settings';/,
  "import { settingsNamespace } from '@deepseek-ai/dsh-settings';"
);
source = source.replace(
  /\/\*\*\n \* Settings API compatibility[\s\S]*?\nfunction settingsNamespaceCompat\(value\) \{\n  return settingsModule\.settingsNamespace\?\.\(value\) \?\? value;\n\}\n/,
  ''
);
source = source.replace(/settingsNamespaceCompat\(/g, 'settingsNamespace(');
source = source.replace(
  /sourceSetter = \(key, value\) => \(\n\s*typeof scope\.update === 'function'\n\s*\? scope\.update\(\{ \[key\]: value \}\)\n\s*: scope\.set\(key, value\)\n\s*\);/,
  'sourceSetter = (key, value) => scope.set(key, value);'
);
await writeFile(INDEX, source, 'utf8');

const broken = await readFile(INDEX, 'utf8');
console.log(`reverted to broken shape: ${/import\s*\{[^}]*settingsNamespace[^}]*\}/.test(broken) && /\.set\(key, value\)/.test(broken) ? 'yes' : 'NO — revert failed'}\n`);

const before = run([]);
console.log('--- doctor (check) on the broken copy ---');
console.log(before.out.trim());
console.log(`exit=${before.code}\n`);

const healed = run(['--heal']);
console.log('--- doctor --heal ---');
console.log(healed.out.trim());
console.log('');

const after = run([]);
console.log('--- doctor (check) after healing ---');
console.log(after.out.trim());
console.log(`exit=${after.code}\n`);

// The healed module must still register every tool.
const reg = spawnSync(process.execPath, [join(import.meta.dirname, 'registration.mjs')], { encoding: 'utf8', cwd: PROFILE });
const regOut = (reg.stdout || '') + (reg.stderr || '');
const regPass = /(\d+)\/(\d+) passed/.exec(regOut);
console.log(`registration contract after healing: ${regPass ? regPass[0] : 'no result'}`);
if (!regPass) console.log(`  reg exit=${reg.status} error=${reg.error ? reg.error.message : 'none'}`);

await copyFile(BACKUP, INDEX);
await rm(BACKUP, { force: true });
console.log('restored the original src/index.js');

const ok = before.code === 1 && after.code === 0 && regPass && regPass[1] === regPass[2];
console.log(`\n==== doctor self-repair ${ok ? 'VALIDATED' : 'FAILED'} ====`);
process.exit(ok ? 0 : 1);
