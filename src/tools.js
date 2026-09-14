import { join, resolve as pathResolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Build the computer_* tools. Coordinate system: pixels relative to the
 * multi-monitor VIRTUAL SCREEN ORIGIN (returned by computer_screenshot as
 * `virtual_offset`). All screen reading and input is delegated to one bundled
 * PowerShell executor (act.ps1) with zero native dependencies: one process per
 * tool call, which also means the focus check, the resolution of an element ref,
 * the click and the follow-up probe cannot disagree about the desktop.
 *
 * Vision feedback: when the calling route declares `image` input, the screenshot
 * is committed through the host `attachments` service and rendered as a real
 * image block, so the model inspects the screen itself. Text-only routes keep
 * the original path-based contract (feed the PNG to an external image reader).
 *
 * @param {{runPs:(script:string,payload:object,opts?:object)=>Promise<object>, getConfig:()=>object, approvedSessions?:Set<string>, sessionId?:string, setMode?:(mode:string)=>Promise<void>, ctx?:object}} deps
 * @returns {Array<object>} tool definitions ready for ctx.tools.register
 */

const COORD = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'number' },
  description: '相对多屏虚拟屏原点的像素坐标 [x, y]（原点是 computer_screenshot 返回的 virtual_offset）',
};

/**
 * One compact line, repeated in every tool description. The previous version
 * pasted a five-sentence paragraph into eight different tool schemas, so its cost
 * was paid on every turn for guidance the caller only needs once.
 */
const HEAD =
  '定位优先用元素引用：computer_click 接受 ref（如 "e12"）或 name（控件可见文字），两者都不需要坐标换算；' +
  '只有在元素列表里找不到目标时才退回 coordinate。单击后台窗口的第一下会被系统吃掉（只用于激活），需要时先用 computer_activate_window 聚焦。';

/**
 * Element references are SNAPSHOT-scoped.
 *
 * A ref such as `e12` only means anything together with the enumeration that
 * produced it, and the caller may click it several steps later. Two failures are
 * possible, and only one of them used to be caught:
 *
 *   - the ref is gone entirely              -> already refused ("不认识");
 *   - the SAME ref name now names a DIFFERENT control, because the window
 *     re-rendered between the screenshot the caller read and the click. The old
 *     lookup walked generations newest-first and returned the first hit, so this
 *     silently clicked the wrong control - the worst possible outcome, because the
 *     tool still reported success.
 *
 * Every enumeration therefore gets an id (`s7`), refs are stored per snapshot, and
 * a bare ref that resolves to two different controls across live snapshots is
 * REFUSED rather than guessed. Pinning the id (`snapshot: "s7"`) makes the intent
 * explicit, and a pinned snapshot that has been evicted is refused as stale.
 *
 * Two different refs are the "same control" when their identity matches, and the
 * identity deliberately excludes the rectangle: act.ps1 re-resolves the live
 * element by automation id / name / type at click time, so a control that merely
 * moved (or a window that was dragged) is still the right control. Only a control
 * that is genuinely a different one is treated as a conflict.
 *
 * Retention is small on purpose: `screenshot -> computer_elements -> click` has to
 * keep working, and nothing older than that is worth trusting.
 */
const REF_SNAPSHOTS = 3;
const refSnapshots = [];
let refSnapshotSeq = 0;

/** A control's identity, independent of where it currently sits on screen. */
function refIdentity(el) {
  const id = String(el.automationId ?? '').trim();
  if (id) return `id:${id}`;
  return `nm:${el.type ?? ''}|${el.name ?? ''}`;
}

/** A short human label for a control, for refusal messages. */
function refLabel(el) {
  const id = String(el.automationId ?? '').trim();
  if (el.name) return `"${el.name}"`;
  if (id) return id;
  return el.type || 'unnamed';
}

/**
 * Remember one enumeration so its refs can be clicked later.
 * Returns the snapshot id and how many refs it holds, or null when there is
 * nothing addressable (a `purpose: "look"` capture enumerates nothing, and must
 * not create a snapshot that would shadow the refs the caller already has).
 */
function rememberElements(hwnd, title, elements) {
  const map = new Map();
  for (const el of elements ?? []) {
    if (!el || el.ref === undefined || el.ref === null) continue;
    const key = String(el.ref).replace(/^@/, '');
    if (!key) continue;
    map.set(key, {
      ref: key,
      name: typeof el.name === 'string' ? el.name : '',
      nameTruncated: el.name_truncated === true,
      type: typeof el.type === 'string' ? el.type : '',
      automationId: typeof el.automationId === 'string' ? el.automationId : '',
      rect: Array.isArray(el.rect) ? el.rect : null,
      hwnd: Number(hwnd) || 0,
      windowTitle: typeof title === 'string' ? title : '',
    });
  }
  if (map.size === 0) return null;
  refSnapshotSeq += 1;
  const snapshot = `s${refSnapshotSeq}`;
  refSnapshots.unshift({ snapshot, at: Date.now(), hwnd: Number(hwnd) || 0, title: title ?? '', map });
  while (refSnapshots.length > REF_SNAPSHOTS) refSnapshots.pop();
  return { snapshot, count: map.size };
}

/** The ids of the snapshots still addressable, newest first. */
function liveSnapshots() {
  return refSnapshots.map((s) => s.snapshot);
}

/**
 * Resolve a ref, optionally pinned to one snapshot.
 *
 * A PINNED ref is strict: it only ever resolves inside the snapshot named, and a
 * snapshot that has been evicted is refused as stale rather than re-pointed. That
 * is the element-token property - explicit, checkable, no silent drift.
 *
 * A BARE ref is convenience, and it resolves against the NEWEST live snapshot that
 * contains it, because that is the list the caller just looked at.
 *
 * The first version of this REFUSED a bare ref whenever two live snapshots
 * disagreed about what it named. That was measured wrong on its first integration
 * run: `verify/element-refs.mjs --click` enumerates the focused window, then
 * launches its own Notepad and enumerates that, then clicks `e1` - unambiguously
 * meaning the Notepad it just enumerated - and the refusal broke a correct call.
 * So a contest is now REPORTED (`contested`) instead of refused: the caller learns
 * which snapshot was used and that an older one disagreed, instead of silently
 * getting one of them. Refusing is reserved for the cases where the caller's intent
 * really cannot be honoured: an unknown ref, or a pin to an evicted snapshot.
 *
 * Returns `{ status }` of 'ok' | 'unknown' | 'stale-snapshot'.
 */
function resolveRef(ref, snapshotId) {
  const key = String(ref ?? '').trim().replace(/^@/, '');
  if (!key) return { status: 'unknown' };

  if (snapshotId !== undefined && snapshotId !== null && String(snapshotId).trim() !== '') {
    const want = String(snapshotId).trim().replace(/^@/, '');
    const snap = refSnapshots.find((s) => s.snapshot === want);
    if (!snap) return { status: 'stale-snapshot', snapshot: want, live: liveSnapshots() };
    const hit = snap.map.get(key);
    if (!hit) return { status: 'unknown', snapshot: want };
    return { status: 'ok', hit, snapshot: want };
  }

  const found = [];
  for (const snap of refSnapshots) {
    const hit = snap.map.get(key);
    if (hit) found.push({ snap, hit });
  }
  if (found.length === 0) return { status: 'unknown' };
  const chosen = found[0];
  const contested = found.slice(1)
    .filter((f) => refIdentity(f.hit) !== refIdentity(chosen.hit))
    .map((f) => ({ snapshot: f.snap.snapshot, hit: f.hit }));
  return { status: 'ok', hit: chosen.hit, snapshot: chosen.snap.snapshot, contested };
}

/** The head of the current addressable list, for "no such ref" messages. */
function refInventory(limit = 12) {
  const out = [];
  for (const [, el] of (refSnapshots[0]?.map ?? new Map())) {
    out.push(`${el.ref}${el.name ? ` "${el.name}"` : ''}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** Turn a failed resolveRef into an actionable refusal, naming the snapshots. */
function refRefusal(tool, ref, r) {
  const live = liveSnapshots();
  if (r.status === 'stale-snapshot') {
    return `${tool}: 快照 ${r.snapshot} 已过期（只保留最近 ${REF_SNAPSHOTS} 次枚举：${r.live.join(', ') || '（无）'}）。` +
      `引用只在产生它的那次枚举内有效，请重新 computer_screenshot / computer_elements 后再操作。`;
  }
  return `${tool}: 引用 ${ref} 不认识（可能来自更早的截图）。` +
    `请先重新 computer_screenshot，或改用 name/coordinate。当前快照 ${live[0] ?? '（无）'} 可用：${refInventory().join(', ') || '（空）'}`;
}

/**
 * A one-line note when an older live snapshot disagreed about a bare ref.
 *
 * The tool still does what the caller meant - it used the newest enumeration - but
 * it says so, because "the same name meant something else a moment ago" is exactly
 * the situation where a silent click goes wrong without anyone noticing.
 */
function refContestNote(ref, r) {
  if (!r?.contested?.length) return null;
  const parts = r.contested.map((c) => `${c.snapshot} -> ${refLabel(c.hit)}`);
  return `引用 ${ref} 在更早的快照里指向不同控件（${parts.join(' ; ')}）；本次按最新快照 ${r.snapshot} 解析。`
    + '若你本意是更早那次，请带上 snapshot 明确指定。';
}

/**
 * Render an element list as ONE dense line instead of a JSON blob. A screenshot of
 * a busy window can carry 60+ elements; as pretty JSON that is thousands of
 * tokens, as a single line it is a few hundred.
 */
function elementLine(elements, limit = 45) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const parts = [];
  for (const el of elements.slice(0, limit)) {
    const bits = [String(el.ref)];
    if (el.type) bits.push(el.type);
    if (el.name) bits.push(`"${el.name}"`);
    if (el.name_truncated === true) bits.push('(name truncated)');
    if (Array.isArray(el.patterns) && el.patterns.length > 0) bits.push(`{${el.patterns.join(',')}}`);
    if (el.enabled === false) bits.push('(disabled)');
    parts.push(bits.join(' '));
  }
  const tail = elements.length > limit ? ` … +${elements.length - limit} more` : '';
  return `elements (${elements.length}): ${parts.join(' | ')}${tail}`;
}

/**
 * DeepSeek's normal vision projection budget (640k pixels). A picture larger
 * than the route's budget is silently downscaled by the host before the model
 * sees it, which would invalidate the image→screen coordinate mapping, so
 * vision mode keeps the capture inside this budget by default.
 */
const DEFAULT_VISION_MAX_PIXELS = 640000;

/** Screenshot image metadata handed to the host attachment block. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: true },
  },
};

/** Tools that are always safe (no side effects on the user's desktop). */
const READONLY_TOOLS = new Set([
  'computer_screenshot',
  'computer_elements',
  'computer_get_cursor_position',
  'computer_wait',
  'computer_list_windows',
]);

const MODES = ['disabled', 'readonly', 'manual', 'auto'];

/**
 * Mode gate: decide whether a tool call is allowed based on the current mode
 * and the session's approval state.
 *
 * Returns void if allowed, or throws with `awaitingApproval=true` if
 * the user needs to approve via /computer first.
 */
function modeGate(cfg, toolName, approvedSessions, sessionId, controlState) {
  // A user stop outranks every mode: the overlay's Stop button and its global
  // hotkey both land here, and nothing runs again until the user re-approves -
  // which a new user message, /computer, and the chat switch each do. The message
  // deliberately carries INTENT, not just a refusal: "blocked" alone invites the
  // model to hunt for a workaround instead of handing control back, which is the
  // opposite of what the user asked for by pressing stop.
  const stopped = controlState?.stopLabel?.();
  if (stopped) {
    throw new Error(
      `用户已在电脑操控过程中停止（${stopped}）。\n` +
        '这通常意味着下面某一种情况（不要猜测是哪一种，用一句话向用户确认即可）：\n' +
        '  · 用户认为本轮操作有风险，或对正在发生的事不放心；\n' +
        '  · 用户本次不希望由 AI 操控电脑，想自己接手；\n' +
        '  · 用户想换一种方式完成（例如改用命令行 / API / 文件操作，而不是 GUI 操控）。\n' +
        '本轮必须遵守：\n' +
        '  1. 立即停止一切电脑操控，不要重试、不要换工具绕开、不要试图重新拉起控制界面；\n' +
        '  2. 用一两句话说明你已经做了什么、停在哪一步，以及是否存在未完成或可能已产生\n' +
        '     影响的操作需要用户确认；\n' +
        '  3. 然后就「希望如何继续」提问并等待回复（自己接手 / 换方式 / 继续 / 结束）。\n' +
        '恢复方式：用户只要再发一条消息就会自动解除停止；/computer 和对话框左侧的开关同样有效。\n' +
        '所以不要要求用户去点开关或敲命令——把情况说清楚、问清楚就够了。'
    );
  }
  const mode = cfg.mode ?? 'manual';
  if (mode === 'disabled') {
    throw new Error('computer-user 已禁用：请在「设置 → 电脑操作」切换模式后再使用');
  }
  if (mode === 'readonly' && !READONLY_TOOLS.has(toolName)) {
    throw new Error(`computer-user 只读模式：${toolName} 不允许执行，仅截图/读光标/等待可用`);
  }
  if (mode === 'manual' && !READONLY_TOOLS.has(toolName)) {
    // The approval store is the source of truth because it also knows about the
    // persistent profile-wide scope; the in-memory set remains as a fallback for
    // hosts that never wired the store up.
    const approved = typeof controlState?.isApproved === 'function'
      ? controlState.isApproved(sessionId)
      : !!(sessionId && approvedSessions && approvedSessions.has(sessionId));
    if (!approved) {
      const e = new Error(
        '需要批准：当前为手动批准模式。请在对话框输入 /computer 批准后重试（批准后本轮及后续轮次均可使用）。'
      );
      e.awaitingApproval = true;
      throw e;
    }
  }
  // mode === 'auto' or readonly tool or approved manual → allow
}

/**
 * Validate a mode value against the allowed enum.
 * @returns the validated mode string.
 */
function validateMode(value) {
  if (typeof value !== 'string' || !MODES.includes(value)) {
    throw new Error(`computer_set_mode: mode 必须是 ${MODES.join('/')} 之一`);
  }
  return value;
}

function textOut(schema, prefixLines) {
  const props = schema.properties ?? {};
  const required = (schema.required ?? []).filter((k) => k in props);
  return {
    schema: { type: 'object', additionalProperties: true, properties: props, required },
    render: (_args, value) => {
      const head = prefixLines === undefined ? [] : (typeof prefixLines === 'function' ? prefixLines(value) : prefixLines);
      const lines = [...head];
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (k === 'ok') continue;
          if (v === undefined || v === null) continue;
          lines.push(`${k}: ${JSON.stringify(v)}`);
        }
      }
      return [{ type: 'text', text: lines.join('\n') }];
    },
  };
}

/**
 * Resolve whether the route that called this tool declares `image` input.
 * Mirrors the host `read_image` gate: request-header config first, then the
 * agent's own options; unknown or unresolvable routes count as text-only.
 * @returns {Promise<boolean>}
 */
async function routeAcceptsImages(ctx, exec) {
  try {
    const llm = ctx?.get?.('llm');
    if (!llm || typeof llm.resolveModelInfo !== 'function') return false;
    const routed = exec?.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec?.agent?.options?.provider;
    const model = routed?.model ?? exec?.agent?.options?.model;
    if (provider === undefined || model === undefined) return false;
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image');
  } catch {
    return false;
  }
}

/**
 * Model-facing envelope for a screenshot. In vision mode it carries the exact
 * image-pixel → virtual-screen-pixel mapping, because the host tells the model
 * the preview size but never how to convert coordinates back to the desktop.
 * @param {object} value - the screenshot tool result.
 * @returns {string} the text block that precedes the optional image block.
 */
function screenshotEnvelope(value) {
  const v = value ?? {};
  const offset = Array.isArray(v.virtual_offset) ? v.virtual_offset : [0, 0];
  const vx = offset[0] ?? 0;
  const vy = offset[1] ?? 0;
  const lines = [];

  if (v.image) {
    const factor = Array.isArray(v.screen_per_pixel) ? v.screen_per_pixel : [1, 1];
    const kx = factor[0] ?? 1;
    const ky = factor[1] ?? 1;
    lines.push('screenshot attached as an image below — inspect it directly (no external image reader needed).');
    lines.push(`path: ${v.path}`);
    lines.push(`image_size: ${v.image.width}x${v.image.height} px (the image you are looking at)`);
    lines.push(`screen_mapping: screen_x = ${vx} + image_x * ${kx} ; screen_y = ${vy} + image_y * ${ky}`);
    lines.push(`virtual_offset: [${vx}, ${vy}]`);
    lines.push(`capture_scale: ${v.scale}`);
  } else {
    lines.push('screenshot saved to a PNG file (this model does not declare image input, so the picture cannot be attached). An external image reader can open it, but the element list below usually removes the need.');
    lines.push(`path: ${v.path}`);
    lines.push(`width: ${v.width}`);
    lines.push(`height: ${v.height}`);
    lines.push(`virtual_offset: [${vx}, ${vy}]`);
    lines.push(`scale: ${v.scale}`);
    const spi = Array.isArray(v.screen_per_image) ? v.screen_per_image : [1, 1];
    lines.push(`screen_per_image: [${spi.join(', ')}]  (screen = virtual_offset + image_px * this)`);
  }

  const win = v.foreground;
  if (win && win.title) {
    const rect = Array.isArray(win.rect) ? win.rect : [];
    lines.push(`foreground_window: "${win.title}" hwnd=${win.hwnd} rect=[${rect.join(',')}]`);
  }

  const list = elementLine(v.elements);
  if (list) {
    lines.push(list);
    lines.push('Address any of these by ref — computer_click {ref: "e12"} — or by visible text, computer_click {name: "<text>"}. That needs no pixel arithmetic and survives the window moving. Use screen_mapping only for something that is not in the list.');
  } else if (v.elements_skipped) {
    // Distinguished from "found nothing": the caller asked for no enumeration, so
    // saying the window has no controls would be wrong and misleading.
    lines.push(v.purpose === 'look'
      ? 'purpose:"look" — this capture skipped the element enumeration on purpose (cheapest path to just see the screen). Take another one without purpose, or call computer_elements, when you need refs to click.'
      : 'element enumeration was skipped for this capture (max_elements: 0), so no refs are listed; call computer_elements when you need them.');
  } else {
    lines.push('no actionable elements were found in the focused window: fall back to screen_mapping, or focus the right window first (computer_list_windows / computer_activate_window).');
  }
  if (v.annotated) {
    const labeled = v.labeled ?? 0;
    const total = v.element_count ?? 0;
    const medH = Number(v.median_element_h) || 0;
    const pt = Number(v.label_font_pt) || 0;
    if (labeled >= total) {
      lines.push(`annotation: all ${total} elements are labelled on the image.`);
    } else {
      lines.push(`annotation: ${labeled} of ${total} elements carry a readable ref label; the rest are`
        + ' outline-only because their labels collided.'
        + (medH > 0 ? ` The median control is ${medH} px tall in this image and a readable chip needs about ${Math.max(12, 2 * pt)} px.` : '')
        + ' A dense list of short controls cannot be fully labelled at this capture scale — capture a region with scale:1 for more pixels, or just use the list above.');
    }
  }
  return lines.join('\n');
}

export function createComputerTools({ runPs, getConfig, approvedSessions, sessionId, setMode, ctx, controlState }) {
  if (typeof runPs !== 'function') throw new Error('computer-user: runPs is required');
  if (typeof getConfig !== 'function') throw new Error('computer-user: getConfig is required');

  const gate = (toolName) => modeGate(getConfig(), toolName, approvedSessions, sessionId, controlState);

  /**
   * The focused-window summary, trimmed to what matters for verification.
   *
   * Assign only PRESENT fields: a property whose value is `undefined` is not
   * lossless JSON, and the harness discards the entire tool result over one.
   */
  function describeWindow(window) {
    if (!window) return null;
    const out = {};
    if (window.title !== undefined) out.title = window.title;
    if (window.pid !== undefined) out.pid = window.pid;
    if (window.hwnd !== undefined) out.hwnd = window.hwnd;
    if (Array.isArray(window.rect)) out.rect = window.rect;
    return Object.keys(out).length > 0 ? out : null;
  }

  /** Shared `expect_window` parameter: an opt-in pre-flight focus assertion. */
  const EXPECT_WINDOW = {
    type: 'string',
    description: 'Safety check: act only when the foreground window title contains this text '
      + '(case-insensitive). On a mismatch the tool refuses WITHOUT sending any input, so a window '
      + 'that stole focus cannot silently receive the keystrokes.',
  };

  // -- computer_screenshot ---------------------------------------------------
  const computerScreenshot = {
    name: 'computer_screenshot',
    description: [
      'Capture the whole virtual screen (all monitors), list the actionable controls of the focused window as clickable refs, and return the picture so you can see the desktop (the look step of computer use).',
      'Act on the returned refs rather than on estimated pixels: computer_click {ref:"e12"} or {name:"<visible text>"}. A downscaled preview is roughly 1.8 screen pixels per image pixel, which is precisely how a click misses a small control.',
      'When the current model accepts image input the screenshot is attached to this result as an actual image — look at it directly; otherwise only a PNG path is returned and the element list is how you locate things.',
      `${HEAD}`,
      'Parameters: purpose ("inspect" [default] or "look"), path (optional output file), region (optional [x0,y0,x1,y1] fractions in 0..1 to capture a sub-area), scale (optional 0.1..1 downscale), grid (optional labelled coordinate-grid spacing in screen px), annotate (default false — draw a ref label on each control; helpful on a sparse window, cluttered on a dense one), include_static (also list plain Text/Image elements), max_elements (cap on refs, default 60).',
      'purpose:"look" is the cheap way to just see the screen: it skips the element enumeration (which doubles the capture cost), writes a JPEG, and downsizes to 0.35 — the frame the vision model has to encode drops from ~135 KB to ~23 KB. Use it when nothing is going to be clicked by ref; ask for the default "inspect" when you need refs.',
      'Returns { path, width, height, virtual_offset:[x,y], scale, screen_per_image:[kx,ky], elements?, image?, screen_per_pixel? }. screen_mapping converts an image pixel to the virtual-screen pixel the input tools take.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        purpose: { type: 'string', enum: ['inspect', 'look'], description: '"inspect" (default) returns the element refs so a click can be aimed; "look" is cheaper — no enumeration, JPEG, scale 0.35 — for when you only need to see the screen.' },
        path: { type: 'string', description: 'Optional absolute or cwd-relative output path for the PNG. When empty a unique file is created under the configured screenshot_dir (default: OS temp).' },
        region: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] fractions (0..1) to capture only a sub-area of the virtual screen.' },
        scale: { type: 'number', description: 'Optional 0.1..1 downscale for the saved image (default: the configured default_scale, 1 = full resolution). In vision mode the result is additionally fitted into the model\'s pixel budget.' },
        grid: { type: 'number', description: 'Optional coordinate grid spacing in virtual-screen pixels (e.g. 100). Draws labelled lines so screen coordinates can be read straight off a downscaled image instead of estimated. 0 disables it.' },
        annotate: { type: 'boolean', description: 'Draw a ref label on each detected control. Off by default: on a dense window the labels collide and the element list is easier to use.' },
        include_static: { type: 'boolean', description: 'Also list non-interactive Text/Image elements as refs.' },
        max_elements: { type: 'number', description: 'Maximum number of element refs to collect (default 60, max 200). 0 skips the enumeration entirely.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          virtual_offset: { type: 'array', items: { type: 'number' } },
          scale: { type: 'number' },
          vision: { type: 'boolean' },
          screen_per_pixel: { type: 'array', items: { type: 'number' } },
          image: IMAGE_VALUE_SCHEMA,
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          element_count: { type: 'number' },
          labeled: { type: 'number' },
          annotated: { type: 'boolean' },
          foreground: { type: 'object', additionalProperties: true },
        },
        required: ['path', 'width', 'height', 'virtual_offset', 'scale'],
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: screenshotEnvelope(value) }];
        if (value && value.image) blocks.push({ type: 'image', attachment: value.image });
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_screenshot');
      if (exec?.signal?.aborted) throw new Error('computer_screenshot: cancelled');
      const cfg = getConfig() ?? {};

      // Decide the contract up front: whether the picture can ride the result.
      const attachments = ctx?.get?.('attachments');
      const attachAvailable = !!attachments && typeof attachments.saveImage === 'function';
      const visionConfigured = cfg.vision_feedback !== false && attachAvailable;
      const imageCapable = visionConfigured ? await routeAcceptsImages(ctx, exec) : false;
      const visionMode = visionConfigured && imageCapable;
      const budget = visionMode
        ? Math.max(10000, Number(cfg.vision_max_pixels) || DEFAULT_VISION_MAX_PIXELS)
        : 0;

      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
      const dir = cfg.screenshot_dir?.trim() ? pathResolve(cwd, cfg.screenshot_dir) : join(tmpdir(), 'computer-user');

      // purpose: "look" is the cheap path for "just show me the screen".
      //
      // Measured, on the PowerShell side: a 0.5-scale capture WITH the element
      // enumeration costs 1075 ms against 521 ms without it, and an element list is
      // dead weight when nothing is going to be clicked by ref. JPEG is 43 KB where
      // PNG is 135 KB for the same frame, and scale 0.35 takes it to 23 KB — which
      // is what the vision model actually has to encode. The four settings below are
      // the recipe; making the caller remember all four meant it usually got half of
      // them right.
      const purpose = typeof args?.purpose === 'string' ? args.purpose.trim().toLowerCase() : '';
      const lookMode = purpose === 'look';
      const LOOK_SCALE = 0.35;

      const outPath = args && args.path
        ? pathResolve(cwd, String(args.path))
        : join(dir, `shot-${Date.now()}-${randomBytes(4).toString('hex')}${lookMode ? '.jpg' : '.png'}`);
      const region = Array.isArray(args?.region) && args.region.length === 4 ? args.region : undefined;
      const requestedScale = typeof args?.scale === 'number'
        ? args.scale
        : (lookMode ? LOOK_SCALE : cfg.default_scale);
      const gridSpacing = typeof args?.grid === 'number'
        ? args.grid
        : (lookMode ? 0 : (Number(cfg.grid_spacing) || 0));
      const annotate = lookMode
        ? false
        : (args?.annotate === true || (args?.annotate === undefined && cfg.annotate_screenshots === true));
      // max_elements: 0 is a deliberate "do not enumerate" (saves the UI Automation
      // pass on a window with a huge tree). look mode implies it unless the caller
      // asks for refs explicitly.
      const rawMax = Number(args?.max_elements);
      const maxElements = Number.isFinite(rawMax) && rawMax <= 0
        ? 0
        : (Number.isFinite(rawMax) ? Math.max(1, Math.min(200, Math.trunc(rawMax))) : (lookMode ? 0 : 60));

      // One process does the whole thing: enumerate the controls, capture, draw.
      // Splitting capture from enumeration into two PowerShell starts cost an
      // extra ~380 ms and let the two disagree about the desktop.
      const capture = (scale) => runPs('act.ps1', {
        action: 'screenshot',
        outPath,
        region,
        scale,
        grid: gridSpacing,
        annotate,
        annotateMax: maxElements,
        include_static: args?.include_static === true,
      }, { signal: exec?.signal });

      let res;
      const paused = (await controlState?.pauseForCapture?.()) === true;
      try {
        res = await capture(requestedScale);

        // Fit into the model's vision budget by re-capturing smaller. Doing it
        // here (rather than letting the host downscale) keeps the preview
        // dimensions equal to the file dimensions, so screen_mapping stays exact.
        if (budget && res?.width > 0 && res?.height > 0 && res.width * res.height > budget) {
          const shrink = Math.sqrt(budget / (res.width * res.height));
          const current = Number(res.scale) > 0 ? Number(res.scale) : 1;
          const next = Math.max(0.1, Math.min(1, current * shrink * 0.98));
          if (next < current) res = await capture(next);
        }
      } finally {
        if (paused) controlState?.resumeAfterCapture?.();
      }

      const elements = Array.isArray(res.elements) ? res.elements : [];
      const foreground = res.window ?? null;
      const refSnapshot = rememberElements(foreground?.hwnd ?? 0, foreground?.title ?? '', elements);

      const base = {
        path: res.path,
        width: res.width,
        height: res.height,
        full_width: Number(res.full_width) || res.width,
        full_height: Number(res.full_height) || res.height,
        virtual_offset: res.virtual_offset,
        scale: res.scale,
        // Reported in BOTH modes: the text-only route still needs the exact factor
        // to turn whatever found the target into screen pixels. It used to be
        // derived from the requested scale, which is only approximately right.
        screen_per_image: Array.isArray(res.screen_per_image) ? res.screen_per_image : [1, 1],
        element_count: elements.length,
        // Which snapshot these refs belong to. Pass it back as `snapshot` to pin a
        // ref to this enumeration; a ref used without it is refused if it now names
        // a different control. Absent for a `purpose: "look"` capture, which
        // enumerates nothing and therefore must not shadow the refs already held.
        ...(refSnapshot ? { snapshot: refSnapshot.snapshot } : {}),
        elements_skipped: maxElements === 0,
        purpose: lookMode ? 'look' : 'inspect',
        labeled: Number(res.labeled) || 0,
        median_element_h: Number(res.median_element_h) || 0,
        label_font_pt: Number(res.label_font_pt) || 0,
        annotated: res.annotated === true,
        ...(foreground ? { foreground } : {}),
        ...(elements.length > 0 ? { elements } : {}),
      };

      if (!visionMode) return { ...base, vision: false };

      try {
        const data = await readFile(res.path);
        const lower = String(res.path).toLowerCase();
        const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
        const ref = await attachments.saveImage({ data, mediaType, name: basename(res.path) });

        // The host may normalize (downscale) on save; fold that together with the
        // capture's own crop/scale into one factor, so one image pixel always maps
        // to the right number of screen pixels.
        const shownW = Number(ref.width) > 0 ? Number(ref.width) : res.width;
        const shownH = Number(ref.height) > 0 ? Number(ref.height) : res.height;
        const spi = Array.isArray(res.screen_per_image) ? res.screen_per_image : [1, 1];
        const kx = Number((((Number(spi[0]) || 1) * res.width) / shownW).toFixed(4));
        const ky = Number((((Number(spi[1]) || 1) * res.height) / shownH).toFixed(4));

        return {
          ...base,
          vision: true,
          screen_per_pixel: [kx, ky],
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
            ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
          },
        };
      } catch (error) {
        // Never lose the screenshot: fall back to the path-based contract.
        ctx?.logger?.warn?.(`[computer-user] screenshot attach failed: ${String(error?.message ?? error)}`);
        return { ...base, vision: false };
      }
    },
  };

  // -- computer_elements -----------------------------------------------------
  // Enumerate the controls of a window WITHOUT taking a screenshot. This is the
  // cheap way to re-read a window after it changed, and the list it returns is
  // what computer_click refs are resolved against.
  const computerElements = {
    name: 'computer_elements',
    description: [
      'List the actionable controls of a window (focused window by default) as refs, without capturing a picture.',
      'Each entry carries a ref, the accessible name, the control type, the exact screen rectangle, and which action patterns it supports.',
      'Use it when the window changed and you need the refs refreshed: computer_click with a ref or a name needs no screenshot at all.',
      'Parameters: hwnd (default: focused window), max (default 60), include_static (also list plain Text/Image elements).',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        hwnd: { type: 'number', description: 'Window handle from computer_list_windows. Defaults to the focused window.' },
        max: { type: 'number', description: 'Maximum number of refs (default 60, max 200).' },
        include_static: { type: 'boolean', description: 'Also list non-interactive Text/Image elements.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          window: { type: 'object', additionalProperties: true },
          elements: { type: 'array', items: { type: 'object', additionalProperties: true } },
          scanned: { type: 'number' },
          ms: { type: 'number' },
          available: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['count'],
      },
      render: (_args, value) => {
        const lines = [];
        if (value?.available === false) {
          lines.push(`UI Automation is unavailable for this window: ${value.reason ?? 'unknown reason'}`);
        } else {
          const win = value?.window;
          if (win?.title) lines.push(`window: "${win.title}" hwnd=${win.hwnd} rect=[${(win.rect ?? []).join(',')}]`);
          lines.push(`scanned ${value?.scanned ?? 0} descendants in ${value?.ms ?? 0} ms`);
          lines.push(elementLine(value?.elements) ?? 'no actionable elements found');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_elements');
      const payload = { action: 'elements' };
      if (Number.isFinite(Number(args?.hwnd)) && Number(args.hwnd) !== 0) payload.hwnd = Math.trunc(Number(args.hwnd));
      payload.max = Number.isFinite(Number(args?.max)) ? Math.max(1, Math.min(200, Math.trunc(Number(args.max)))) : 60;
      payload.include_static = args?.include_static === true;
      const res = await runPs('act.ps1', payload, { signal: exec?.signal });
      const elements = Array.isArray(res.elements) ? res.elements : [];
      const refSnapshot = rememberElements(res.window?.hwnd ?? payload.hwnd ?? 0, res.window?.title ?? '', elements);
      return {
        count: elements.length,
        available: res.available !== false,
        ...(res.available === false ? { reason: res.reason } : {}),
        ...(refSnapshot ? { snapshot: refSnapshot.snapshot } : {}),
        ...(res.window ? { window: res.window } : {}),
        scanned: Number(res.scanned) || 0,
        ms: Number(res.ms) || 0,
        ...(elements.length > 0 ? { elements } : {}),
      };
    },
  };

  // -- computer_click --------------------------------------------------------
  // Click by ref, by accessible name, or by coordinate. The first two route
  // through UI Automation, which knows the control's exact rectangle, so nothing
  // is ever estimated from a downscaled picture.
  const computerClick = {
    name: 'computer_click',
    description: [
      'Click a control. Give ONE of: ref (an element ref such as "e12" from computer_screenshot / computer_elements), name (the control\'s visible text, matched exactly first then as a substring), or coordinate.',
      'ref and name are resolved against the live UI Automation tree at click time, so the click follows the control if the window moved since the screenshot. Prefer them over coordinate.',
      `${HEAD}`,
      'Parameters: ref, snapshot (optional: the enumeration id the ref came from — a bare ref follows the newest enumeration containing it and says so, a pinned one is strict), name, coordinate ([x,y] virtual-screen pixels), action (click [default] | right_click | double_click | middle_click), press_ms (how long the button stays down, default 50; raise it for a long press), expect_window (refuse unless the focused window title contains this), no_invoke (force a real mouse click instead of the control\'s UI Automation action).',
      'Returns the point actually clicked, how it was performed (invoke/toggle/select/expand = the control was activated directly, mouse = synthetic click at its centre), the target rectangle, what sits under the click afterwards, and whether the click only raised the window.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ref: { type: 'string', description: 'Element ref from computer_screenshot / computer_elements, e.g. "e12" or "@e12".' },
        snapshot: { type: 'string', description: 'Optional snapshot id (e.g. "s7") that the ref came from, as returned alongside the element list. A bare ref resolves against the NEWEST enumeration that contains it — the list you just looked at — and the result reports ref_snapshot plus ref_ambiguous if an older live snapshot disagreed about that name. Pin this to force one specific enumeration; a pin to an evicted snapshot is refused as stale instead of being silently re-pointed.' },
        name: { type: 'string', description: 'Accessible name / visible text of the control in the focused window.' },
        coordinate: { ...COORD, description: 'Fallback: [x, y] relative to virtual-screen origin. Prefer ref or name.' },
        action: { type: 'string', enum: ['click', 'right_click', 'double_click', 'middle_click'], description: 'Default click.' },
        press_ms: { type: 'number', description: 'How long the button is held down, in ms (default 50, max 10000). Raise it for press-and-hold or long-press interactions, which never fire if the press and the release are effectively simultaneous.' },
        expect_window: EXPECT_WINDOW,
        no_invoke: { type: 'boolean', description: 'Skip the UI Automation action and always send a synthetic mouse click.' },
      },
      required: [],
    },
    output: textOut({ required: ['clicked'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_click');
      const cfg = getConfig() ?? {};
      const payload = {
        action: 'click',
        button: args?.action ?? 'click',
        expectWindow: args?.expect_window,
        probe: cfg.verify_actions !== false,
      };
      if (args?.no_invoke === true) payload.no_invoke = true;
      // Passed through so long-press / press-and-hold targets can be driven; the
      // executor clamps it to 0..10000 and defaults to 50 ms.
      if (Number.isFinite(Number(args?.press_ms))) payload.pressMs = Math.trunc(Number(args.press_ms));

      const refArg = typeof args?.ref === 'string' ? args.ref.trim() : '';
      const nameArg = typeof args?.name === 'string' ? args.name.trim() : '';
      let refInfo = null;

      if (refArg) {
        const resolved = resolveRef(refArg, args?.snapshot);
        if (resolved.status !== 'ok') throw new Error(refRefusal('computer_click', refArg, resolved));
        const hit = resolved.hit;
        refInfo = { ref: refArg, snapshot: resolved.snapshot, contested: resolved.contested ?? null };
        payload.target = {
          hwnd: hit.hwnd,
          name: hit.name,
          type: hit.type,
          automationId: hit.automationId,
          rect: hit.rect,
          // A long accessible name is truncated for display; the executor has to
          // know so it can re-resolve the control by prefix instead of exact match.
          name_truncated: hit.nameTruncated === true,
        };
      } else if (nameArg) {
        payload.name = nameArg;
      } else if (Array.isArray(args?.coordinate) && args.coordinate.length === 2) {
        payload.coordinate = [Math.round(Number(args.coordinate[0])), Math.round(Number(args.coordinate[1]))];
      } else {
        throw new Error('computer_click: 需要 ref、name 或 coordinate 之一');
      }

      const res = await runPs('act.ps1', payload, { signal: exec?.signal });

      if (res.refused) {
        const focused = res.focused_window ?? {};
        return {
          clicked: '未点击（已拒绝）',
          refused: true,
          expected_window: res.expected_window,
          focused_window: `${focused.title || '(无标题)'} (pid ${focused.pid ?? 0})`,
          hint: `已拒绝发送输入：当前前景窗口「${focused.title || '(无标题)'}」不含「${res.expected_window}」。`
            + '请先用 computer_activate_window 聚焦目标窗口后重试；确实要打到当前焦点就把 expect_window 去掉。',
        };
      }
      if (res.ambiguous) {
        return {
          clicked: '未点击（匹配到多个）',
          ambiguous: true,
          matches: res.matches,
          hint: `有 ${(res.matches ?? []).length}+ 个控件的名称含「${nameArg}」，无法确定是哪一个。`
            + '请改用 ref（先用 computer_elements 取引用），或给出各自的完整名称。',
        };
      }

      const out = { clicked: `[${(res.clicked ?? []).join(',')}]` };
      // Say which enumeration a ref came from, and flag it when an older live
      // snapshot disagreed about what that name meant.
      if (refInfo) {
        out.ref_snapshot = refInfo.snapshot;
        const contest = refContestNote(refInfo.ref, refInfo);
        if (contest) out.ref_ambiguous = contest;
      }
      out.method = res.method;
      // Report the press duration that was actually used, so a caller can confirm a
      // long press really was long instead of assuming it.
      if (res.press_ms !== undefined) out.press_ms = res.press_ms;
      if (res.moved_to) out.pointer_landed = `[${res.moved_to.join(',')}]`;
      if (res.target) {
        const t = res.target;
        out.target = `${t.name ? `"${t.name}" ` : ''}${t.type ?? ''}${t.rect ? ` rect=[${t.rect.join(',')}]` : ''}`;
      }
      if (res.at) {
        out.under_cursor = `${res.at.name ? `"${res.at.name}" ` : ''}${res.at.type ?? ''}`;
        if (res.at.matches_target === true) out.hit_confirmed = true;
        else if (res.at.matches_target === false) out.hit_confirmed = false;
      }
      // An action pattern is invoked ON the resolved element, so the hit is not
      // inferred from where the pointer ended up — it is certain, and better
      // evidence than a cursor probe. (No mouse moved, so there is no `at`.)
      if (res.method && res.method !== 'mouse') {
        out.hit_confirmed = true;
        out.delivery = `uia-${res.method}`;
      }
      if (res.foreground_before || res.foreground_after) {
        out.foreground_before = res.foreground_before ?? '';
        out.foreground_after = res.foreground_after ?? '';
      }
      if (res.pointer_clamped) {
        out.hint = `指针被系统限制到 [${(res.moved_to ?? []).join(',')}]，与请求的 ${out.clicked} 不一致。`;
      }
      if (res.activated_only) {
        out.activated_only = true;
        out.hint = '这次点击很可能只把窗口激活、并未命中控件——请重新执行同一次点击；'
          + '但如果这一下本来就是「关闭对话框/菜单」让下方窗口浮上来，则属正常。先看 foreground_after 是不是你预期的窗口。';
      }
      return out;
    },
  };

  const computerType = {
    name: 'computer_type',
    description: [
      'Type arbitrary UTF-16 text (supports Chinese) at the current focus.',
      'Give ref or name to focus a specific field first (done through UI Automation, so it works even if the field is partly covered); otherwise the text goes wherever the keyboard focus already is.',
      `${HEAD}`,
      'Parameters: text (required string), send_enter (optional — press Enter after typing), ref / snapshot / name (optional field to focus first; snapshot pins the ref to the enumeration it came from), expect_window (optional — refuse unless the foreground window title contains it).',
      'Input uses SendInput KEYEVENTF_UNICODE, so any character, including CJK, is entered reliably.',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        text: { type: 'string' },
        send_enter: { type: 'boolean' },
        ref: { type: 'string', description: 'Element ref of the field to focus first, e.g. "e7".' },
        snapshot: { type: 'string', description: 'Optional snapshot id (e.g. "s7") that the ref came from. A bare ref resolves against the newest enumeration containing it; pin this to force one specific enumeration. A pin to an evicted snapshot is refused as stale.' },
        name: { type: 'string', description: 'Accessible name of the field to focus first.' },
        expect_window: EXPECT_WINDOW,
      },
      required: ['text'],
    },
    output: textOut({ required: ['chars'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_type');
      const cfg = getConfig();
      const payload = {
        action: 'type',
        text: String(args.text),
        sendEnter: !!args.send_enter,
        typingIntervalMs: cfg.typing_interval_ms || 0,
        expectWindow: args?.expect_window,
      };
      const refArg = typeof args?.ref === 'string' ? args.ref.trim() : '';
      let refInfo = null;
      if (refArg) {
        const resolved = resolveRef(refArg, args?.snapshot);
        if (resolved.status !== 'ok') throw new Error(refRefusal('computer_type', refArg, resolved));
        const hit = resolved.hit;
        refInfo = { ref: refArg, snapshot: resolved.snapshot, contested: resolved.contested ?? null };
        payload.target = { hwnd: hit.hwnd, name: hit.name, type: hit.type, automationId: hit.automationId, rect: hit.rect, name_truncated: hit.nameTruncated === true };
      } else if (typeof args?.name === 'string' && args.name.trim()) {
        payload.name = args.name.trim();
      }
      const res = await runPs('act.ps1', payload, { signal: exec?.signal });
      if (res.refused) {
        const focused = res.focused_window ?? {};
        return {
          chars: 0,
          refused: true,
          expected_window: res.expected_window,
          focused_window: `${focused.title || '(无标题)'} (pid ${focused.pid ?? 0})`,
          hint: `已拒绝输入：当前前景窗口「${focused.title || '(无标题)'}」不含「${res.expected_window}」。请先 computer_activate_window 聚焦。`,
        };
      }
      const out = { chars: res.chars };
      if (refInfo) {
        out.ref_snapshot = refInfo.snapshot;
        const contest = refContestNote(refInfo.ref, refInfo);
        if (contest) out.ref_ambiguous = contest;
      }
      if (res.focused_window !== undefined) out.focused_window = `${res.focused_window || '(无标题)'} (pid ${res.focused_pid ?? 0})`;
      return out;
    },
  };

  const computerKeypress = {
    name: 'computer_keypress',
    description: [`Send a key chord (e.g. ["ctrl","c"], ["alt","tab"]). ${HEAD}`, 'Parameters: keys (required array of key names: ctrl/control, shift, alt, super/win/cmd, enter, tab, esc, space, backspace, delete, home, end, pageup, pagedown, up/down/left/right, f1..f24, single letters/digits, or single punctuation chars), expect_window (optional string — refuse unless the foreground window title contains it; use this for chords like ctrl+h or ctrl+s that go to whatever has focus).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key names pressed together (modifiers first).' }, expect_window: EXPECT_WINDOW },
      required: ['keys'],
    },
    output: textOut({ required: ['keys'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_keypress');
      const res = await runPs('act.ps1', {
        action: 'keypress', keys: args.keys, expectWindow: args?.expect_window,
      }, { signal: exec?.signal });
      if (res.refused) {
        const focused = res.focused_window ?? {};
        return {
          keys: '',
          refused: true,
          expected_window: res.expected_window,
          focused_window: `${focused.title || '(无标题)'} (pid ${focused.pid ?? 0})`,
          hint: `已拒绝发送按键：当前前景窗口「${focused.title || '(无标题)'}」不含「${res.expected_window}」。请先 computer_activate_window 聚焦。`,
        };
      }
      const out = { keys: res.keys };
      if (res.focused_window !== undefined) out.focused_window = res.focused_window || '(无标题)';
      return out;
    },
  };

  const computerScroll = {
    name: 'computer_scroll',
    description: [`Scroll at a point. ${HEAD}`, 'Parameters: coordinate (required [x,y] — the point whose scrollable area should move), direction (optional: down [default] | up | left | right), clicks (optional number of wheel notches, default from config scroll_units).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        coordinate: COORD,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        clicks: { type: 'number' },
        expect_window: EXPECT_WINDOW,
      },
      required: ['coordinate'],
    },
    output: textOut({ required: ['scrolled'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_scroll');
      const cfg = getConfig();
      const clicks = typeof args.clicks === 'number' && args.clicks > 0 ? args.clicks : (cfg.scroll_units || 1);
      const res = await runPs('act.ps1', {
        action: 'scroll', coordinate: args.coordinate, direction: args.direction ?? 'down', clicks,
        expectWindow: args?.expect_window,
      }, { signal: exec?.signal });
      if (res.refused) {
        return { scrolled: '未滚动（已拒绝）', refused: true, hint: `当前前景窗口不含「${res.expected_window}」，请先 computer_activate_window 聚焦。` };
      }
      return { scrolled: `${args.direction ?? 'down'} ${clicks} tick(s) at [${res.cursor?.join(',') ?? args.coordinate}]` };
    },
  };

  const computerDrag = {
    name: 'computer_drag',
    description: [
      `Drag from start to end (press, hold, interpolate, release). ${HEAD}`,
      'This is also the tool for gestures that BEGIN with a press: give the same point twice and set hold_ms, and it becomes a press-and-hold / long press, which a plain click cannot express because its press and release are effectively simultaneous.',
      'Parameters: start_coordinate (required [x,y]), end_coordinate (required [x,y]), hold_ms (optional ms to keep the button down BEFORE the pointer starts moving, default 0 — raise it for long-press-then-drag gestures such as touch-style games), hold_keys (optional array, e.g. ["shift"] pressed while dragging), expect_window.',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        start_coordinate: COORD,
        end_coordinate: COORD,
        hold_ms: { type: 'number', description: 'Milliseconds to hold the button down before moving (default 0, max 10000). A long-press recogniser never fires without this.' },
        hold_keys: { type: 'array', items: { type: 'string' } },
        expect_window: EXPECT_WINDOW,
      },
      required: ['start_coordinate', 'end_coordinate'],
    },
    output: textOut({ required: ['from', 'to'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_drag');
      const payload = {
        action: 'drag', from: args.start_coordinate, to: args.end_coordinate,
        holdKeys: args.hold_keys ?? [], expectWindow: args?.expect_window,
      };
      if (Number.isFinite(Number(args?.hold_ms))) payload.holdMs = Math.trunc(Number(args.hold_ms));
      const res = await runPs('act.ps1', payload, { signal: exec?.signal });
      if (res.refused) {
        const from = Array.isArray(args.start_coordinate) ? args.start_coordinate.join(',') : '';
        return { from: `[${from}] 未拖拽`, to: '', refused: true, hint: `当前前景窗口不含「${res.expected_window}」，请先 computer_activate_window 聚焦。` };
      }
      return { from: res.from, to: res.to, ...(res.hold_ms === undefined ? {} : { hold_ms: res.hold_ms }) };
    },
  };

  const computerMoveMouse = {
    name: 'computer_move_mouse',
    description: [`Move the mouse cursor to a coordinate (without clicking). ${HEAD}`, 'Parameters: coordinate (required [x,y]).', 'Use computer_get_cursor_position to read the resulting position.'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { coordinate: COORD },
      required: ['coordinate'],
    },
    output: textOut({ required: ['moved_to'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_move_mouse');
      const res = await runPs('act.ps1', { action: 'move', coordinate: args.coordinate }, { signal: exec?.signal });
      const out = { moved_to: res.cursor };
      if (res.requested && (res.cursor?.[0] !== res.requested[0] || res.cursor?.[1] !== res.requested[1])) {
        out.pointer_clamped = true;
        out.hint = `指针被系统限制到 [${res.cursor.join(',')}]，与请求的 [${res.requested.join(',')}] 不一致。`;
      }
      return out;
    },
  };

  const computerWait = {
    name: 'computer_wait',
    description: ['Wait for a short period (e.g. let a UI animation settle). No side effects.', 'Parameters: ms (required, duration in milliseconds).'],
    parameters: { type: 'object', additionalProperties: true, properties: { ms: { type: 'number' } }, required: ['ms'] },
    output: textOut({ required: ['waited'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_wait');
      const ms = Math.max(0, Number(args.ms) || 0);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        exec?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('computer_wait: cancelled')); }, { once: true });
      });
      return { waited: ms };
    },
  };

  const computerGetCursorPosition = {
    name: 'computer_get_cursor_position',
    description: ['Read the current mouse cursor position as virtual-screen pixels [x, y].', 'Useful to verify the result of computer_move_mouse / computer_click. No side effects.'],
    parameters: { type: 'object', additionalProperties: true, properties: {}, required: [] },
    output: textOut({ required: ['x', 'y'] }),
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      gate('computer_get_cursor_position');
      const res = await runPs('act.ps1', { action: 'getpos' }, { signal: exec?.signal });
      return { x: res.cursor[0], y: res.cursor[1] };
    },
  };

  // -- computer_set_mode: AI may change the runtime mode (if enabled) -------
  const computerSetMode = {
    name: 'computer_set_mode',
    description: [
      'Change the runtime mode to one of: disabled / readonly / manual / auto.',
      'Only works when the setting「AI 可自行修改运行模式」(ai_can_change_mode) is on; otherwise this tool refuses.',
      'Settings card dropdown stays in sync: the new mode is written to the computer-user settings namespace (same store the dropdown reads).',
      'Parameters: mode (required, one of disabled/readonly/manual/auto).',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        mode: { type: 'string', enum: MODES, description: '目标运行模式：disabled/readonly/manual/auto' },
      },
      required: ['mode'],
    },
    output: textOut({ required: ['mode', 'changed_by'] }),
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      if (typeof setMode !== 'function') throw new Error('computer_set_mode: 设置服务不可用');
      const cfg = getConfig();
      if (cfg.mode === 'disabled') {
        throw new Error('computer-user 已禁用：无法在禁用模式下修改运行模式（需用户在设置中先解除禁用）');
      }
      if (cfg.ai_can_change_mode !== true) {
        throw new Error('computer_set_mode: 当前未允许 AI 修改运行模式（设置「AI 可自行修改运行模式」未开启）');
      }
      const mode = validateMode(args.mode);
      await setMode(mode);
      return { mode, changed_by: 'ai' };
    },
  };

  // -- computer_list_windows -------------------------------------------------
  // Reading a window rectangle off a downscaled screenshot is the single most
  // common cause of a misclick. Ask the OS instead. `rect` is the DWM extended
  // frame - the pixels actually on screen; `window_rect` is the raw GetWindowRect
  // value, which is 8 px larger on every side because of the invisible resize
  // border, and using that for window-relative aiming is a systematic 8 px error.
  const computerListWindows = {
    name: 'computer_list_windows',
    description: [
      'List visible top-level windows in z-order (topmost first) with their EXACT on-screen pixel rectangles.',
      'rect is the visible frame (DWM extended frame bounds). window_rect is the raw Win32 rectangle, which is ~8 px larger on each side because it includes the invisible resize border — use rect for anything you aim at.',
      'Parameters: min_width / min_height (optional, default 1) drop tiny windows; foreground_only (optional) returns just the focused window.',
      'Returns { count, zOrderTopFirst, windows:[{ hwnd, pid, title, class, rect, window_rect, client_rect, width, height, minimized, foreground }] }.',
      'Pass an entry\'s hwnd to computer_activate_window to focus it, or to computer_elements to read its controls.',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        min_width: { type: 'number', description: 'Ignore windows narrower than this (virtual-screen px).' },
        min_height: { type: 'number', description: 'Ignore windows shorter than this (virtual-screen px).' },
        foreground_only: { type: 'boolean', description: 'Return only the currently focused window.' },
      },
      required: [],
    },
    output: textOut({ required: ['count'] }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      gate('computer_list_windows');
      if (args?.foreground_only) {
        const res = await runPs('act.ps1', { action: 'foreground' }, { signal: exec?.signal });
        return { count: res.window ? 1 : 0, zOrderTopFirst: true, windows: res.window ? [res.window] : [] };
      }
      const res = await runPs('act.ps1', {
        action: 'windows',
        minWidth: typeof args?.min_width === 'number' ? args.min_width : 1,
        minHeight: typeof args?.min_height === 'number' ? args.min_height : 1,
      }, { signal: exec?.signal });
      return { count: res.count, zOrderTopFirst: res.zOrderTopFirst, windows: res.windows };
    },
  };

  // -- computer_activate_window ----------------------------------------------
  // Windows consumes the first synthetic click on a background window as the
  // activation click; the control never sees it and nothing reports the loss.
  // Focusing deliberately removes that whole failure mode.
  const computerActivateWindow = {
    name: 'computer_activate_window',
    description: [
      'Bring a window to the foreground deliberately, WITHOUT spending a click on it.',
      'This exists because the first synthetic click on a background window is consumed by activation — it never reaches the control, and nothing reports that it was lost. Focus first, then click.',
      'Parameters: hwnd (from computer_list_windows, preferred) OR pid OR title (case-insensitive substring).',
      'Returns { requested, foreground, activated }. When activated is false the result also says whether a HIDDEN window is holding the foreground, which needs a different remedy than a window that simply refused to come forward.',
    ].join(' '),
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        hwnd: { type: 'number', description: 'Window handle from computer_list_windows (preferred).' },
        pid: { type: 'number', description: 'Owner process id; its largest visible window is activated.' },
        title: { type: 'string', description: 'Case-insensitive substring of the window title.' },
      },
      required: [],
    },
    output: textOut({ required: ['requested', 'foreground'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_activate_window');
      const payload = { action: 'activate' };
      if (args?.hwnd !== undefined && args?.hwnd !== null) payload.hwnd = args.hwnd;
      else if (args?.pid !== undefined && args?.pid !== null) payload.pid = args.pid;
      else if (typeof args?.title === 'string' && args.title.trim() !== '') payload.title = args.title.trim();
      else throw new Error('computer_activate_window: 需要 hwnd / pid / title 之一');
      const res = await runPs('act.ps1', payload, { signal: exec?.signal });
      const out = { requested: res.requested, foreground: describeWindow(res.foreground) };
      // "The window never came forward" is a RESULT, not an error: report it with
      // the foreground record and the hint. Throwing here only produced a generic
      // PowerShell failure message with none of that detail.
      if (res.activated === false) {
        out.activated = false;
        if (res.foreground_visible === false) {
          out.hint = `激活未生效：系统仍把窗口 hwnd ${res.foreground?.hwnd ?? 0}「${res.foreground?.title ?? ''}」当作前台，但它当前并不可见`
            + '（常见于系统正在隐藏/切换窗口）。再调用一次 computer_activate_window，或直接点一下目标窗口的标题栏。';
        } else {
          out.hint = '激活未生效：请求的窗口没有成为前台（可能被 UWP 或更高权限的窗口占住）。重试通常有效，也可以直接点它的标题栏。';
        }
      }
      return out;
    },
  };

  const tools = [
    computerScreenshot,
    computerElements,
    computerListWindows,
    computerClick,
    computerType,
    computerKeypress,
    computerScroll,
    computerDrag,
    computerMoveMouse,
    computerActivateWindow,
    computerWait,
    computerGetCursorPosition,
    computerSetMode,
  ];

  for (const tool of tools) {
    if (Array.isArray(tool.description)) tool.description = tool.description.join(' ');
  }

  return tools;
}

export default createComputerTools;
