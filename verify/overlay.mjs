/**
 * Control-indicator lifecycle test.
 *
 * Exercises src/overlay.js directly against the installed package: starting the
 * indicator must write a heartbeat and leave exactly one overlay process
 * running, and shutting it down must remove both the process and its state.
 *
 * A stop marker is intentionally NOT created here — only a real user action may
 * do that, and the mode gate treats one as a hard refusal.
 *
 * Usage: node verify/overlay.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PKG_DIR } from './_profile.mjs';

const { createOverlayController } = await import(pathToFileURL(join(PKG_DIR, 'src', 'overlay.js')).href);

const dir = join(tmpdir(), 'computer-user');
const heartbeat = join(dir, 'overlay-heartbeat');
const stopFile = join(dir, 'overlay-stop');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Count live overlay processes by command line.
 *
 * The match must be the actual spawn shape (`-File ... overlay.ps1`) and must
 * exclude $PID. Matching a bare `overlay.ps1` substring was worse than noisy: a
 * `-Command` helper's own text contains the pattern, and so does any caller whose
 * command happened to name the file - including the shell that launched this test,
 * which then got killed mid-run and took the whole suite down with it.
 */
const PS_OVERLAY_FILTER =
  "Where-Object { $_.CommandLine -like '*-File*overlay.ps1*' -and $_.ProcessId -ne $PID }";

function overlayProcesses() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
    `${PS_OVERLAY_FILTER} | Measure-Object).Count`,
  ], { encoding: 'utf8' });
  return Number((ps.stdout || '0').trim()) || 0;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Clean slate.
try { spawnSync('powershell.exe', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
  `${PS_OVERLAY_FILTER} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
], { encoding: 'utf8' }); } catch { /* nothing running */ }
await sleep(600);

const controller = createOverlayController({
  getConfig: () => ({ overlay: true, overlay_idle_seconds: 30 }),
  logger: { warn: (m) => console.log('   [warn]', m) },
});

check('indicator starts disabled-free', overlayProcesses() === 0, `${overlayProcesses()} pre-existing overlay process(es)`);

controller.activity();
await sleep(4000);

const running = overlayProcesses();
check('activity() launches exactly one overlay process', running === 1, `${running} process(es)`);
check('activity() writes the heartbeat', existsSync(heartbeat));
if (existsSync(heartbeat)) {
  const age = (Date.now() - statSync(heartbeat).mtimeMs) / 1000;
  check('heartbeat is fresh', age < 10, `${age.toFixed(1)}s old`);
}
check('no stop marker is written by the plugin itself', !existsSync(stopFile));

controller.shutdown();
await sleep(2000);
check('shutdown() reaps the overlay process', overlayProcesses() === 0, `${overlayProcesses()} process(es) left`);
check('shutdown() removes the heartbeat', !existsSync(heartbeat));
check('shutdown() leaves no stop marker', !existsSync(stopFile));

// A disabled indicator must never spawn anything.
const offController = createOverlayController({ getConfig: () => ({ overlay: false }), logger: { warn: () => {} } });
offController.activity();
await sleep(1200);
check('overlay=false spawns nothing', overlayProcesses() === 0, `${overlayProcesses()} process(es)`);
offController.shutdown();

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
