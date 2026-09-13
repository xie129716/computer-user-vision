/**
 * Vision screenshot verification (end-to-end, real capture).
 *
 * Runs the REAL capture.ps1 through the plugin's own runPs with stubbed host
 * services (llm / attachments), then asserts:
 *   A. vision route   -> an image block is attached and the coordinate mapping
 *      maps the image back onto the true screen size
 *   B. text route     -> falls back to the path-only contract, no image block
 *   C. vision_feedback=false -> path-only even on a vision route
 *   D. a host-side downscale on save is folded into screen_per_pixel
 *   E. region capture maps back to the cropped screen width and honours offset
 *
 * NOTE: this grabs the real screen (that is the point) but never transmits it —
 * bytes go only to the stubbed attachment service in memory.
 *
 * Usage: node verify/vision-screenshot.mjs
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PKG_DIR } from './_profile.mjs';

const { createComputerTools } = await import(pathToFileURL(join(PKG_DIR, 'src', 'tools.js')).href);
const { runPs } = await import(pathToFileURL(join(PKG_DIR, 'src', 'ps.js')).href);

const WORK = join(tmpdir(), 'computer-user-verify');

/** Read PNG intrinsic size straight from the IHDR chunk. */
async function pngSize(path) {
  const buf = await readFile(path);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`not a PNG: ${path}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function makeExec() {
  return {
    signal: undefined,
    agent: {
      options: {},
      session: {
        header: { cwd: WORK },
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
    },
  };
}

/** Stub host ctx: imageCapable toggles the route, scaleFn simulates host normalization. */
function makeCtx({ imageCapable = true, scaleFn = null } = {}) {
  return {
    get(name) {
      if (name === 'llm') {
        return { resolveModelInfo: async () => ({ inputModalities: imageCapable ? ['text', 'image'] : ['text'] }) };
      }
      if (name === 'attachments') {
        return {
          saveImage: async ({ data, mediaType, name }) => {
            const tmp = join(WORK, `attach-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
            await writeFile(tmp, data);
            const size = await pngSize(tmp);
            await rm(tmp, { force: true });
            return {
              attachmentId: 'sha256:0000000000000000',
              mediaType,
              bytes: data.byteLength,
              width: (scaleFn ? scaleFn(size) : size).width,
              height: (scaleFn ? scaleFn(size) : size).height,
              name,
              ...(scaleFn ? { originalDimensions: { width: size.width, height: size.height } } : {}),
            };
          },
        };
      }
      return undefined;
    },
    logger: { warn: () => {}, info: () => {} },
  };
}

function screenshotTool(ctx, cfg) {
  const tools = createComputerTools({
    runPs, getConfig: () => cfg, approvedSessions: new Set(), sessionId: 'verify', setMode: async () => {}, ctx,
  });
  return tools.find((t) => t.name === 'computer_screenshot');
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(WORK, { recursive: true });
const refPath = join(WORK, 'reference.png');
const ref = await runPs('capture.ps1', { outPath: refPath, scale: 1 });
console.log(`reference capture: ${ref.width}x${ref.height}, virtual_offset=[${ref.virtual_offset}]\n`);

// ── A. vision route ─────────────────────────────────────────────────────────
{
  const ctx = makeCtx({ imageCapable: true });
  const tool = screenshotTool(ctx, { mode: 'auto', vision_feedback: true, vision_max_pixels: 640000, default_scale: 1 });
  const value = await tool.execute({}, makeExec());
  const blocks = tool.output.render({}, value);

  check('A1 image block attached on a vision route', !!blocks.find((b) => b.type === 'image'));
  check('A2 result reports vision:true', value.vision === true);
  check('A3 capture fitted into the 640k budget', value.width * value.height <= 640000,
    `${value.width}x${value.height} = ${value.width * value.height} px (capture_scale=${value.scale})`);
  check('A4 image dims match the file dims (no opaque host downscale)',
    value.image.width === value.width && value.image.height === value.height);

  const [kx, ky] = value.screen_per_pixel;
  const mappedW = value.image.width * kx;
  const mappedH = value.image.height * ky;
  check('A5 image pixel -> screen pixel mapping reproduces the real screen size',
    Math.abs(mappedW - ref.width) <= 1.5 && Math.abs(mappedH - ref.height) <= 1.5,
    `image ${value.image.width}x${value.image.height} * [${kx}, ${ky}] = ${mappedW.toFixed(1)}x${mappedH.toFixed(1)} vs screen ${ref.width}x${ref.height}`);
  check('A6 text envelope teaches screen_mapping', blocks[0].text.includes('screen_mapping') && blocks[0].text.includes('image_size'));
  check('A7 envelope does not demand an external image reader', !/picturereader/.test(blocks[0].text));
}

// ── B. text-only route ──────────────────────────────────────────────────────
{
  const ctx = makeCtx({ imageCapable: false });
  const tool = screenshotTool(ctx, { mode: 'auto', vision_feedback: true, vision_max_pixels: 640000, default_scale: 1 });
  const value = await tool.execute({}, makeExec());
  const blocks = tool.output.render({}, value);
  check('B1 no image block on a text-only route', !blocks.some((b) => b.type === 'image'));
  check('B2 reports vision:false', value.vision === false);
  check('B3 envelope points at an external image tool', /picturereader/.test(blocks[0].text));
  check('B4 path still returned', typeof value.path === 'string' && value.path.endsWith('.png'));
}

// ── C. vision_feedback disabled ─────────────────────────────────────────────
{
  const ctx = makeCtx({ imageCapable: true });
  const tool = screenshotTool(ctx, { mode: 'auto', vision_feedback: false, default_scale: 1 });
  const value = await tool.execute({}, makeExec());
  check('C1 vision_feedback=false forces the path contract', value.vision === false && !value.image);
}

// ── D. host-side downscale is folded into the factor ────────────────────────
{
  const ctx = makeCtx({ imageCapable: true, scaleFn: (s) => ({ width: Math.floor(s.width / 2), height: Math.floor(s.height / 2) }) });
  const tool = screenshotTool(ctx, { mode: 'auto', vision_feedback: true, vision_max_pixels: 640000, default_scale: 1 });
  const value = await tool.execute({}, makeExec());
  const [kx] = value.screen_per_pixel;
  check('D1 host downscale halves the shown image', value.image.width === Math.floor(value.width / 2));
  const mappedW = value.image.width * kx;
  check('D2 screen_per_pixel compensates for the host downscale', Math.abs(mappedW - ref.width) <= 1.5,
    `${value.image.width} * ${kx} = ${mappedW.toFixed(1)} vs screen ${ref.width}`);
}

// ── E. region capture still maps correctly ──────────────────────────────────
{
  const ctx = makeCtx({ imageCapable: true });
  const tool = screenshotTool(ctx, { mode: 'auto', vision_feedback: true, vision_max_pixels: 640000, default_scale: 1 });
  const value = await tool.execute({ region: [0.25, 0.25, 0.75, 0.75] }, makeExec());
  const [kx] = value.screen_per_pixel;
  const mappedW = value.image.width * kx;
  const expectedW = Math.round(ref.width * 0.5);
  check('E1 region capture maps back to the cropped screen width', Math.abs(mappedW - expectedW) <= 2,
    `image ${value.image.width} * ${kx} = ${mappedW.toFixed(1)} vs cropped ${expectedW}`);
  check('E2 region capture honours the offset',
    value.virtual_offset[0] === ref.virtual_offset[0] + Math.floor(ref.width * 0.25), `offset=${value.virtual_offset}`);
}

await rm(WORK, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
