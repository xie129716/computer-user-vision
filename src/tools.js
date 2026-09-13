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
  '模型不支持图像时返回文件路径，需交给外部图像分析工具（如 picturereader 的 image_scan / image_ocr）。确认目标后再执行本次操作。';

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
]);

const MODES = ['disabled', 'readonly', 'manual', 'auto'];

/**
 * Mode gate: decide whether a tool call is allowed based on the current mode
 * and the session's approval state.
 *
 * Returns void if allowed, or throws with `awaitingApproval=true` if
 * the user needs to approve via /computer first.
 */
function modeGate(cfg, toolName, approvedSessions, sessionId) {
  const mode = cfg.mode ?? 'manual';
  if (mode === 'disabled') {
    throw new Error('computer-user 已禁用：请在「设置 → 电脑操作」切换模式后再使用');
  }
  if (mode === 'readonly' && !READONLY_TOOLS.has(toolName)) {
    throw new Error(`computer-user 只读模式：${toolName} 不允许执行，仅截图/读光标/等待可用`);
  }
  if (mode === 'manual' && !READONLY_TOOLS.has(toolName)) {
    const approved = sessionId && approvedSessions && approvedSessions.has(sessionId);
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

export function createComputerTools({ runPs, getConfig, approvedSessions, sessionId, setMode, ctx }) {
  if (typeof runPs !== 'function') throw new Error('computer-user: runPs is required');
  if (typeof getConfig !== 'function') throw new Error('computer-user: getConfig is required');

  const gate = (toolName) => modeGate(getConfig(), toolName, approvedSessions, sessionId);

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

      const capture = (scale) => runPs('capture.ps1', { outPath, region, scale }, { signal: exec?.signal });

      let res = await capture(requestedScale);

      // Fit into the model's vision budget by re-capturing smaller. Doing it here
      // (rather than letting the host downscale) keeps the preview dimensions
      // equal to the file dimensions, so screen_mapping stays exact.
      if (budget && res?.width > 0 && res?.height > 0 && res.width * res.height > budget) {
        const shrink = Math.sqrt(budget / (res.width * res.height));
        const current = Number(res.scale) > 0 ? Number(res.scale) : 1;
        const next = Math.max(0.1, Math.min(1, current * shrink * 0.98));
        if (next < current) res = await capture(next);
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
      const res = await runPs('input.ps1', { action: 'click', coordinate: args.coordinate, action2: args.action ?? 'click' }, { signal: exec?.signal });
      return { clicked: res.cursor };
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
      return { chars: res.chars };
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
      return { keys: res.keys };
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

  const tools = [
    computerScreenshot,
    computerClick,
    computerType,
    computerKeypress,
    computerScroll,
    computerDrag,
    computerMoveMouse,
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
