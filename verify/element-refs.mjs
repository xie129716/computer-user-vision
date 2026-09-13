/**
 * Element-reference verification (the accuracy contract).
 *
 * The whole point of element refs is that a click stops depending on a model
 * reading pixels off a downscaled screenshot. This script proves that against the
 * live desktop:
 *
 *   A. safe checks (always run, nothing is clicked)
 *      - computer_screenshot returns refs for the focused window's controls
 *      - every ref carries a rectangle whose centre is the point a click would use
 *      - computer_elements returns the same refs as the screenshot
 *      - an unknown ref is refused with an actionable message
 *      - an ambiguous name is refused and lists the candidates
 *   B. --click (opt in; launches its own Notepad and clicks inside it)
 *      - clicking by ref lands EXACTLY on the reported centre, and the tool
 *        confirms the hit
 *      - clicking by accessible name does the same
 *
 * Nothing here reads a pixel position off an image, so a pass means the click
 * target is exact by construction rather than by careful estimating.
 *
 * Usage:
 *   node verify/element-refs.mjs             # safe checks only
 *   node verify/element-refs.mjs --click     # also drives a Notepad it spawns
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PKG_DIR } from './_profile.mjs';

const { createComputerTools } = await import(pathToFileURL(join(PKG_DIR, 'src', 'tools.js')).href);
const { runPs } = await import(pathToFileURL(join(PKG_DIR, 'src', 'ps.js')).href);

const WITH_CLICK = process.argv.includes('--click');
const CFG = { mode: 'auto', vision_feedback: false, verify_actions: true, default_scale: 1 };

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`);

function makeTools() {
  const ctx = {
    get: () => undefined,
    logger: { warn: () => {}, info: () => {} },
  };
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

const tool = makeTools();

// ── A. safe checks ──────────────────────────────────────────────────────────
const shot = await tool('computer_screenshot').execute({ annotate: false }, exec);
const elements = Array.isArray(shot.elements) ? shot.elements : [];
check('A1 computer_screenshot carries an element ref list', elements.length > 0,
  `${elements.length} element(s) in the focused window`);
check('A2 every ref has a rectangle with a consistent centre', elements.every((el) => {
  if (!Array.isArray(el.rect) || el.rect.length !== 4) return false;
  const cx = Math.trunc((el.rect[0] + el.rect[2]) / 2);
  const cy = Math.trunc((el.rect[1] + el.rect[3]) / 2);
  return el.cx === cx && el.cy === cy;
}), 'cx/cy are the exact middle of rect, i.e. where a click lands');
check('A3 refs are unique', new Set(elements.map((el) => el.ref)).size === elements.length);
const spi = Array.isArray(shot.screen_per_image) ? shot.screen_per_image : [];
const mappedWidth = shot.width * (spi[0] ?? 0);
check('A4 the exact image->screen factor is reported and reproduces the screen',
  spi.length === 2 && Math.abs(mappedWidth - (shot.full_width ?? mappedWidth)) <= 2,
  `screen_per_image=[${spi.join(', ')}] -> ${mappedWidth.toFixed(1)} vs screen width ${shot.full_width}`);

const envelope = tool('computer_screenshot').output.render({}, shot).find((b) => b.type === 'text').text;
check('A5 the envelope hands the refs to the caller', /elements \(\d+\):/.test(envelope));
check('A6 the envelope tells the caller to click by ref', /computer_click \{ref/.test(envelope));

// An accessible name is unbounded: Notepad's edit control reports the ENTIRE
// document as its name (measured at 11800 characters for a 200-line file), and a
// click result carried all of it. Every emitted name is capped and every truncated
// one is flagged, so one hostile window cannot inflate a tool result to megabytes.
const NAME_CAP = 100;
const longestName = elements.reduce((m, el) => Math.max(m, (el.name ?? '').length), 0);
check('A6b emitted element names are capped', longestName <= NAME_CAP,
  `longest name ${longestName} chars (cap ${NAME_CAP}); ${elements.filter((el) => el.name_truncated).length} flagged as truncated`);
const elementBytes = JSON.stringify(elements).length;
check('A6c the element list stays a sane size', elementBytes < 40000,
  `${elementBytes} bytes for ${elements.length} element(s)`);

const listed = await tool('computer_elements').execute({}, exec);
const listedNames = (listed.elements ?? []).map((el) => `${el.ref}:${el.name}`);
const shotNames = elements.map((el) => `${el.ref}:${el.name}`);
check('A7 computer_elements agrees with the screenshot refs',
  listedNames.length === shotNames.length && listedNames.every((n, i) => n === shotNames[i]),
  `screenshot ${shotNames.length} refs vs computer_elements ${listedNames.length} refs`);

// A ref that cannot exist must be refused BEFORE any input is sent.
let unknownRefError = null;
try {
  await tool('computer_click').execute({ ref: 'e99999' }, exec);
} catch (error) {
  unknownRefError = error;
}
check('A8 an unknown ref is refused, not guessed', !!unknownRefError && /不认识/.test(unknownRefError.message),
  unknownRefError && unknownRefError.message.slice(0, 90));

// A name that matches several controls must not be resolved arbitrarily. The
// benchmark-free version of this check needs a name that really is shared, so
// reuse the shortest name that occurs more than once, if the window has one.
const counts = new Map();
for (const el of elements) {
  const n = (el.name ?? '').trim();
  if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
}
const dup = [...counts.entries()].find(([, c]) => c > 1);
if (dup) {
  const ambiguous = await tool('computer_click').execute({ name: dup[0] }, exec);
  check('A9 a name matching several controls is refused with candidates',
    ambiguous.ambiguous === true && Array.isArray(ambiguous.matches) && ambiguous.matches.length > 1,
    `"${dup[0]}" matched ${ambiguous.matches?.length} controls`);
} else {
  skip('A9 ambiguous-name refusal', 'the focused window has no duplicated control name');
}

// A minimized window must not be described by its on-screen sliver. Measured on a
// maximized browser: DWMWA_EXTENDED_FRAME_BOUNDS reports 146x21 while minimized,
// which is not where anything is, and a size filter then dropped the window from
// the listing entirely -- so "focus Edge" could not even find Edge. Minimized
// windows now carry their restored geometry and say so.
const allWindows = (await tool('computer_list_windows').execute({}, exec)).windows ?? [];
const minimized = allWindows.filter((w) => w.minimized === true);
const badMinimized = minimized.filter((w) => w.rect_is_restored !== true || w.width < 100 || w.height < 100);
check('A10 a minimized window reports restored geometry, not its 146x21 sliver',
  badMinimized.length === 0,
  `${minimized.length} minimized window(s); ${badMinimized.length} without usable geometry`);

// purpose:"look" is the cheap path for "just show me the screen": no element
// enumeration, JPEG, and a smaller frame. Measured on the PowerShell side, the
// enumeration alone doubles a capture (1075 ms against 521 ms), and the frame the
// vision model has to encode drops from ~135 KB to ~23 KB.
const tInspect = Date.now();
const insp = await tool('computer_screenshot').execute({}, exec);
const inspectMs = Date.now() - tInspect;
const tLook = Date.now();
const look = await tool('computer_screenshot').execute({ purpose: 'look' }, exec);
const lookMs = Date.now() - tLook;
check('A11 purpose:"look" skips enumeration and returns a smaller JPEG',
  look.elements_skipped === true && /\.jpe?g$/i.test(look.path) && look.scale <= 0.35 && look.width * look.height < 400000
    && insp.elements_skipped !== true,
  `look: ${look.width}x${look.height} scale=${look.scale} elements=${look.element_count}; inspect: ${insp.width}x${insp.height} elements=${insp.element_count}`);
check('A12 purpose:"look" is actually faster than the default inspect capture',
  lookMs < inspectMs,
  `inspect ${inspectMs} ms vs look ${lookMs} ms`);

// ── B. real clicks (opt in) ─────────────────────────────────────────────────
if (!WITH_CLICK) {
  console.log('\n(--click not given: skipping the live click checks)');
} else {
  const before = new Set(((await tool('computer_list_windows').execute({}, exec)).windows ?? []).map((w) => w.hwnd));
  const child = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  child.unref();

  let target = null;
  for (let i = 0; i < 20 && !target; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    const wins = ((await tool('computer_list_windows').execute({}, exec)).windows ?? []);
    target = wins.find((w) => !before.has(w.hwnd) && w.width > 200 && w.height > 100) ?? null;
  }
  if (!target) {
    skip('B1 click by ref lands exactly on the control', 'Notepad did not open a window in time');
  } else {
    // Bring it up, then PROVE it is the window the screenshot will enumerate.
    // Without this assertion the checks silently ran against whatever window
    // happened to be in front, which is how this test lied to me once already.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await tool('computer_activate_window').execute({ hwnd: target.hwnd }, exec);
    await sleep(400);
    let pane = await tool('computer_screenshot').execute({ annotate: false }, exec);
    if (pane.foreground?.hwnd !== target.hwnd) {
      await tool('computer_activate_window').execute({ hwnd: target.hwnd }, exec);
      await sleep(500);
      pane = await tool('computer_screenshot').execute({ annotate: false }, exec);
    }
    const front = pane.foreground ?? {};
    if (front.hwnd !== target.hwnd) {
      skip('B1 click by ref lands exactly on the control',
        `could not bring hwnd ${target.hwnd} "${target.title}" to the front (front is "${front.title}")`);
    } else {
      console.log(`\n  window under test: "${front.title}" hwnd=${front.hwnd}`);
      // `ref` needs only a rectangle, so any enabled control will do. `name` is
      // opportunistic: several real applications (the Windows 11 Notepad is one)
      // expose their controls as unnamed Panes, and then only ref works.
      const enabled = (pane.elements ?? []).filter((el) => el.enabled !== false && Array.isArray(el.rect));
      const named = enabled.filter((el) => (el.name ?? '').trim() !== '');
      const nameCount = new Map();
      for (const el of named) nameCount.set(el.name, (nameCount.get(el.name) ?? 0) + 1);
      const chosen = named.find((el) => nameCount.get(el.name) === 1) ?? enabled[0];
      console.log(`  ${enabled.length} enabled control(s), ${named.length} of them named`);
      if (!chosen) {
        skip('B1 click by ref lands exactly on the control', 'the window exposed no clickable control');
      } else {
        console.log(`  target: ref=${chosen.ref} name="${chosen.name ?? ''}" type=${chosen.type} centre=${chosen.cx},${chosen.cy}`);
        const byRef = await tool('computer_click').execute({ ref: chosen.ref }, exec);
        check('B1 click by ref lands exactly on the control centre',
          byRef.clicked === `[${chosen.cx},${chosen.cy}]`,
          `clicked ${byRef.clicked}, control centre [${chosen.cx},${chosen.cy}], method=${byRef.method}`);
        check('B2 the tool confirms the hit', byRef.hit_confirmed === true,
          `under_cursor=${byRef.under_cursor}`);

        // The pointer really was placed where the click claims. A click that could
        // not be aimed used to be sent anyway -- onto whatever was under the
        // pointer -- so the reported point and the actual one have to be checked
        // against each other, not just against the target rectangle.
        const cursor = await tool('computer_get_cursor_position').execute({}, exec);
        check('B2b the pointer is really where the click says it clicked',
          `[${cursor.x},${cursor.y}]` === byRef.clicked,
          `cursor [${cursor.x},${cursor.y}] vs clicked ${byRef.clicked}`);

        // The press must actually last. Sending the press and the release in one
        // SendInput batch made it instantaneous, which silently breaks every
        // long-press / press-and-hold target -- measured on a 4399 Gomoku game
        // where neither a click nor a drag moved a single stone until the hold
        // was restored. Wall-clock is the only honest way to check it.
        const t0 = Date.now();
        const held = await tool('computer_click').execute({ ref: chosen.ref, press_ms: 600 }, exec);
        const heldMs = Date.now() - t0;
        check('B2c press_ms is honoured (the button really stays down)',
          Number(held.press_ms) === 600 && heldMs >= 600,
          `press_ms=${held.press_ms}, wall ${heldMs} ms for a 600 ms press`);

        const uniqueName = (chosen.name ?? '').trim() !== '' && nameCount.get(chosen.name) === 1;
        if (!uniqueName) {
          skip('B3 click by accessible name', 'this window exposes its controls unnamed, so only ref targeting applies here');
        } else {
          const byName = await tool('computer_click').execute({ name: chosen.name }, exec);
          check('B3 click by accessible name lands on the same control',
            byName.clicked === `[${chosen.cx},${chosen.cy}]` && byName.hit_confirmed === true,
            `clicked ${byName.clicked}, method=${byName.method}`);
        }
      }
    }
    // Leave the keyboard in a neutral place, then close the editor we opened.
    try {
      await tool('computer_keypress').execute({ keys: ['esc'] }, exec);
      await tool('computer_activate_window').execute({ hwnd: target.hwnd }, exec);
      await tool('computer_keypress').execute({ keys: ['alt', 'f4'] }, exec);
    } catch { /* best effort */ }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
