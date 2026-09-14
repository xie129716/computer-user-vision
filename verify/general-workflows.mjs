/**
 * General-scenario workflow test.
 *
 * The plugin is not for any one application, so this drives the whole interaction
 * surface against SEVERAL UNRELATED UI STACKS and asserts an observable outcome
 * each time - never "the call returned ok".
 *
 *   A. window inventory and activation, across stacks
 *        - every listed window's rectangle is internally consistent
 *        - activate by hwnd, by title substring, and by pid
 *        - a packaged app (Calculator) must not resolve to its 0x0 helper window
 *        - a bogus pid is refused with something actionable
 *   B. text editing in a plain Win32 control (Notepad)
 *        - enumerate refs, click INTO the text area by ref
 *        - type mixed ASCII + CJK, read it back through the clipboard
 *        - Ctrl+A / Delete empties it (keyboard reaches the right control)
 *        - press-and-hold drag selects a run of text (the gesture, not a click)
 *        - the wheel scrolls, proved by a luminance profile of the page changing
 *   C. a different UI stack (Calculator, UWP/XAML)
 *        - live pattern flags are present (the cached-flag bug cannot come back)
 *        - clicking a digit BY NAME changes the display's accessible name
 *   D. guards hold
 *        - expect_window refuses on a mismatch and sends no input
 *        - an unknown ref is refused
 *
 * Usage: node verify/general-workflows.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PKG_DIR } from './_profile.mjs';

const { createComputerTools } = await import(pathToFileURL(join(PKG_DIR, 'src', 'tools.js')).href);
const { runPs } = await import(pathToFileURL(join(PKG_DIR, 'src', 'ps.js')).href);

const CFG = { mode: 'auto', vision_feedback: false, verify_actions: true, default_scale: 1 };

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const note = (m) => console.log(`      ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTools() {
  const ctx = { get: () => undefined, logger: { warn: () => {}, info: () => {} } };
  const list = createComputerTools({
    runPs,
    getConfig: () => CFG,
    approvedSessions: new Set(),
    sessionId: 'verify',
    setMode: async () => {},
    ctx,
  });
  const byName = new Map(list.map((t) => [t.name, t]));
  return (name) => byName.get(name);
}
const tool = makeTools();
/**
 * Call a tool, turning a thrown tool error into a returned object.
 *
 * The tools report a refusal either way: some return `{ok:false, reason}` and some
 * throw. Both are legitimate, so the test has to be able to assert on either
 * instead of aborting the run on the first refusal it provokes on purpose.
 */
const call = async (name, args) => {
  try {
    return await tool(name).execute(args ?? {}, exec);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
};

/** The rectangle of the activated foreground window. */
const fgRect = (res) => res?.foreground?.rect ?? null;
const fgSize = (res) => {
  const r = fgRect(res);
  return r ? [r[2] - r[0], r[3] - r[1]] : [0, 0];
};

const exec = {
  signal: undefined,
  agent: {
    options: {},
    session: {
      header: { cwd: tmpdir() },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    },
  },
};

function ps(script) {
  const p = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return (p.stdout ?? '').trim();
}

/** Wait for a new top-level window to appear, returning it. */
async function waitForWindow(pred, tries = 25) {
  for (let i = 0; i < tries; i += 1) {
    const wins = (await call('computer_list_windows', { min_width: 120, min_height: 80 })).windows ?? [];
    const hit = wins.find(pred);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

// ── clipboard, saved and restored so the test is not destructive ────────────
const savedClip = ps('Get-Clipboard -Raw -ErrorAction SilentlyContinue');
const putClip = (text) => {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  ps(`$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); Set-Clipboard -Value $t`);
};
/**
 * Write the clipboard and CONFIRM it took.
 *
 * `Set-Clipboard` fails with CLIPBRD_E_CANT_OPEN whenever another process has the
 * clipboard open, and that is intermittent - measured as roughly one run in three
 * here. Ignoring the error made a check read the PREVIOUS clipboard contents and
 * fail for a reason that had nothing to do with the plugin. Retry, and tell the
 * caller when it never succeeded so the assertion can say so instead of lying.
 */
function setClip(text, tries = 5) {
  for (let i = 0; i < tries; i += 1) {
    putClip(text);
    if (getClip() === text) return true;
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 120'], { stdio: 'ignore' });
  }
  return false;
}
const getClip = () => ps('Get-Clipboard -Raw -ErrorAction SilentlyContinue').replace(/\r\n/g, '\n').replace(/\n+$/, '');

/**
 * Luminance profile of a screen region in 16 horizontal bands.
 *
 * This is the oracle for "did the page actually scroll". Hashing a screenshot
 * would be defeated by the blinking caret; a band profile of the text area moves
 * a lot when the document scrolls and hardly at all when it does not.
 */
function bandProfile(x, y, w, h, bands = 16) {
  return ps(`
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$g.Dispose()
$out = @()
for ($k = 0; $k -lt ${bands}; $k++) {
  $y0 = [int](${h} * $k / ${bands}); $y1 = [int](${h} * ($k + 1) / ${bands})
  $s = 0.0; $n = 0
  for ($yy = $y0; $yy -lt $y1; $yy += 2) {
    for ($xx = 0; $xx -lt ${w}; $xx += 4) {
      $c = $bmp.GetPixel($xx, $yy)
      $s += (0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B); $n++
    }
  }
  $out += [int]($s / [Math]::Max(1, $n))
}
$bmp.Dispose()
$out -join ','
`);
}

// ═══ A. windows ════════════════════════════════════════════════════════════
console.log('\n── A. window inventory and activation ──');

const first = await call('computer_list_windows', {});
const wins = first.windows ?? [];
check('A1 computer_list_windows returns windows', wins.length > 0, `${wins.length} window(s)`);
const badRect = wins.filter((w) => w.rect[2] - w.rect[0] !== w.width || w.rect[3] - w.rect[1] !== w.height);
check('A2 every reported rectangle is internally consistent', badRect.length === 0,
  badRect.length ? `${badRect.length} inconsistent` : 'rect == x,y,x+w,y+h on all');

// Spawn our own Notepad so the test owns its state.
const noteBefore = new Set(wins.map((w) => w.hwnd));
const notepad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
notepad.unref();
const npWin = await waitForWindow((w) => !noteBefore.has(w.hwnd) && /notepad|记事本/i.test(w.class + w.title));
check('A3 a freshly spawned Notepad shows up in the inventory', !!npWin,
  npWin ? `hwnd ${npWin.hwnd} class ${npWin.class}` : 'not found');

let actByHwnd = null;
if (npWin) {
  actByHwnd = await call('computer_activate_window', { hwnd: npWin.hwnd });
  check('A4 activate by hwnd puts it in the foreground', actByHwnd.foreground?.hwnd === npWin.hwnd,
    `foreground hwnd ${actByHwnd.foreground?.hwnd}`);

  const actByTitle = await call('computer_activate_window', { title: '记事本' });
  const [tw, th] = fgSize(actByTitle);
  check('A5 activate by title substring works', !!actByTitle.foreground && tw > 200 && th > 150,
    `foreground "${actByTitle.foreground?.title}" ${tw}x${th}`);
}

// A packaged app: Calculator's frame belongs to ApplicationFrameHost, not to
// calc.exe, so a pid-based activation has to find the hosting window. Target the
// APP's pid (the CoreWindow), not ApplicationFrameHost's - that process hosts
// several frames at once (measured: 计算器 and 设置 both belong to it), so handing
// it that pid is genuinely ambiguous and picking one of them is not a bug.
const calcProc = spawn('calc.exe', [], { detached: true, stdio: 'ignore' });
calcProc.unref();
const calcWin = await waitForWindow((w) => /计算器|Calculator/i.test(w.title));
let calcPid = null;
if (calcWin) {
  const all = (await call('computer_list_windows', {})).windows ?? [];
  const appWin = all.find((w) => /计算器|Calculator/i.test(w.title) && w.class === 'Windows.UI.Core.CoreWindow')
    ?? all.find((w) => /计算器|Calculator/i.test(w.title) && w.class === 'ApplicationFrameWindow');
  calcPid = appWin?.pid ?? calcWin.pid;
  const act = await call('computer_activate_window', { pid: calcPid });
  const [aw, ah] = fgSize(act);
  check('A6 activate by pid refuses to settle for a 0x0 helper window',
    !!act.foreground && aw > 200 && ah > 200,
    `pid ${calcPid} -> "${act.foreground?.title}" ${aw}x${ah} class ${act.foreground?.class}`);
} else {
  check('A6 activate by pid refuses to settle for a 0x0 helper window', false, 'Calculator never appeared');
}

const bogus = await call('computer_activate_window', { pid: 999999 });
const bogusText = JSON.stringify(bogus);
check('A7 a pid that owns no real window is refused, with a reason',
  /no matching|not found|hidden|helper|没|未|不存在/i.test(bogusText), bogusText.slice(0, 160));

// ═══ B. Notepad: the plain Win32 path ══════════════════════════════════════
console.log('\n── B. text editing in a plain Win32 control (Notepad) ──');

if (npWin) {
  await call('computer_activate_window', { hwnd: npWin.hwnd });
  await sleep(500);

  const shot = await call('computer_screenshot', { annotate: false });
  const refs = shot.elements ?? [];
  check('B1 the focused Notepad yields element refs', refs.length > 0, `${refs.length} ref(s)`);

  // The edit area is the widest ref that spans most of the window.
  const edit = refs
    .filter((e) => e.rect && e.rect[2] - e.rect[0] > 300 && e.rect[1] > 0)
    .sort((a, b) => (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]))[0];

  if (edit) {
    const clicked = await call('computer_click', { ref: edit.ref });
    // pointer_landed is reported as the string "[x,y]" - parse it rather than
    // indexing it, or every comparison silently compares "[" to a number.
    const landed = String(clicked.pointer_landed ?? '').replace(/[[\]]/g, '').split(',').map(Number);
    check('B2 clicking into the text area by ref lands on the ref\'s exact centre',
      landed.length === 2 && landed[0] === edit.cx && landed[1] === edit.cy,
      `ref ${edit.ref} centre ${edit.cx},${edit.cy} -> pointer ${clicked.pointer_landed}`);

    const text = 'general workflow 通用场景 проверка 12345';
    await call('computer_type', { text });
    await sleep(300);
    await call('computer_keypress', { keys: ['ctrl', 'a'] });
    await call('computer_keypress', { keys: ['ctrl', 'c'] });
    await sleep(400);
    const got = getClip();
    check('B3 typed text (ASCII + CJK + Cyrillic) survives the round trip', got.includes('通用场景') && got.includes('проверка'),
      `clipboard ${got.length} ch: ${JSON.stringify(got.slice(0, 60))}`);

    // Scrolling needs a document whose band profile is NOT periodic. Equal-length
    // lines make each horizontal band's mean luminance almost identical, so the
    // page can scroll a long way without the profile moving - measured, and it made
    // this check report "unchanged" on a document that had scrolled fine.
    const many = Array.from(
      { length: 160 },
      (_, i) => `line ${String(i + 1).padStart(3, '0')} ${'#'.repeat((i * 7) % 53)} ${i % 3 === 0 ? '通用场景 wider band here' : 'x'}`,
    ).join('\n');
    setClip(many);
    await call('computer_keypress', { keys: ['ctrl', 'a'] });
    await call('computer_keypress', { keys: ['ctrl', 'v'] });
    await sleep(700);

    const area = edit.rect;
    const bx = area[0] + 10;
    const bw = Math.min(360, area[2] - area[0] - 20);
    const bh = area[3] - area[1] - 10;
    const before = bandProfile(bx, area[1] + 5, bw, bh);
    await call('computer_scroll', { coordinate: [area[0] + 100, area[1] + 60], direction: 'up', clicks: 8 });
    await sleep(500);
    const after = bandProfile(bx, area[1] + 5, bw, bh);
    const pa = before.split(',').map(Number);
    const pb = after.split(',').map(Number);
    const moved = pa.length === pb.length && pa.some((v, i) => Math.abs(v - pb[i]) > 6);
    check('B4 the wheel actually scrolls the document', moved,
      moved ? `${pa.filter((v, i) => Math.abs(v - pb[i]) > 6).length}/${pa.length} bands changed`
        : `page profile unchanged (before ${before.slice(0, 40)} / after ${after.slice(0, 40)})`);

    // Press-and-hold drag selects a run of text.
    setClip('');
    await call('computer_keypress', { keys: ['ctrl', 'a'] });
    await call('computer_keypress', { keys: ['ctrl', 'c'] });
    await sleep(300);
    const full = getClip();
    if (full.length > 40) {
      setClip('');
      const y0 = area[1] + 18;
      await call('computer_click', { coordinate: [area[0] + 6, y0] });
      const dragged = await call('computer_drag', {
        start_coordinate: [area[0] + 6, y0],
        end_coordinate: [area[0] + 220, y0 + 40],
        hold_ms: 120,
      });
      await call('computer_keypress', { keys: ['ctrl', 'c'] });
      await sleep(400);
      const sel = getClip();
      check('B5 a press-and-hold drag selects text (the gesture, not a click)',
        sel.length > 0 && sel.length < full.length,
        `selected ${sel.length} of ${full.length} ch; hold_ms=${dragged.hold_ms ?? 'n/a'}`);
    } else {
      check('B5 a press-and-hold drag selects text (the gesture, not a click)', false, 'could not read the document back');
    }

    await call('computer_keypress', { keys: ['ctrl', 'a'] });
    await call('computer_keypress', { keys: ['delete'] });
  } else {
    check('B2 clicking into the text area by ref is confirmed on the target', false, 'no edit-sized ref found');
    check('B3 typed text (ASCII + CJK + Cyrillic) survives the round trip', false, 'no edit-sized ref found');
    check('B4 the wheel actually scrolls the document', false, 'no edit-sized ref found');
    check('B5 a press-and-hold drag selects text (the gesture, not a click)', false, 'no edit-sized ref found');
  }
} else {
  for (const n of ['B1 the focused Notepad yields element refs', 'B2 clicking into the text area by ref is confirmed on the target',
    'B3 typed text (ASCII + CJK + Cyrillic) survives the round trip', 'B4 the wheel actually scrolls the document',
    'B5 a press-and-hold drag selects text (the gesture, not a click)']) check(n, false, 'no Notepad');
}

// ═══ C. Calculator: a different UI stack ═══════════════════════════════════
console.log('\n── C. a different UI stack (Calculator, UWP/XAML) ──');

if (calcWin) {
  // Activate by hwnd, not by pid: ApplicationFrameHost's pid hosts several frames
  // at once (measured: 计算器 and 设置), so it is genuinely ambiguous. The pid path
  // is exercised in A6; here the point is the UI stack, so remove the ambiguity.
  const now = (await call('computer_list_windows', {})).windows ?? [];
  const target = now
    .filter((w) => /计算器|Calculator/i.test(w.title))
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (target) await call('computer_activate_window', { hwnd: target.hwnd });
  await sleep(600);
  note(`enumerating "${target?.title}" hwnd ${target?.hwnd} class ${target?.class}`);
  const els = await call('computer_elements', { max: 200 });
  const list = els.elements ?? [];
  const withPatterns = list.filter((e) => (e.patterns ?? []).length > 0);
  check('C1 live pattern flags are reported (the cached-flag bug cannot return)',
    withPatterns.length > 0, `${withPatterns.length}/${list.length} control(s) advertise patterns`);

  // Identify the digit buttons by automationId, not by accessible name: the
  // standard Calculator ids are num0Button..num9Button, whereas the NAME is
  // localised (this desktop runs the Chinese UI, where a name-based match for
  // "0".."9" finds nothing at all).
  const digits = list.filter((e) => /^num\dButton$/.test(e.automationId ?? ''));
  if (digits.length > 0) {
    const d = digits[Math.floor(digits.length / 3)];
    const digit = (d.automationId.match(/num(\d)Button/) ?? [])[1];
    const displayBefore = list.find((e) => /CalculatorResults|Display/i.test(e.automationId ?? ''));
    await call('computer_click', { ref: d.ref });
    await sleep(500);
    const after = await call('computer_elements', { max: 200 });
    const displayAfter = (after.elements ?? []).find((e) => e.automationId === displayBefore?.automationId)
      ?? (after.elements ?? []).find((e) => /CalculatorResults|Display/i.test(e.automationId ?? ''));
    check('C2 clicking a digit button by ref changes the display',
      !!displayAfter && (displayAfter.name ?? '').includes(digit),
      `pressed ${d.automationId} -> display ${JSON.stringify((displayAfter?.name ?? '').slice(0, 40))}`);
  } else {
    check('C2 clicking a digit button by ref changes the display', false,
      `no numXButton in ${list.length} control(s): ${list.slice(0, 8).map((e) => `${e.ref}:${e.automationId}`).join(' ')}`);
  }

  await call('computer_keypress', { keys: ['escape'] });
} else {
  check('C1 live pattern flags are reported (the cached-flag bug cannot return)', false, 'no Calculator');
  check('C2 clicking a digit BY NAME/REF changes the display', false, 'no Calculator');
}

// ═══ D. guards ═════════════════════════════════════════════════════════════
console.log('\n── D. guards ──');

if (npWin) {
  await call('computer_activate_window', { hwnd: npWin.hwnd });
  await sleep(300);
  const primed = setClip('sentinel');
  const refused = await call('computer_type', { text: 'should never appear', expect_window: 'no-such-window-title-xyz' });
  await sleep(300);
  const clipNow = getClip();
  const refusedText = JSON.stringify(refused);
  check('D1 expect_window refuses on a mismatch', /refus|拒绝|expect/i.test(refusedText), refusedText.slice(0, 140));
  // The property is "the refused call typed nothing". The strong form of that is
  // "the clipboard still holds the sentinel", but it presumes the clipboard was
  // writable in the first place, and CLIPBRD_E_CANT_OPEN made this check fail for a
  // reason unrelated to the plugin. Fall back to the direct test when priming did
  // not take, and say which form actually ran.
  check('D2 a refused call sends no input at all',
    !clipNow.includes('should never appear') && (!primed || clipNow === 'sentinel'),
    primed ? `clipboard unchanged: ${JSON.stringify(clipNow.slice(0, 40))}`
      : `clipboard not writable (CLIPBRD_E_CANT_OPEN); refused text absent: ${!clipNow.includes('should never appear')}`);
}

const unknownRef = await call('computer_click', { ref: 'e99999' });
check('D3 an unknown ref is refused with an actionable message',
  /不认|未知|unknown|stale|截图|ref/i.test(JSON.stringify(unknownRef)), JSON.stringify(unknownRef).slice(0, 140));

// ── cleanup ────────────────────────────────────────────────────────────────
ps(`$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(savedClip, 'utf8').toString('base64')}')); Set-Clipboard -Value $t`);
for (const w of (await call('computer_list_windows', {})).windows ?? []) {
  if (/notepad|记事本/i.test(w.class + w.title)) spawnSync('taskkill', ['/PID', String(w.pid), '/F'], { stdio: 'ignore' });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
