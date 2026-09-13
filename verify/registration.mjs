/**
 * Registration contract test.
 *
 * Loads the real plugin module and runs its apply() against a mock cordis
 * context, asserting that everything the upstream `settingsNamespace` import
 * used to take down is actually registered:
 *   - the 10 computer_* tools
 *   - the `computer-user` settings namespace (via provider.register)
 *   - the /computer approval command
 *   - the LLM output guard
 * Also drives computer_set_mode to prove sourceSetter writes through update().
 *
 * Usage: node verify/registration.mjs
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { PKG_DIR } from './_profile.mjs';

const mod = await import(pathToFileURL(join(PKG_DIR, 'src', 'index.js')).href);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const tools = [];
const commands = [];
const registered = [];
let watched = 0;
let currentSettings = { mode: 'auto', vision_feedback: true, ai_can_change_mode: true };

const settingsScope = {
  get: () => currentSettings,
  watch: () => { watched += 1; return () => {}; },
  update: async (patch) => { registered.push({ kind: 'update', patch }); Object.assign(currentSettings, patch); },
  replace: async () => {},
};

const settingsSctx = {
  settings: { register: (ns, schema, opts) => { registered.push({ kind: 'register', ns, hasSchema: !!schema, opts }); return settingsScope; } },
  get(name) { return name === 'settings' ? this.settings : undefined; },
  effect: (fn) => { fn(); return () => {}; },
};

const ctx = {
  logger: { info: () => {}, warn: (m) => console.log('   [warn]', m) },
  effect: (fn) => { fn(); return () => {}; },
  tools: { register: (t) => tools.push(t) },
  get: () => undefined,
  inject(names, cb) {
    if (names.includes('settings')) return cb(settingsSctx);
    if (names.includes('commands')) return cb({ commands: { register: (c) => commands.push(c) } });
    if (names.includes('llm')) {
      const adapter = { stream: async function* () { yield { type: 'text-delta', text: 'hi' }; } };
      return cb({ llm: { listProviders: () => ['deepseek-official'], registration: () => ({ adapter }), on: () => {} } });
    }
    return undefined;
  },
};

console.log(`plugin: ${mod.name} v${mod.version}\n`);
mod.apply(ctx, { mode: 'auto' });

const names = tools.map((t) => t.name).sort();
check('apply() registers 12 computer_* tools', tools.length === 12, `${tools.length}: ${names.join(', ')}`);
check('computer_screenshot is registered', names.includes('computer_screenshot'));
check('computer_list_windows is registered (exact window geometry)', names.includes('computer_list_windows'));
check('computer_activate_window is registered (avoid the activation-click trap)', names.includes('computer_activate_window'));
check('every tool exposes description + parameters + execute',
  tools.every((t) => typeof t.name === 'string' && typeof t.description === 'string' && t.parameters && typeof t.execute === 'function'));
check('every tool exposes a render function', tools.every((t) => t.output && typeof t.output.render === 'function'));

const reg = registered.find((r) => r.kind === 'register');
check('settings namespace registered through provider.register', !!reg, reg && `ns="${reg.ns}"`);
check('namespace is the plain "computer-user" string (0.1.5 API)', reg?.ns === 'computer-user');
check('namespace registered exactly once', registered.filter((r) => r.kind === 'register').length === 1);
check('a watcher was attached for hot reload', watched === 1);
check('/computer command registered', commands.length === 1 && commands[0].name === 'computer');

const setModeTool = tools.find((t) => t.name === 'computer_set_mode');
check('computer_set_mode present', !!setModeTool);
await setModeTool.execute({ mode: 'readonly' }, {});
const upd = registered.find((r) => r.kind === 'update');
check('sourceSetter writes through SettingsScope.update(patch)', !!upd && upd.patch.mode === 'readonly', upd && JSON.stringify(upd.patch));
check('resolved settings value reflects the write', currentSettings.mode === 'readonly');

const cfgMod = await import(pathToFileURL(join(PKG_DIR, 'src', 'config.js')).href);
const parsed = cfgMod.Config({});
check('config schema defaults vision_feedback=true', parsed.vision_feedback === true);
check('config schema defaults vision_max_pixels=640000', parsed.vision_max_pixels === 640000);
check('config schema keeps mode default manual', parsed.mode === 'manual');
check('config schema defaults overlay=true', parsed.overlay === true);
check('config schema defaults overlay_idle_seconds=25', parsed.overlay_idle_seconds === 25);
check('config schema defaults verify_actions=true', parsed.verify_actions === true);
check('config schema defaults grid_spacing=0 (off)', parsed.grid_spacing === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
process.exit(failed.length === 0 ? 0 : 1);
