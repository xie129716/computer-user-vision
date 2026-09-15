/**
 * Shared path resolution for the verification scripts.
 *
 * Nothing here may hard-code a user name or drive letter: the suite has to run
 * on any machine that has a `web` profile. Override with DSH_PROFILE when the
 * profile lives elsewhere or is named differently.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The DSH profile directory under test. */
export const PROFILE = process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web');

/** The installed plugin inside that profile. */
export const PKG_DIR = join(PROFILE, 'node_modules', 'computer-user-vision');

/** The self-healing doctor script inside the installed plugin. */
export const DOCTOR = join(PKG_DIR, 'tools', 'computer-user-vision-doctor.mjs');
