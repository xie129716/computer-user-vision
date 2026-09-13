/**
 * Bundled-script hygiene checks.
 *
 * Two rules that have each been broken once, in a way that stayed invisible until
 * something failed on the user's machine rather than in review:
 *
 *   1. **Every bundled `.ps1` must be pure ASCII.** Windows PowerShell 5.1 decodes
 *      a BOM-less `.ps1` as ANSI, so a UTF-8 em dash in a comment arrives as
 *      mojibake, and a mangled byte can terminate the string it sits in and stop
 *      the script parsing at all. Twice now a non-ASCII character slipped into a
 *      comment where it "obviously" could not matter.
 *
 *   2. **Nothing may reference a script that is no longer shipped.** When three
 *      one-shot scripts were merged into act.ps1, a stale reference only showed up
 *      as a runtime failure in the verification suite.
 *
 * Usage: node verify/ps1-hygiene.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { PKG_DIR } from './_profile.mjs';

/** Files that used to exist and must not be referenced any more. */
const RETIRED = ['capture.ps1', 'input.ps1', 'context.ps1'];

/**
 * Extensions worth scanning for stale references. Documentation is deliberately
 * excluded: the README, the changelog and the adaptation notes have to be able to
 * say which scripts were merged away and why. What must not mention them is code.
 */
const SCAN = ['.js', '.mjs', '.ps1', '.json', '.yml', '.yaml'];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(PKG_DIR);
const ps1 = files.filter((f) => f.endsWith('.ps1'));
check('the package ships at least one PowerShell script', ps1.length > 0, `${ps1.length}: ${ps1.map((f) => basename(f)).join(', ')}`);

// ── 1. ASCII only ───────────────────────────────────────────────────────────
const offenders = [];
for (const file of ps1) {
  const buf = await readFile(file);
  const hits = [];
  for (let i = 0; i < buf.length; i += 1) if (buf[i] > 127) hits.push(i);
  if (hits.length === 0) continue;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const where = hits.slice(0, 3).map((off) => {
    const lineNo = text.slice(0, off).split('\n').length;
    return `line ${lineNo}: ${(lines[lineNo - 1] ?? '').trim().slice(0, 70)}`;
  });
  offenders.push(`${basename(file)} (${hits.length} bytes) ${where.join(' | ')}`);
}
check('every bundled .ps1 is pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI)',
  offenders.length === 0, offenders.join(' ;; '));

// ── 2. no references to retired scripts ─────────────────────────────────────
const stale = [];
for (const file of files) {
  if (!SCAN.some((ext) => file.endsWith(ext))) continue;
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const name of RETIRED) {
    if (!text.includes(name)) continue;
    // This script names them on purpose, as the pass/fail message does.
    if (basename(file) === 'ps1-hygiene.mjs') continue;
    const line = text.split('\n').findIndex((l) => l.includes(name)) + 1;
    stale.push(`${basename(file)}:${line} mentions ${name}`);
  }
}
check('nothing references capture.ps1 / input.ps1 / context.ps1 (merged into act.ps1)',
  stale.length === 0, stale.join(' ;; '));

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
