/**
 * Indicator HIT-TEST test — "which pixels of the banner eat a mouse click?"
 *
 * The lifecycle test (verify/overlay.mjs) proves the indicator starts and stops.
 * It cannot see the failure this script exists for: the banner used to be ONE
 * 620x46 window, and because a WS_EX_LAYERED window is hit-tested as a whole
 * layer, that entire strip swallowed clicks. A click on the `Ctrl+Alt+Esc` hint
 * label - which the user would reasonably read as decoration - reached nothing.
 *
 * The instrument is WindowFromPoint, which is deliberately the same question
 * Windows asks when routing a click: it skips transparent windows, so a point it
 * resolves to some OTHER process is a point the overlay does not consume. The
 * measured quantity is therefore exactly "does this pixel cost the user a click".
 *
 * Two properties are checked, and they pull in opposite directions:
 *
 *   * every point on the banner EXCEPT the Stop button must be click-through,
 *   * the Stop button must still be there, still be exactly where it was, and a
 *     real synthetic click on it must still write the stop marker.
 *
 * The second half is the important one. An earlier "fix" made the whole banner
 * click-through with WS_EX_TRANSPARENT and took the emergency brake with it; that
 * was caught by exactly this probe, and never shipped.
 *
 * Usage: node verify/overlay-hit.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { PKG_DIR } from './_profile.mjs';

const OVERLAY = join(PKG_DIR, 'src', 'overlay.ps1');
const dir = join(tmpdir(), 'computer-user');
const heartbeat = join(dir, 'hit-heartbeat');
const stopFile = join(dir, 'hit-stop');
const pauseFile = join(dir, 'hit-pause');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Live overlay processes.
 *
 * The match is deliberately narrow: `-File ... overlay.ps1`, which is how the
 * indicator is actually spawned. Matching a bare `overlay.ps1` substring was a
 * footgun - it also matched THIS script's own helper command lines, and any
 * caller (a shell, an editor, a deploy step) whose command text happened to name
 * the file. Killing those took the test runner down with them; observed as the
 * whole tool call dying with no output.
 *
 * `$PID` is excluded as well: a `-Command` helper's own text contains the pattern.
 */
const PS_OVERLAY_FILTER =
  "Where-Object { $_.CommandLine -like '*-File*overlay.ps1*' -and $_.ProcessId -ne $PID }";

function overlayPids() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
    `${PS_OVERLAY_FILTER} | ForEach-Object { $_.ProcessId }`,
  ], { encoding: 'utf8' });
  return (ps.stdout || '').split(/\s+/).filter(Boolean).map(Number);
}

function killOverlays() {
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
    `${PS_OVERLAY_FILTER} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ], { encoding: 'utf8' });
}

/**
 * The probe. Windows PowerShell 5.1, ASCII-only, delivered as -EncodedCommand so
 * no layer of quoting can corrupt it. It answers two questions per point - who
 * owns the pixel, and what rectangle is that window - and can fire one real click.
 */
const PROBE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CUHit {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, int f);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  static string Cls(IntPtr h) {
    if (h == IntPtr.Zero) return "-";
    StringBuilder s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString();
  }
  static int Pid(IntPtr h) {
    if (h == IntPtr.Zero) return 0;
    int p; GetWindowThreadProcessId(h, out p); return p;
  }
  static IntPtr Root(IntPtr h) { return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, 2); }

  public static string Probe(int x, int y) {
    POINT p; p.x = x; p.y = y;
    IntPtr h = WindowFromPoint(p);
    IntPtr root = Root(h);
    RECT r; r.Left = r.Top = r.Right = r.Bottom = -1;
    IntPtr forRect = (root == IntPtr.Zero) ? h : root;
    if (forRect != IntPtr.Zero) GetWindowRect(forRect, out r);
    return string.Format(
      "{{\\"x\\":{0},\\"y\\":{1},\\"pid\\":{2},\\"root_pid\\":{3},\\"cls\\":\\"{4}\\",\\"root_cls\\":\\"{5}\\",\\"rect\\":[{6},{7},{8},{9}],\\"ex\\":{10},\\"root_ex\\":{11}}}",
      x, y, Pid(h), Pid(root), Cls(h), Cls(root), r.Left, r.Top, r.Right, r.Bottom,
      h == IntPtr.Zero ? 0 : GetWindowLong(h, -20),
      root == IntPtr.Zero ? 0 : GetWindowLong(root, -20));
  }

  /**
   * Fire one real click and narrate everything that could stop it from landing:
   * whether the cursor actually moved, what is under the point, whether that
   * window is enabled and visible, its extended style (WS_EX_NOACTIVATE must be
   * present or the click gets eaten by activation), and who owns the foreground
   * before and after.
   */
  public static string ClickReport(int x, int y) {
    POINT was; GetCursorPos(out was);
    IntPtr fgBefore = GetForegroundWindow();
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(200);
    POINT now; GetCursorPos(out now);
    POINT p; p.x = x; p.y = y;
    IntPtr under = WindowFromPoint(p);
    IntPtr root = Root(under);
    string pre = string.Format(
      "cursor {0},{1} -> {2},{3} | under pid {4} cls {5} ex 0x{6:X8} enabled {7} visible {8} | root pid {9} cls {10} ex 0x{11:X8} | foreground before pid {12} cls {13}",
      was.x, was.y, now.x, now.y, Pid(under), Cls(under),
      under == IntPtr.Zero ? 0 : GetWindowLong(under, -20), IsWindowEnabled(under), IsWindowVisible(under),
      Pid(root), Cls(root), root == IntPtr.Zero ? 0 : GetWindowLong(root, -20), Pid(fgBefore), Cls(fgBefore));
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);   /* LEFTDOWN */
    System.Threading.Thread.Sleep(80);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);   /* LEFTUP   */
    System.Threading.Thread.Sleep(300);
    IntPtr fgAfter = GetForegroundWindow();
    IntPtr underAfter = WindowFromPoint(p);
    string post = string.Format("foreground after pid {0} cls {1} | under after pid {2} cls {3}",
      Pid(fgAfter), Cls(fgAfter), Pid(underAfter), Cls(underAfter));
    SetCursorPos(was.x, was.y);
    return pre + " || " + post;
  }
}
'@
[void][CUHit]::SetProcessDPIAware()
$clickReport = ''
if ($cfg.click) { $clickReport = [CUHit]::ClickReport([int]$cfg.click[0], [int]$cfg.click[1]) }
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$pts = @()
foreach ($pt in $cfg.points) { $pts += ([CUHit]::Probe([int]$pt[0], [int]$pt[1]) | ConvertFrom-Json) }
$probe = [ordered]@{
  dpi = [int][CUHit]::GetDpiForSystem()
  vs = @($vs.X, $vs.Y, $vs.Width, $vs.Height)
  points = @($pts)
  click_report = $clickReport
}
$probe | ConvertTo-Json -Depth 6 -Compress
`;

function runProbe(cfg) {
  const script = `$cfg = '${JSON.stringify(cfg)}' | ConvertFrom-Json\n${PROBE}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const ps = spawnSync('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (ps.status !== 0) throw new Error(`probe failed (${ps.status}): ${ps.stderr}`);
  return JSON.parse(ps.stdout.trim());
}

// ── run the indicator -------------------------------------------------------
rmSync(stopFile, { force: true });
rmSync(heartbeat, { force: true });
rmSync(pauseFile, { force: true });
killOverlays();
await sleep(600);

const config = {
  heartbeatFile: heartbeat,        // deliberately never created: no idle reaping
  stopFile,
  pauseFile,
  label: 'An AI agent is controlling this computer',
  stopLabel: 'Stop',
  hint: 'Ctrl+Alt+Esc',
  accentA: '#4D6BFE',
  accentB: '#22D3EE',
  thickness: 7,
  idleSeconds: 600,
  hotkeyMods: 3,
  hotkeyVk: 27,
};
const json = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
const overlay = spawn('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OVERLAY, '-Json', json],
  { stdio: 'ignore' });
await sleep(3500);

const pids = overlayPids();
const overlayPid = pids[0];
check('the indicator is running for the probe', pids.length === 1, `${pids.length} process(es): ${pids.join(',') || 'none'}`);

// ── geometry, derived from the same base units the script uses --------------
// The probe reports the real virtual screen and DPI; the rects are recomputed
// here rather than hard-coded, so this runs on a 1366x768 laptop or a scaled 4K
// panel without editing anything.
const geometry = runProbe({ points: [[0, 0]] });
const s = geometry.dpi / 96;
const [vx, vy, vw] = geometry.vs;
const bannerW = Math.round(620 * s);
const bannerH = Math.round(46 * s);
const bannerX = Math.round(vx + (vw - bannerW) / 2);
const bannerY = Math.round(vy + Math.round(10 * s));
const brakeW = Math.round(96 * s);
const brakeH = Math.round(30 * s);
const brakeX = bannerX + bannerW - brakeW - Math.round(12 * s);
const brakeY = bannerY + Math.round(8 * s);
console.log(`   geometry: virtual screen ${geometry.vs.join(',')} @ ${geometry.dpi} dpi (scale ${s})`);
console.log(`   banner [${bannerX},${bannerY} .. ${bannerX + bannerW},${bannerY + bannerH}]  brake [${brakeX},${brakeY} .. ${brakeX + brakeW},${brakeY + brakeH}]`);

/** Points on the banner that must NOT consume a click. */
const decoPoints = [
  ['accent bar', bannerX + 10, bannerY + Math.round(bannerH / 2)],
  ['label left', bannerX + 50, bannerY + Math.round(bannerH / 2)],
  ['label top', bannerX + 150, bannerY + 10],
  ['label bottom', bannerX + 250, bannerY + bannerH - 10],
  ['label right', bannerX + 350, bannerY + Math.round(bannerH / 2)],
  ['hint label start', bannerX + 400, bannerY + Math.round(bannerH / 2)],
  ['hint label mid', bannerX + 460, bannerY + Math.round(bannerH / 2)],
  ['just left of brake', bannerX + 500, bannerY + Math.round(bannerH / 2)],
  ['right of brake', bannerX + bannerW - 5, bannerY + 5],
  ['banner bottom left', bannerX + 5, bannerY + bannerH - 6],
];

/** Points inside the Stop button rect that MUST resolve to the indicator. */
const brakePoints = [
  ['brake centre', brakeX + Math.round(brakeW / 2), brakeY + Math.round(brakeH / 2)],
  ['brake top-left', brakeX + 3, brakeY + 3],
  ['brake bottom-right', brakeX + brakeW - 3, brakeY + brakeH - 3],
  ['brake top-mid', brakeX + Math.round(brakeW / 2), brakeY + 2],
];

const all = [...decoPoints, ...brakePoints];
const probed = runProbe({ points: all.map((p) => [p[1], p[2]]) });

const eaten = [];
decoPoints.forEach(([name], i) => {
  const at = probed.points[i];
  const owns = at.pid === overlayPid || at.root_pid === overlayPid;
  if (owns) eaten.push(`${name} (${at.x},${at.y}) -> ${at.root_cls}`);
  else console.log(`   ${name} (${at.x},${at.y}) passes through to pid ${at.root_pid} ${at.root_cls} [${at.rect.join(',')}]`);
});
check('no banner pixel except the Stop button consumes a click',
  eaten.length === 0, eaten.length ? `${eaten.length}/${decoPoints.length} still eaten: ${eaten.join(' | ')}` : `${decoPoints.length} points all click-through`);

const start = decoPoints.length;
const missed = [];
brakePoints.forEach(([name], i) => {
  const at = probed.points[start + i];
  const owns = at.pid === overlayPid || at.root_pid === overlayPid;
  if (!owns) missed.push(`${name} (${at.x},${at.y}) -> pid ${at.root_pid} ${at.root_cls}`);
  else console.log(`   ${name} (${at.x},${at.y}) lands on pid ${at.pid} ${at.cls}, root ${at.root_cls} [${at.rect.join(',')}]`);
});
check('every point inside the Stop button still belongs to the indicator',
  missed.length === 0, missed.length ? `fell through: ${missed.join(' | ')}` : `${brakePoints.length}/${brakePoints.length} held`);

const c = probed.points[start];
const rectOk = Math.abs(c.rect[0] - brakeX) <= 2 && Math.abs(c.rect[1] - brakeY) <= 2
  && Math.abs(c.rect[2] - (brakeX + brakeW)) <= 2 && Math.abs(c.rect[3] - (brakeY + brakeH)) <= 2;
check('the interactive window is exactly the Stop button, not the whole banner',
  rectOk, `hit window rect [${c.rect.join(',')}] vs expected [${brakeX},${brakeY},${brakeX + brakeW},${brakeY + brakeH}]`);
check('the interactive window is no bigger than the button (620x46 -> 96x30 base)',
  (c.rect[2] - c.rect[0]) <= brakeW + 2 && (c.rect[3] - c.rect[1]) <= brakeH + 2,
  `${c.rect[2] - c.rect[0]}x${c.rect[3] - c.rect[1]} screen px`);

// ── the brake must still brake ---------------------------------------------
rmSync(stopFile, { force: true });
const aliveBefore = overlayPids();
const click = runProbe({ points: [], click: [brakePoints[0][1], brakePoints[0][2]] });
console.log(`   ${click.click_report}`);
await sleep(1200);
const wrote = existsSync(stopFile);
const gone = overlayPids().length === 0;
check('the indicator is alive when the click is delivered', aliveBefore.length === 1,
  `${aliveBefore.length} process(es) before the click`);
check('a real click on the Stop button still writes the stop marker', wrote);
if (wrote) {
  const why = readFileSync(stopFile, 'utf8').trim();
  check("the marker says it was the user's button, not a reap", why === 'button', `content: ${JSON.stringify(why)}`);
}
check('a button stop also takes the indicator down', gone, gone ? 'no overlay process left' : `${overlayPids().length} still running`);

// ── cleanup ----------------------------------------------------------------
try { overlay.kill(); } catch { /* already gone */ }
killOverlays();
rmSync(stopFile, { force: true });
rmSync(heartbeat, { force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
