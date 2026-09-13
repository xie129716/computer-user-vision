/**
 * computer-user — Codex-style computer use for DeepSeek Harness (DSH).
 *
 * Reads the screen (computer_screenshot → PNG path) and drives the mouse &
 * keyboard (click / type / keypress / scroll / drag / move_mouse / wait /
 * get_cursor_position) via bundled PowerShell scripts using Win32 SendInput —
 * zero native dependencies, so it works in the same Node host that runs the
 * EAC desktop profile (same pattern as picturereader's Windows OCR).
 *
 * Pairs with an image-capable model (e.g. DeepSeek-V41-Flash): the screenshot is
 * attached to the tool result as a real image block, so the model looks at the
 * screen directly and the look → act → verify loop closes with no external
 * image reader. On a text-only route it degrades to returning a file path for
 * an external scanner (picturereader image_scan / image_ocr).
 *
 * Settings (namespace `computer-user`, hot-reloaded via a runtime snapshot):
 *   mode — disabled / readonly / manual / auto
 *   screenshot_dir / default_scale / typing_interval_ms / scroll_units / debug
 *
 * @module computer-user
 */

import * as settingsModule from '@deepseek-ai/dsh-settings';
import { NS, Config } from './config.js';
import { createComputerTools } from './tools.js';
import { runPs, powerShellScript } from './ps.js';
import { createOutputGuard } from './output-guard.js';
import { createOverlayController } from './overlay.js';
import { createApprovalStore } from './approvals.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

export const name = 'computer-user';
export const version = '0.3.0';

/** Services required at runtime. */
export const inject = ['tools'];

/** In-memory set of session IDs that have been approved via /computer. */
const approvedSessions = new Set();

/**
 * Settings API compatibility.
 *
 * `@deepseek-ai/dsh-settings` dropped its module-level `settingsNamespace()`
 * helper (present through rc.7, gone in the 0.1.5 line): the namespace is now
 * the plain string handed to `provider.register()`. Importing that helper by
 * name made the whole module fail to load once the export disappeared — which
 * silently took every computer_* tool, the settings card, and /computer down
 * with it. Import the module namespace instead and feature-detect, the same way
 * dsh-imagegen bridges the two API generations.
 * @param {string} value - the namespace name.
 * @returns {string} the branded namespace where the helper exists, else the name.
 */
function settingsNamespaceCompat(value) {
  return settingsModule.settingsNamespace?.(value) ?? value;
}

let sourceGetter = null;
let sourceSetter = null;
const getConfig = () => (sourceGetter ? sourceGetter() : undefined);

/** Persist the runtime mode (used by computer_set_mode + /computer manual mode). */
async function setMode(mode) {
  if (typeof sourceSetter !== 'function') throw new Error('computer-user: 设置服务不可用');
  await sourceSetter('mode', mode);
}

/**
 * Resolve the session-target set affected by /computer from a command
 * invocation: agent.id (SessionId) + session.header.sessionId, falling back
 * to '__global__' when neither is present.
 * @param {object} invocation
 * @returns {Set<string>}
 */
export function sessionTargetsFromInvocation(invocation) {
  const targets = new Set();
  try {
    if (invocation?.agent?.id) targets.add(String(invocation.agent.id));
    if (invocation?.agent?.session?.header?.sessionId) targets.add(String(invocation.agent.session.header.sessionId));
  } catch { /* ignore */ }
  if (targets.size === 0) targets.add('__global__');
  return targets;
}

/**
 * Toggle approval for a set of session targets: if any target is already
 * approved, revoke them all; otherwise approve them all.
 * @param {Set<string>} approvedSessions
 * @param {Set<string>} targets
 * @returns {{approved:boolean, targets:Set<string>}}
 */
export function toggleApproval(approvedSessions, targets) {
  const approved = [...targets].some((t) => approvedSessions.has(t));
  if (approved) {
    for (const t of targets) approvedSessions.delete(t);
    return { approved: false, targets };
  }
  for (const t of targets) approvedSessions.add(t);
  return { approved: true, targets };
}

export function apply(ctx, config) {
  // ── control indicator ──
  // Owned here rather than in the tools because its lifetime is the plugin's:
  // it must come up when the agent actually holds control and go away on unload.
  const overlay = createOverlayController({ getConfig, logger: ctx.logger });
  // Approvals live on disk: an in-memory Set meant re-typing /computer after
  // every host restart, and again for every new conversation.
  const approvals = createApprovalStore({ logger: ctx.logger });
  const controlState = {
    stopLabel: () => overlay.stopLabel(),
    clearStop: () => overlay.clearStop(),
    pauseForCapture: () => overlay.pauseForCapture(),
    resumeAfterCapture: () => overlay.resumeAfterCapture(),
    isApproved: (sid) => approvals.isApproved(sid),
  };

  /** Whether this session may act, i.e. whether the indicator belongs on screen. */
  const controlActive = (exec) => {
    const cfg = getConfig() ?? {};
    if (cfg.mode === 'disabled' || cfg.mode === 'readonly') return false;
    if (cfg.mode === 'auto') return true;
    const sid = exec?.agent?.session?.header?.sessionId ?? exec?.sessionId ?? '';
    return approvals.isApproved(sid);
  };

  ctx.effect(() => () => overlay.shutdown({ purge: true }), 'computer-user: control indicator');

  // ── register tools ──
  ctx.effect(() => {
    for (const tool of createComputerTools({ runPs, getConfig, approvedSessions, sessionId: undefined, setMode, ctx, controlState })) {
      ctx.tools.register({
        ...tool,
        // Wrap execute to inject the current session ID at call time
        async execute(args, exec) {
          const sid = exec?.agent?.session?.header?.sessionId ?? exec?.sessionId ?? '';
          // Rebuild gate closure with the real session ID
          const tools = createComputerTools({ runPs, getConfig, approvedSessions, sessionId: sid, setMode, ctx, controlState });
          const realTool = tools.find((t) => t.name === tool.name);
          // Raise (and keep alive) the indicator only while control is real.
          if (controlActive(exec)) overlay.activity();
          return realTool.execute(args, exec);
        },
      });
    }
  });

  // ── settings namespace (hot reload) ──
  try {
    ctx.inject(['settings'], (sctx) => {
      const provider = sctx.get?.('settings') ?? sctx.settings;
      if (!provider || typeof provider.register !== 'function') {
        throw new Error('settings service exposes no register()');
      }
      const scope = provider.register(settingsNamespaceCompat(NS), Config, { base: config });
      sourceGetter = () => scope.get();
      // 0.1.5 line: SettingsScope.update(patch) is the write path (no scope.set).
      sourceSetter = (key, value) => (
        typeof scope.update === 'function'
          ? scope.update({ [key]: value })
          : scope.set(key, value)
      );
      scope.watch(() => { /* trigger hot reload */ });
      ctx.logger?.info?.(`[computer-user] settings namespace "${NS}" registered`);
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] settings disabled: ${String(error?.message ?? error)}`);
    sourceGetter = () => ({ ...config, mode: config?.mode ?? 'manual' });
  }

  // A trace file rather than ctx.logger: logger is not guaranteed to exist here,
  // so `ctx.logger?.warn?.()` fails SILENTLY - which is exactly how the first
  // attempt at this route vanished without leaving a single line behind.
  const routeTrace = (message) => {
    try {
      const dir = joinPath(tmpdir(), 'computer-user');
      mkdirSync(dir, { recursive: true });
      appendFileSync(joinPath(dir, 'route.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch { /* diagnostics must never break the plugin */ }
  };
  routeTrace('route block entered');

  // ── control switch route (the chat-input toggle) ──
  // One on/off switch for beginners: flipping it on does what /computer does,
  // silently. It maps to the run mode rather than to a per-session grant, so the
  // client never needs to know which conversation is on screen.
  //
  // Reaching the server: dsh-imagegen calls `ctx.webServer` from inside an
  // injected effect rather than injecting 'webServer' itself, so this mirrors
  // that known-good pattern.
  try {
    ctx.inject(['settings'], (sctx) => {
      routeTrace('injected callback fired');
      // ctx.get() is the SAFE accessor. Plain property access on a cordis
      // context THROWS for a service the plugin did not declare in `inject`,
      // and an exception thrown inside this deferred callback is swallowed by
      // the loader - which is why the previous attempt logged "callback fired"
      // and then nothing at all, with no error anywhere.
      let webServer;
      try { webServer = ctx.get('webServer') ?? sctx.get('webServer'); }
      catch (error) { routeTrace(`webServer lookup threw: ${String(error?.message ?? error)}`); }
      if (!webServer || typeof webServer.register !== 'function') {
        routeTrace(`route NOT registered: webServer unavailable (${typeof webServer})`);
        return;
      }
      const writeJson = (res, status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      };
      const isLoopback = (req) => {
        const address = req.socket?.remoteAddress ?? '';
        return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
      };
      const snapshot = () => {
        const cfg = getConfig() ?? {};
        const mode = cfg.mode ?? 'manual';
        return {
          mode,
          enabled: mode !== 'disabled',
          actionable: mode === 'auto' || approvals.isProfileTrusted(),
          profileTrusted: approvals.isProfileTrusted(),
          approvalScope: cfg.approval_scope ?? 'session',
          overlayRunning: overlay.isRunning(),
          stopped: overlay.stopLabel(),
        };
      };

      try {
        sctx.effect(() => webServer.register({
          kind: 'exact',
          path: '/computer-user/control',
          handler: async (req, res) => {
            if (!isLoopback(req)) { writeJson(res, 403, { error: 'loopback only' }); return; }
            if (req.method === 'GET') { writeJson(res, 200, snapshot()); return; }
            if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return; }

            let raw = '';
            await new Promise((resolve) => {
              req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
              req.on('end', resolve);
            });
            let enabled = true;
            try { enabled = JSON.parse(raw || '{}').enabled !== false; }
            catch { writeJson(res, 400, { error: 'bad json' }); return; }

            try {
              if (enabled) {
                // Exactly what /computer grants, minus the typing: a profile-wide
                // approval, no stop in force, and a mode needing no approval.
                approvals.setProfileTrusted(true);
                overlay.clearStop();
                await setMode('auto');
              } else {
                approvals.setProfileTrusted(false);
                await setMode('disabled');
                overlay.shutdown();
              }
            } catch (error) {
              routeTrace(`toggle failed: ${String(error?.message ?? error)}`);
              writeJson(res, 500, { error: String(error?.message ?? error) });
              return;
            }
            writeJson(res, 200, { ok: true, ...snapshot() });
          },
        }), 'computer-user: control switch route');
        routeTrace('route registered at /computer-user/control');
      } catch (error) {
        routeTrace(`route registration THREW: ${String(error?.message ?? error)}`);
      }
    });
  } catch (error) {
    routeTrace(`inject threw: ${String(error?.message ?? error)}`);
  }

  // ── /computer command for session approval ──
  try {
    ctx.inject(['commands'], (sctx) => {
      sctx.commands.register({
        name: 'computer',
        description: '批准当前会话使用 computer-user 的全部工具（手动批准模式下需要）',
        handler: async (invocation) => {
          // /computer 是开关：按一次批准，再按一次撤销。
          const targets = sessionTargetsFromInvocation(invocation);
          const ids = [...targets].join(', ');
          const scope = getConfig()?.approval_scope === 'profile' ? 'profile' : 'session';

          if (scope === 'profile') {
            // One grant covering every conversation, remembered on disk so a
            // restart does not silently take the computer away again.
            const next = !approvals.isProfileTrusted();
            approvals.setProfileTrusted(next);
            if (next) overlay.clearStop();
            return next
              ? {
                  kind: 'success',
                  text:
                    '✅ 已批准（长期，所有会话生效）：computer-user 全部工具可用，已写入磁盘，宿主重启后仍保留。'
                    + '\n再按一次 /computer 可撤销。'
                    + `\n批准文件：${approvals.file}`,
                }
              : { kind: 'success', text: '🔒 已撤销长期批准：所有会话恢复为需要批准，请重新按 /computer 授权。' };
          }

          // Session scope: toggle this conversation's grant, persisted so a host
          // restart keeps it. New conversations still start unapproved.
          const { approved } = toggleApproval(approvedSessions, targets);
          for (const id of targets) {
            if (approved) approvals.addSession(id);
            else approvals.removeSession(id);
          }
          // Approving is also how a user lifts a stop they triggered from the
          // indicator's button or hotkey.
          if (approved) overlay.clearStop();
          return approved
            ? {
                kind: 'success',
                text:
                  `✅ 已批准：computer-user 全部工具在本会话（${ids}）持续可用，本会话后续轮次无需重复授权，宿主重启后也保留。`
                  + '\n新对话需要重新按一次；若想一次批准所有会话，把「批准范围」设为 profile。'
                  + '\n再按一次 /computer 可撤销。',
              }
            : { kind: 'success', text: `🔒 已撤销批准：本会话（${ids}）的有副作用工具需重新 /computer 批准。` };
        },
      });
      ctx.logger?.info?.('[computer-user] /computer command registered');
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] commands service not available: ${String(error?.message ?? error)}`);
  }

  // ── LLM output guard: strip fake tool-call text written as conversation ──
  //     text; first occurrence replaced with a coaching note, second chance
  //     (same fingerprint) passes through. Off when output_guard=false.
  try {
    ctx.inject(['llm'], (sctx) => {
      const llm = sctx.llm;
      if (!llm || typeof llm.listProviders !== 'function') return;
      const wrapProviders = () => {
        let wrapped = 0;
        for (const provider of llm.listProviders()) {
          let reg;
          try { reg = llm.registration(provider); } catch { continue; }
          if (!reg || !reg.adapter) continue;
          if (reg.adapter?.__cuOutputGuard) continue;
          const orig = reg.adapter;
          const origStream = orig.stream.bind(orig);
          const guardProxy = new Proxy(orig, {
            get(target, prop, receiver) {
              if (prop === 'stream') {
                return async function* (options) {
                  const cfg = getConfig();
                  if (cfg && cfg.output_guard === false) { yield* origStream(options); return; }
                  const guard = createOutputGuard({ allowAfter: 2 });
                  let noteShown = false;
                  for await (const chunk of origStream(options)) {
                    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                      const decision = guard.sniff(chunk.text);
                      if (decision.kind === 'reject') {
                        if (!noteShown) {
                          noteShown = true;
                          yield { ...chunk, text: decision.note };
                        }
                        continue; // drop the polluted delta
                      }
                      // pass / pass-second → forward the original delta
                    }
                    yield chunk;
                  }
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          Object.defineProperty(guardProxy, '__cuOutputGuard', { value: true, enumerable: false, configurable: true });
          reg.adapter = guardProxy;
          wrapped++;
        }
        if (wrapped > 0) ctx.logger?.info?.(`[computer-user] output guard active on ${wrapped} provider(s)`);
      };
      wrapProviders();
      // re-wrap if providers register later (best-effort; ignore failures)
      if (typeof llm.on === 'function') {
        try { llm.on('provider/register', () => { try { wrapProviders(); } catch { /* ignore */ } }); } catch { /* ignore */ }
      }
    });
  } catch (error) {
    ctx.logger?.warn?.(`[computer-user] output guard unavailable: ${String(error?.message ?? error)}`);
  }

  // ── debug helper ──
  if (config?.debug) {
    ctx.logger?.info?.(`[computer-user] scripts: ${powerShellScript('capture.ps1')}, ${powerShellScript('input.ps1')}`);
  }
}

export default { name, version, inject, apply };
