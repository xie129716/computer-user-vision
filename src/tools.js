import { join, resolve as pathResolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Build the computer_* tools. Coordinate system: pixels relative to the
 * multi-monitor VIRTUAL SCREEN ORIGIN (returned by computer_screenshot as
 * `virtual_offset`). All screen-reading/automation is delegated to bundled
 * PowerShell scripts (capture.ps1 / input.ps1) with zero native dependencies.
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

const HEAD =
  '先调用 computer_screenshot 获取当前屏幕：模型具备视觉能力时截图会直接以图片附加返回，直接观察即可（无需 picturereader）；' +
  '模型不支持图像时返回文件路径，需交给外部图像分析工具（如 picturereader 的 image_scan / image_ocr）。' +
  '不要靠缩略图目测坐标——用 computer_list_windows 拿窗口精确矩形，或用 computer_activate_window 先把目标窗口置前（避免第一下点击只用于激活窗口）。确认目标后再执行本次操作。';

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
  // A user stop outranks every mode: the overlay's Cancel button and its global
  // hotkey both land here, and nothing runs again until the user re-approves.
  // The message deliberately carries INTENT, not just a refusal - "blocked"
  // alone invites the model to hunt for a workaround instead of handing control
  // back, which is the opposite of what the user asked for by pressing stop.
  const stopped = controlState?.stopLabel?.();
  if (stopped) {
    throw new Error(
      `用户已在电脑操控过程中停止（${stopped}）。\n` +
        '这通常意味着下面某一种情况（不要猜测是哪一种，用一句话向用户确认即可）：\n' +
        '  · 用户认为本轮操作有风险，或对正在发生的事不放心；\n' +
        '  · 用户本次不希望由 AI 操控电脑，想自己接手；\n' +
        '  · 用户想换一种方式完成（例如改用命令行 / API / 文件操作，而不是 GUI 操控）。\n' +
        '本轮必须遵守：\n' +
        '  1. 立即停止一切电脑操控，不要重试、不要换工具绕开、不要试图重新拉起控制界面——\n' +
        '     在用户重新授权之前，所有 computer_* 工具都会持续拒绝；\n' +
        '  2. 用一两句话说明你已经做了什么、停在哪一步，以及是否存在未完成或可能已产生\n' +
        '     影响的操作需要用户确认；\n' +
        '  3. 询问用户希望如何继续（自己接手 / 换方式 / 重新授权 / 就此结束），然后等待回复。\n' +
        '用户重新授权的方式：在对话框输入 /computer（这会同时解除停止状态）。'
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
    lines.push(
      'Measure the target on the attached image, then convert with screen_mapping: the result is the virtual-screen ' +
        'physical pixel coordinate that computer_click / computer_scroll / computer_drag / computer_move_mouse expect.'
    );
    lines.push(`virtual_offset: [${vx}, ${vy}]`);
    lines.push(`capture_scale: ${v.scale}`);
    return lines.join('\n');
  }

  lines.push('screenshot saved to a PNG file (this model does not declare image input, so the picture cannot be attached).');
  lines.push(`path: ${v.path}`);
  lines.push(`width: ${v.width}`);
  lines.push(`height: ${v.height}`);
  lines.push(`virtual_offset: [${vx}, ${vy}]`);
  lines.push(`scale: ${v.scale}`);
  lines.push('Analyze the file with an external image tool (e.g. picturereader image_scan / image_ocr) to locate elements before acting.');
  return lines.join('\n');
}

export function createComputerTools({ runPs, getConfig, approvedSessions, sessionId, setMode, ctx, controlState }) {
  if (typeof runPs !== 'function') throw new Error('computer-user: runPs is required');
  if (typeof getConfig !== 'function') throw new Error('computer-user: getConfig is required');

  const gate = (toolName) => modeGate(getConfig(), toolName, approvedSessions, sessionId, controlState);

  /** One context.ps1 round trip (window enumeration / hit test / activation). */
  const ctxPs = (payload, exec) => runPs('context.ps1', payload, { signal: exec?.signal });

  /** Post-action context: what is focused now, and what sits under a point. */
  async function probeContext(exec, point) {
    const cfg = getConfig() ?? {};
    if (cfg.verify_actions === false) return null;
    try {
      const payload = { action: 'probe' };
      if (Array.isArray(point) && point.length === 2) {
        payload.x = Math.round(Number(point[0]));
        payload.y = Math.round(Number(point[1]));
      }
      return await ctxPs(payload, exec);
    } catch (error) {
      ctx?.logger?.warn?.(`[computer-user] probe failed: ${String(error?.message ?? error)}`);
      return null;
    }
  }

  /** Condense a probed element into the few fields a caller can act on. */
  function describeElement(probe) {
    const el = probe?.element;
    if (!el) return probe?.available === false ? 'unavailable' : null;
    // Only ever assign PRESENT values: a property whose value is `undefined` is
    // not lossless JSON, and the harness rejects the entire tool result for it.
    // A plain document control with an empty name is exactly that case.
    const out = { pid: el.pid, enabled: el.enabled };
    if (el.name) out.name = el.name;
    if (el.localizedType) out.type = el.localizedType;
    if (el.className) out.class = el.className;
    if (el.automationId) out.automationId = el.automationId;
    if (Array.isArray(el.rect)) out.rect = el.rect;
    return out;
  }

  /** The focused-window summary, trimmed to what matters for verification. */
  function describeWindow(window) {
    if (!window) return null;
    return { title: window.title, pid: window.pid, hwnd: window.hwnd, rect: window.rect };
  }

  // -- computer_screenshot ---------------------------------------------------
  const computerScreenshot = {
    name: 'computer_screenshot',
    description: [
      'Capture the whole virtual screen (all monitors) and return it so you can see the desktop (the look step of computer use).',
      'When the current model accepts image input the screenshot is attached to this result as an actual image — look at it directly; ' +
        'otherwise only a PNG path is returned and an external image tool (picturereader image_scan / image_ocr) must analyze it.',
      `${HEAD}`,
      'Parameters: path (optional — where to save; when empty a unique file is written under the configured screenshot_dir, defaulting to the OS temp dir), region (optional [x0,y0,x1,y1] fractions in 0..1 to capture a sub-area), scale (optional 0.1..1 to downscale the saved image).',
      'Returns { path, width, height, virtual_offset:[x,y], scale, image?, screen_per_pixel? }. In vision mode the attached image is authoritative and screen_mapping converts an image pixel to the virtual-screen pixel that the input tools take; virtual_offset is the virtual-screen origin you must add to a monitor\'s local pixel when targeting that monitor.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        path: { type: 'string', description: 'Optional absolute or cwd-relative output path for the PNG. When empty a unique file is created under the configured screenshot_dir (default: OS temp).' },
        region: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' }, description: 'Optional [x0, y0, x1, y1] fractions (0..1) to capture only a sub-area of the virtual screen.' },
        scale: { type: 'number', description: 'Optional 0.1..1 downscale for the saved image (default: the configured default_scale, 1 = full resolution). In vision mode the result is additionally fitted into the model\'s pixel budget.' },
        grid: { type: 'number', description: 'Optional coordinate grid spacing in virtual-screen pixels (e.g. 100). Draws labelled lines so screen coordinates can be read straight off a downscaled image instead of estimated. 0 disables it.' },
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
      const outPath = args && args.path
        ? pathResolve(cwd, String(args.path))
        : join(dir, `shot-${Date.now()}-${randomBytes(4).toString('hex')}.png`);
      const region = Array.isArray(args?.region) && args.region.length === 4 ? args.region : undefined;
      const requestedScale = typeof args?.scale === 'number' ? args.scale : cfg.default_scale;
      const gridSpacing = typeof args?.grid === 'number' ? args.grid : (Number(cfg.grid_spacing) || 0);

      const capture = (scale) => runPs('capture.ps1', { outPath, region, scale, grid: gridSpacing }, { signal: exec?.signal });

      // The control indicator is drawn for the human watching, never for the
      // model: leaving it up would bake a bright frame into every screenshot
      // and cover real content along the edges. Hide it for the capture.
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

      const base = {
        path: res.path,
        width: res.width,
        height: res.height,
        virtual_offset: res.virtual_offset,
        scale: res.scale,
      };

      if (!visionMode) return { ...base, vision: false };

      try {
        const data = await readFile(res.path);
        const lower = String(res.path).toLowerCase();
        const mediaType = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
        const ref = await attachments.saveImage({ data, mediaType, name: basename(res.path) });

        // The host may normalize (downscale) on save; fold that into the factor
        // so one image pixel always maps to the right number of screen pixels.
        const shownW = Number(ref.width) > 0 ? Number(ref.width) : res.width;
        const shownH = Number(ref.height) > 0 ? Number(ref.height) : res.height;
        const scale = Number(res.scale) > 0 ? Number(res.scale) : 1;
        const kx = Number(((res.width / shownW) / scale).toFixed(4));
        const ky = Number(((res.height / shownH) / scale).toFixed(4));

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

  // -- side-effecting tools --------------------------------------------------
  const computerClick = {
    name: 'computer_click',
    description: [`Click at a coordinate. ${HEAD}`, 'Parameters: coordinate (required [x,y] pixels, relative to the virtual-screen origin), action (optional: click [default] | right_click | double_click).', 'Returns the clicked coordinate.'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        coordinate: { ...COORD, description: 'Relative to virtual-screen origin from computer_screenshot.virtual_offset.' },
        action: { type: 'string', enum: ['click', 'right_click', 'double_click'], description: 'Default click.' },
      },
      required: ['coordinate'],
    },
    output: textOut({ required: ['clicked'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_click');
      const point = [Math.round(Number(args.coordinate[0])), Math.round(Number(args.coordinate[1]))];
      const cfg = getConfig() ?? {};
      let before = null;
      if (cfg.verify_actions !== false) {
        try { before = (await ctxPs({ action: 'foreground' }, exec)).window; } catch { before = null; }
      }
      const res = await runPs('input.ps1', { action: 'click', coordinate: args.coordinate, action2: args.action ?? 'click' }, { signal: exec?.signal });
      const probe = await probeContext(exec, point);
      const after = probe?.foreground ?? null;

      const out = { clicked: res.cursor };
      const element = describeElement(probe);
      if (element) out.at = element;
      if (before && after) {
        out.foreground_before = before.title || `pid ${before.pid}`;
        out.foreground_after = after.title || `pid ${after.pid}`;
        // The click landed inside the window that just came forward, which is
        // exactly the activation-click failure: it was spent raising the window.
        const changed = before.hwnd !== after.hwnd;
        const inside = Array.isArray(after.rect)
          && point[0] >= after.rect[0] && point[0] <= after.rect[2]
          && point[1] >= after.rect[1] && point[1] <= after.rect[3];
        if (changed && inside) {
          out.activated_only = true;
          out.hint = '这次点击很可能只把窗口激活、并未命中控件——请重新执行同一次点击。';
        }
      }
      return out;
    },
  };

  const computerType = {
    name: 'computer_type',
    description: [`Type arbitrary UTF-16 text (supports Chinese) at the current focus. ${HEAD}`, 'Parameters: text (required string), send_enter (optional bool — press Enter after typing).', 'Input uses SendInput KEYEVENTF_UNICODE, so any character, including CJK, is entered reliably.' ],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { text: { type: 'string' }, send_enter: { type: 'boolean' } },
      required: ['text'],
    },
    output: textOut({ required: ['chars'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_type');
      const cfg = getConfig();
      const res = await runPs('input.ps1', {
        action: 'type', text: String(args.text), sendEnter: !!args.send_enter,
        typingIntervalMs: cfg.typing_interval_ms || 0,
      }, { signal: exec?.signal });
      // Report where the text actually went: typing into the wrong window is
      // silent otherwise.
      const probe = await probeContext(exec);
      const out = { chars: res.chars };
      const focused = describeWindow(probe?.foreground);
      if (focused) out.focused_window = focused;
      return out;
    },
  };

  const computerKeypress = {
    name: 'computer_keypress',
    description: [`Send a key chord (e.g. ["ctrl","c"], ["alt","tab"]). ${HEAD}`, 'Parameters: keys (required array of key names: ctrl/control, shift, alt, super/win/cmd, enter, tab, esc, space, backspace, delete, home, end, pageup, pagedown, up/down/left/right, f1..f24, single letters/digits, or single punctuation chars).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: { keys: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Key names pressed together (modifiers first).' } },
      required: ['keys'],
    },
    output: textOut({ required: ['keys'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_keypress');
      const res = await runPs('input.ps1', { action: 'keypress', keys: args.keys }, { signal: exec?.signal });
      const probe = await probeContext(exec);
      const out = { keys: res.keys };
      const focused = describeWindow(probe?.foreground);
      if (focused) out.focused_window = focused;
      return out;
    },
  };

  const computerScroll = {
    name: 'computer_scroll',
    description: [`Scroll at a coordinate. ${HEAD}`, 'Parameters: coordinate (required [x,y]), direction (optional: down [default] | up | left | right), clicks (optional number of wheel notches, default from config scroll_units).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        coordinate: COORD,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        clicks: { type: 'number' },
      },
      required: ['coordinate'],
    },
    output: textOut({ required: ['scrolled'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_scroll');
      const cfg = getConfig();
      const clicks = typeof args.clicks === 'number' && args.clicks > 0 ? args.clicks : (cfg.scroll_units || 1);
      await runPs('input.ps1', { action: 'scroll', coordinate: args.coordinate, direction: args.direction ?? 'down', clicks }, { signal: exec?.signal });
      return { scrolled: `${args.direction ?? 'down'} ${clicks} tick(s) at [${args.coordinate}]` };
    },
  };

  const computerDrag = {
    name: 'computer_drag',
    description: [`Drag from start to end (press, interpolate, release). ${HEAD}`, 'Parameters: start_coordinate (required [x,y]), end_coordinate (required [x,y]), hold_keys (optional array, e.g. ["shift"] pressed while dragging).'],
    parameters: {
      type: 'object', additionalProperties: true,
      properties: {
        start_coordinate: COORD,
        end_coordinate: COORD,
        hold_keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['start_coordinate', 'end_coordinate'],
    },
    output: textOut({ required: ['from', 'to'] }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      gate('computer_drag');
      const res = await runPs('input.ps1', { action: 'drag', from: args.start_coordinate, to: args.end_coordinate, holdKeys: args.hold_keys ?? [] }, { signal: exec?.signal });
      return { from: res.from, to: res.to };
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
      const res = await runPs('input.ps1', { action: 'move', coordinate: args.coordinate }, { signal: exec?.signal });
      return { moved_to: res.cursor };
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
      const res = await runPs('input.ps1', { action: 'getpos' }, { signal: exec?.signal });
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
  // common cause of a misclick (observed in practice: a 1.84x downscale turned
  // a visual estimate into a ~240px error). Ask the OS instead.
  const computerListWindows = {
    name: 'computer_list_windows',
    description: [
      'List visible top-level windows in z-order (topmost first) with their EXACT virtual-screen pixel rectangles.',
      'Prefer this over estimating a window position from a screenshot — reading coordinates off a downscaled image is the most common source of misclicks.',
      'Parameters: min_width / min_height (optional, default 1) drop tiny windows; foreground_only (optional) returns just the focused window.',
      'Returns { count, zOrderTopFirst, windows:[{ hwnd, pid, title, rect:[left,top,right,bottom], width, height, minimized, foreground }] }.',
      'Pass an entry\'s hwnd to computer_activate_window to focus it, or use rect to compute a capture region / click target.',
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
        const res = await ctxPs({ action: 'foreground' }, exec);
        return { count: res.window ? 1 : 0, zOrderTopFirst: true, windows: res.window ? [res.window] : [] };
      }
      const res = await ctxPs({
        action: 'windows',
        minWidth: typeof args?.min_width === 'number' ? args.min_width : 1,
        minHeight: typeof args?.min_height === 'number' ? args.min_height : 1,
      }, exec);
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
      'Returns { requested, foreground } naming the window that actually ended up focused.',
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
      const res = await ctxPs(payload, exec);
      return { requested: res.requested, foreground: describeWindow(res.foreground) };
    },
  };

  const tools = [
    computerScreenshot,
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
