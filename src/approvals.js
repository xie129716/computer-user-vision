/**
 * computer-user / approval store.
 *
 * `/computer` used to grant approval in a module-level Set, which meant the
 * grant evaporated on every host restart and had to be re-typed for each new
 * conversation. This keeps the same grant, but on disk.
 *
 * Two scopes are supported, chosen by the `approval_scope` setting:
 *   session - approve one conversation (the default; still survives restarts)
 *   profile - approve once for every conversation, until revoked
 *
 * The file lives beside the DSH home so it belongs to the installation rather
 * than to any profile's node_modules. It holds only session ids and a boolean:
 * no transcripts, no paths, nothing derived from the screen.
 *
 * @module computer-user/approvals
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const FILE_NAME = 'computer-user-approvals.json';

function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

export function createApprovalStore({ logger } = {}) {
  const file = join(resolveHome(), FILE_NAME);
  const state = { version: 1, profileTrusted: false, sessions: [] };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      state.profileTrusted = parsed.profileTrusted === true;
      if (Array.isArray(parsed.sessions)) {
        state.sessions = parsed.sessions.filter((id) => typeof id === 'string' && id.length > 0);
      }
    }
  } catch {
    // Absent or unreadable: a first run is not an error, it just starts clean.
  }

  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      logger?.warn?.(`[computer-user] could not persist approvals: ${String(error?.message ?? error)}`);
    }
  }

  return {
    /** Absolute path of the approval document, for diagnostics. */
    file,
    isProfileTrusted: () => state.profileTrusted === true,
    sessions: () => [...state.sessions],
    /** Whether this session may act: a profile grant covers every session. */
    isApproved(sessionId) {
      if (state.profileTrusted === true) return true;
      return typeof sessionId === 'string' && sessionId.length > 0 && state.sessions.includes(sessionId);
    },
    setProfileTrusted(value) {
      state.profileTrusted = value === true;
      persist();
    },
    addSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;
      if (state.sessions.includes(sessionId)) return;
      state.sessions.push(sessionId);
      persist();
    },
    removeSession(sessionId) {
      const index = state.sessions.indexOf(sessionId);
      if (index < 0) return;
      state.sessions.splice(index, 1);
      persist();
    },
    /** Forget everything - used when the user revokes a profile-wide grant. */
    clear() {
      state.profileTrusted = false;
      state.sessions = [];
      persist();
    },
  };
}

export default createApprovalStore;
