/**
 * computer-user / overlay lifecycle.
 *
 * Owns the Codex-style "an agent is driving this computer" indicator: a separate
 * PowerShell process that draws the pulsing edge frame, the cursor halo and the
 * top banner with its Cancel button and global hotkey.
 *
 * The contract with that process is two files in the OS temp directory:
 *   heartbeat  - rewritten on every tool call; the overlay exits itself once it
 *                goes stale, so a crashed host can never leave a stuck overlay
 *   stop       - written ONLY by the user (button or hotkey); its contents name
 *                the reason, which the mode gate turns into a hard refusal until
 *                the user re-approves
 *
 * @module computer-user/overlay
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { powerShellScript } from './ps.js';

/** Human-readable name for a stop reason recorded by the overlay. */
const STOP_LABELS = {
  button: '点击「停止控制」按钮',
  hotkey: '按下 Ctrl+Alt+Esc',
  external: '外部停止信号',
};

export function createOverlayController({ getConfig, logger } = {}) {
  const dir = join(tmpdir(), 'computer-user');
  const heartbeatPath = join(dir, 'overlay-heartbeat');
  const stopPath = join(dir, 'overlay-stop');

  let child = null;
  let lastSpawnFailure = null;

  const warn = (message) => logger?.warn?.(`[computer-user] overlay: ${message}`);

  const enabled = () => (getConfig?.() ?? {}).overlay !== false;

  /** The reason a user stopped control, or null when nothing stopped it. */
  function stopReason() {
    try {
      if (!existsSync(stopPath)) return null;
      const raw = readFileSync(stopPath, 'utf8').trim();
      return raw.length > 0 ? raw : 'external';
    } catch {
      return null;
    }
  }

  /** Human-readable form of {@link stopReason}. */
  const stopLabel = () => {
    const reason = stopReason();
    if (reason === null) return null;
    return STOP_LABELS[reason] ?? reason;
  };

  function clearStop() {
    try { rmSync(stopPath, { force: true }); } catch { /* best effort */ }
  }

  function touch() {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(heartbeatPath, String(Date.now()), 'utf8');
    } catch { /* best effort: a missed beat only shortens the overlay's life */ }
  }

  /** Start the indicator if it should be up and is not already running. */
  function ensure() {
    if (!enabled()) return;
    if (stopReason() !== null) return; // the user stopped: stay down
    if (child !== null && child.exitCode === null) return;
    try {
      mkdirSync(dir, { recursive: true });
      rmSync(stopPath, { force: true });
      touch();

      const cfg = getConfig?.() ?? {};
      const payload = {
        heartbeatFile: heartbeatPath,
        stopFile: stopPath,
        label: (cfg.overlay_label ?? '').trim() || 'DeepSeek 正在控制电脑',
        stopLabel: (cfg.overlay_stop_label ?? '').trim() || '停止控制',
        hint: 'Ctrl+Alt+Esc',
        accentA: (cfg.overlay_accent_a ?? '').trim() || '#4D6BFE',
        accentB: (cfg.overlay_accent_b ?? '').trim() || '#22D3EE',
        thickness: 7,
        idleSeconds: Math.max(5, Number(cfg.overlay_idle_seconds) || 25),
        hotkeyMods: 3, // MOD_ALT | MOD_CONTROL
        hotkeyVk: 27,  // VK_ESCAPE
      };
      const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      // NOT detached: on Windows the DETACHED_PROCESS flag this sets makes the
      // GUI process exit immediately, so the indicator never appears. The child
      // still outlives the host because Windows does not reap children with
      // their parent - and the heartbeat closes it if the host dies.
      const probing = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', powerShellScript('overlay.ps1'), '-Json', b64,
      ], { stdio: 'ignore', windowsHide: true });

      probing.on('error', (error) => {
        lastSpawnFailure = String(error?.message ?? error);
        warn(`could not start the indicator: ${lastSpawnFailure}`);
        child = null;
      });
      probing.on('exit', (code) => {
        child = null;
        if (code !== 0 && code !== null) {
          lastSpawnFailure = `exit code ${code}`;
          warn(`indicator exited with code ${code}`);
        }
      });
      probing.unref();
      child = probing;
    } catch (error) {
      lastSpawnFailure = String(error?.message ?? error);
      warn(`could not start the indicator: ${lastSpawnFailure}`);
      child = null;
    }
  }

  /** Record activity: start the indicator and refresh its liveness beat. */
  function activity() {
    if (!enabled()) return;
    ensure();
    touch();
  }

  /** Stop the indicator process; `purge` also forgets any stop marker. */
  function shutdown({ purge = false } = {}) {
    try {
      if (child !== null && child.exitCode === null) child.kill();
    } catch { /* already gone */ }
    child = null;
    try { rmSync(heartbeatPath, { force: true }); } catch { /* best effort */ }
    if (purge) clearStop();
  }

  return {
    activity,
    ensure,
    touch,
    shutdown,
    stopReason,
    stopLabel,
    clearStop,
    get failure() { return lastSpawnFailure; },
  };
}

export default createOverlayController;
