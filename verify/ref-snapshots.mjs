/**
 * Snapshot-scoped element refs.
 *
 * A ref name is only meaningful together with the enumeration that produced it,
 * and the same name can come to mean a DIFFERENT control once a window re-renders.
 * Every enumeration now gets an id, and refs are scoped to it. Against the live
 * desktop this proves:
 *
 *   A. enumerations hand back a snapshot id, and ids advance
 *   B. a ref that names the SAME control in two snapshots still resolves bare
 *   C. a pinned ref resolves, and a pin to an evicted snapshot is refused as stale
 *      rather than silently re-pointed
 *   D. when two live snapshots disagree about what a name means, a bare ref follows
 *      the NEWEST — the list the caller just read — and the result SAYS that an
 *      older snapshot disagreed, instead of quietly picking one
 *   E. pinning an older snapshot resolves to that enumeration, not the newest
 *   F. `purpose: "look"` enumerates nothing, so it must not shadow held refs
 *
 * D is deliberately a report and not a refusal. The first implementation refused,
 * and `verify/element-refs.mjs --click` broke immediately: it enumerates the
 * focused window, launches its own Notepad, enumerates that, then clicks `e1` —
 * unambiguously meaning the Notepad it just enumerated — and the refusal rejected
 * a correct call. Refusing is reserved for what genuinely cannot be honoured: an
 * unknown ref, or a pin to an evicted snapshot.
 *
 * Usage: node verify/ref-snapshots.mjs
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
  return (name) => new Map(list.map((t) => [t.name, t])).get(name);
}
const tool = makeTools();
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
const call = async (name, args) => {
  try {
    return await tool(name).execute(args ?? {}, exec);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
};
/** The aiming contract: where the pointer was actually put. */
const landed = (res) => String(res?.pointer_landed ?? '').replace(/[[\]]/g, '').split(',').map(Number);
const landedOn = (res, el) => {
  const l = landed(res);
  return l.length === 2 && l[0] === el.cx && l[1] === el.cy;
};

async function waitForWindow(pred, tries = 25) {
  for (let i = 0; i < tries; i += 1) {
    const wins = (await call('computer_list_windows', { min_width: 120, min_height: 80 })).windows ?? [];
    const hit = wins.find(pred);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

// ── own a Notepad ──────────────────────────────────────────────────────────
const before = new Set(((await call('computer_list_windows', {})).windows ?? []).map((w) => w.hwnd));
const np = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
np.unref();
const npWin = await waitForWindow((w) => !before.has(w.hwnd) && /notepad|记事本/i.test(w.class + w.title));
if (!npWin) {
  check('a Notepad is available for the test', false, 'not found');
  console.log('\n==== 0/1 passed ====');
  process.exit(1);
}
await call('computer_activate_window', { hwnd: npWin.hwnd });
await sleep(600);

// ── A. enumerations are snapshotted ────────────────────────────────────────
console.log('\n── A. enumerations carry a snapshot id ──');
const shot1 = await call('computer_screenshot', { annotate: false });
const els1 = shot1.elements ?? [];
const snap1 = shot1.snapshot;
check('A1 computer_screenshot reports the snapshot its refs belong to', typeof snap1 === 'string' && /^s\d+$/.test(snap1),
  `snapshot ${snap1} with ${els1.length} ref(s)`);

const els2res = await call('computer_elements', { max: 60 });
const snap2 = els2res.snapshot;
check('A2 computer_elements reports its own, newer snapshot', typeof snap2 === 'string' && snap2 !== snap1,
  `${snap1} -> ${snap2}`);

// The model reads the RENDERED text, not the structured value, so an id that only
// exists in the object is an id the model can never pin. The first implementation
// had exactly that bug and it was caught by using the feature through the live
// session rather than through this script - so both layers are asserted now.
const rendered = (res, toolName) => (tool(toolName).output.render({}, res) ?? [])
  .filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const elementsText = rendered(els2res, 'computer_elements');
check('A3 the RENDERED elements text carries the snapshot id',
  elementsText.includes(snap2),
  elementsText.split('\n').find((l) => l.startsWith('snapshot:')) ?? '(no snapshot line in the rendered text)');
const shotText = rendered(shot1, 'computer_screenshot');
check('A4 the RENDERED screenshot envelope carries the snapshot id',
  shotText.includes(snap1),
  shotText.split('\n').find((l) => l.startsWith('snapshot:')) ?? '(no snapshot line in the rendered text)');

// The widest ref is Notepad's text area: clicking into it is harmless.
const edit1 = els1.filter((e) => e.rect && e.rect[2] - e.rect[0] > 300)
  .sort((a, b) => (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]))[0];
const edit2 = (els2res.elements ?? []).find((e) => e.ref === edit1?.ref);
check('A3 the same control is addressable from both snapshots', !!edit1 && !!edit2 && edit2.cx === edit1.cx,
  edit1 ? `ref ${edit1.ref} at ${edit1.cx},${edit1.cy}` : 'no edit-sized ref');

// ── B. a bare ref that means the same thing still resolves ──────────────────
console.log('\n── B. an un-pinned ref that names the same control still works ──');
const bare = await call('computer_click', { ref: edit1.ref });
check('B1 a bare ref resolves when every live snapshot agrees on what it names', landedOn(bare, edit1),
  `ref ${edit1.ref} -> pointer ${bare.pointer_landed ?? JSON.stringify(bare).slice(0, 80)}`);

// ── C. pinning ─────────────────────────────────────────────────────────────
console.log('\n── C. pinning a snapshot ──');
const pinned = await call('computer_click', { ref: edit1.ref, snapshot: snap2 });
check('C1 a ref pinned to its own snapshot resolves', landedOn(pinned, edit1),
  `snapshot ${snap2} ref ${edit1.ref} -> pointer ${pinned.pointer_landed ?? JSON.stringify(pinned).slice(0, 80)}`);

const stale = await call('computer_click', { ref: edit1.ref, snapshot: 's999999' });
const staleText = JSON.stringify(stale);
check('C2 a pin to an evicted snapshot is refused as stale, not silently re-pointed',
  /已过期|stale|evict/i.test(staleText), staleText.slice(0, 150));

const unknown = await call('computer_click', { ref: 'e99999' });
check('C3 an unknown ref is still refused with the live inventory',
  /不认识|unknown|stale|截图/i.test(JSON.stringify(unknown)), JSON.stringify(unknown).slice(0, 130));

// ── D/E. the same ref name meaning two different controls ───────────────────
console.log('\n── D/E. the same ref name meaning two different controls ──');
const calc = spawn('calc.exe', [], { detached: true, stdio: 'ignore' });
calc.unref();
const calcWin = await waitForWindow((w) => /计算器|Calculator/i.test(w.title));
let snapCalc = null;
if (calcWin) {
  const now = (await call('computer_list_windows', {})).windows ?? [];
  const target = now.filter((w) => /计算器|Calculator/i.test(w.title))
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (target) await call('computer_activate_window', { hwnd: target.hwnd });
  await sleep(700);
  const calcEls = await call('computer_elements', { max: 80 });
  snapCalc = calcEls.snapshot;
  const calcRef1 = (calcEls.elements ?? [])[0];
  note(`Calculator snapshot ${snapCalc}, first ref ${calcRef1?.ref} = ${JSON.stringify((calcRef1?.name ?? '').slice(0, 24))}`);
}

if (snapCalc && snapCalc !== snap2) {
  // Back to Notepad and enumerate again: the newest snapshot now contains the ref
  // and means the text area, while the Calculator snapshot disagrees about it. The
  // bare ref must follow the NEWEST - the list the caller just read - and SAY that
  // an older one disagreed. Refusing instead was the first implementation, and it
  // broke a legitimate call (verify/element-refs.mjs --click) the first time it ran.
  await call('computer_activate_window', { hwnd: npWin.hwnd });
  await sleep(500);
  const again = await call('computer_elements', { max: 60 });
  const snapNewest = again.snapshot;
  const editNewest = (again.elements ?? []).find((e) => e.ref === edit1.ref) ?? edit1;

  const contested = await call('computer_click', { ref: edit1.ref });
  check('D1 a bare ref follows the newest enumeration that contains it',
    landedOn(contested, editNewest) && contested.ref_snapshot === snapNewest,
    `resolved from ${contested.ref_snapshot} -> pointer ${contested.pointer_landed ?? JSON.stringify(contested).slice(0, 80)}`);
  check('D2 the result names the older snapshot that disagreed, instead of hiding it',
    typeof contested.ref_ambiguous === 'string' && contested.ref_ambiguous.includes(snapCalc),
    String(contested.ref_ambiguous ?? '(no ref_ambiguous)').slice(0, 170));

  const pinnedOld = await call('computer_click', { ref: edit1.ref, snapshot: snap2 });
  check('E1 pinning an OLDER snapshot resolves to that enumeration, not the newest',
    landedOn(pinnedOld, edit1) && pinnedOld.ref_snapshot === snap2,
    `snapshot ${snap2} -> pointer ${pinnedOld.pointer_landed ?? JSON.stringify(pinnedOld).slice(0, 80)}`);
} else {
  check('D1 a bare ref follows the newest enumeration that contains it', false, 'could not build two live snapshots');
  check('D2 the result names the older snapshot that disagreed, instead of hiding it', false, 'could not build two live snapshots');
  check('E1 pinning an OLDER snapshot resolves to that enumeration, not the newest', false, 'could not build two live snapshots');
}

// ── F. a "look" capture must not shadow anything ────────────────────────────
console.log('\n── F. purpose:"look" enumerates nothing, so it must not shadow refs ──');
await call('computer_activate_window', { hwnd: npWin.hwnd });
await sleep(400);
const look = await call('computer_screenshot', { purpose: 'look' });
check('F1 a look capture reports no snapshot', look.snapshot === undefined,
  `snapshot ${JSON.stringify(look.snapshot)} elements ${look.element_count}`);
const afterLook = await call('computer_click', { ref: edit1.ref, snapshot: snap2 });
check('F2 refs pinned before the look capture are still live and still resolve', landedOn(afterLook, edit1),
  `snapshot ${snap2} -> pointer ${afterLook.pointer_landed ?? JSON.stringify(afterLook).slice(0, 80)}`);

// ── cleanup ────────────────────────────────────────────────────────────────
for (const w of (await call('computer_list_windows', {})).windows ?? []) {
  if (/notepad|记事本/i.test(w.class + w.title)) spawnSync('taskkill', ['/PID', String(w.pid), '/F'], { stdio: 'ignore' });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
