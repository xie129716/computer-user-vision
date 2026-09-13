#!/usr/bin/env node
/**
 * Prepare — and optionally open — the awesome-dsh-plugin submission PR.
 *
 * The upstream list is huge (thousands of entry files), so this never clones it:
 * it forks, then builds one commit containing one added file through the Git
 * Data API. That also makes it idempotent — re-running it after the 24-hour
 * repository-age gate has passed is the intended workflow.
 *
 *   node tools/open-awesome-pr.mjs           # prepare the branch, print the compare URL
 *   node tools/open-awesome-pr.mjs --open    # also open the PR
 *
 * Why the two modes: awesome-dsh-plugin's CI refuses any repository younger than
 * one day (scripts/check-submission.mjs, MIN_AGE_DAYS = 1). Opening the PR before
 * that just paints a red X on a submission that is otherwise complete, and their
 * contributing guide asks you to wait. Prepare now, `--open` later.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const OWNER = 'xie129716';
const FORK = `${OWNER}/awesome-dsh-plugin`;
const PLUGIN = 'computer-user-vision';
const ENTRY_PATH = `data/plugins/${OWNER}__${PLUGIN}.yml`;
const BRANCH = `add/${OWNER}__${PLUGIN}`;
const GH = join(process.env.USERPROFILE ?? '', '.workbuddy', 'binaries', 'gh', 'bin', 'gh.exe');

const REPO_URL = `https://github.com/${OWNER}/${PLUGIN}`;
const TARBALL = `${REPO_URL}/releases/latest/download/computer-user.tgz`;

/** The one file this PR adds. A description containing ": " must be quoted. */
const ENTRY = `url: ${REPO_URL}
name: ${OWNER}/${PLUGIN}
category: tools
tarball: ${TARBALL}
description:
  en: 'Windows desktop control (12 tools) for a fork of computer-user: vision-native screenshots, a control indicator with a user stop, and a pre-flight focus guard.'
  zh: 'computer-use 分叉的 Windows 桌面操控（12 个工具）：视觉原生截图、带用户停止的控制指示器，以及前置焦点校验。'
`;

const TITLE = `Add ${OWNER}/${PLUGIN}`;

const BODY = `Adds one entry for \`${OWNER}/${PLUGIN}\` under \`tools\`.

**What it is.** A Windows desktop-control plugin: it reads the screen and drives the mouse and
keyboard. The screenshot rides the tool result as a real image block together with a
\`screen_per_pixel\` mapping, so an image-capable model looks at the screen and clicks real
coordinates; a text-only route falls back to a PNG path. 12 \`computer_*\` tools.

**It is an unofficial fork** of [jing-hy/computer-user](https://github.com/jing-hy/computer-user)
(MIT; the copyright notice travels with the code in \`LICENSE\`). Upstream no longer loads on current
DSH — a named export that no longer exists fails the whole ES module — and it only knew how to be
looked at through an external OCR tool. What this fork adds, all of it in the repository:

- **Pre-flight focus guard.** Every input tool takes an optional \`expect_window\`; on a mismatch
  it refuses *without sending any input* and returns the window it found. Reporting
  \`focused_window\` only *after* typing is a post-mortem — during acceptance a \`Ctrl+H\` meant for
  Notepad landed in the browser that way.
- **A control indicator with a real stop.** A pulsing frame, a cursor halo, and a top banner with a
  Stop button and a \`Ctrl+Alt+Esc\` global hotkey. Either writes a marker that turns into a hard
  refusal of every \`computer_*\` call until the user re-approves; a new user message, \`/computer\`,
  or the chat switch each lift it.
- **A mode gate and disk-backed approval** (\`disabled / readonly / manual / auto\`), so control is
  revocable and survives a host restart.

**On "do its dependencies point at the original".** That rule governs bundles, and this is not one: it
ships behaviour, and it has **no \`dependencies\` at all** — the only entries are \`peerDependencies\` on
the harness's own \`@deepseek-ai/*\` packages, so nothing here resolves to a copy of anyone's work. The
fork relationship is stated where identity is actually read: \`description\`, \`author\`, an explicit
\`forkedFrom\` field, the first line of the README, and \`repository\` — which points at this repository,
not upstream.

Two things in the same spirit, flagged rather than left to be found:

- This repository is **not** a GitHub fork (\`fork: false\`, no \`parent\`). It was built from the
  published 0.3.6 tarball rather than from a clone, and GitHub sets fork status only at creation, so
  it cannot be added afterwards.
- The package name is still \`computer-user\`, deliberately: \`cordis.patch.yml\` registers the plugin
  under that specifier, so a profile can drop this fork in exactly where the original sat. Renaming
  it would break that.

**Not a duplicate of the existing computer-use entry.** \`qphotoai/dsh-computer-use-windows\` is a
different implementation (UIA + cua-driver + optional GLM vision). This one is PowerShell/SendInput
with vision-native captures and a user-visible stop. Per the review rules, whoever is better kept
keeps the slot — flagging the overlap so you can judge it rather than discover it.

**Checks I ran before submitting.**
- \`dsh.bundle\` is declared in the root \`package.json\` with a \`cordis.patch.yml\` beside it.
- \`screenshots.json\` at the repository root lists 4 relative paths; all exist and stay inside the
  plugin directory.
- The \`tarball\` asset name is version-free, and
  \`releases/latest/download/computer-user.tgz\` returns HTTP 200 (verified), so it will not 404 on
  the next release.
- Official packages are \`peerDependencies\`, with an explicit prerelease branch per tuple:
  \`>=0.1.0-rc.6 <0.1.5-0 || >=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0\`. The previous
  \`>=0.1.0-rc.6\` silently excluded \`0.1.5-rc.2\`, the build actually shipping — verified with
  node-semver, not by eye.
`;

const env = {
  ...process.env,
  HTTP_PROXY: 'http://127.0.0.1:8800',
  HTTPS_PROXY: 'http://127.0.0.1:8800',
  NO_PROXY: '127.0.0.1,localhost',
};

const gh = (args, body) => {
  const out = execFileSync(GH, args, {
    env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    // stderr ignored: the existence probes below are EXPECTED to 404, and gh
    // prints "gh: Not Found (HTTP 404)" for each one. Letting that through looks
    // like the script failed when it did exactly what it meant to.
    stdio: ['pipe', 'pipe', 'ignore'],
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  return out.trim() ? JSON.parse(out) : null;
};
const ghQuiet = (args) => {
  try { return gh(args); } catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureFork() {
  const existing = ghQuiet(['api', `repos/${FORK}`]);
  if (existing && !existing.parent?.full_name?.startsWith('__')) return existing;
  console.log(`forking ${UPSTREAM} -> ${FORK} ...`);
  ghQuiet(['api', '--method', 'POST', `repos/${UPSTREAM}/forks`, '--input', '-'], {});
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    const fork = ghQuiet(['api', `repos/${FORK}`]);
    if (fork) return fork;
  }
  throw new Error(`fork ${FORK} did not appear; check ${UPSTREAM}/forks`);
}

async function main() {
  const open = process.argv.includes('--open');

  await ensureFork();
  const parent = gh(['api', `repos/${UPSTREAM}/git/ref/heads/main`]);
  const base = parent.object.sha;
  console.log(`upstream main : ${base.slice(0, 8)}`);

  const unencoded = Buffer.from(ENTRY, 'utf8');
  const blob = gh(['api', '--method', 'POST', `repos/${FORK}/git/blobs`, '--input', '-'],
    { content: unencoded.toString('base64'), encoding: 'base64' });
  const tree = gh(['api', '--method', 'POST', `repos/${FORK}/git/trees`, '--input', '-'],
    { base_tree: base, tree: [{ path: ENTRY_PATH, mode: '100644', type: 'blob', sha: blob.sha }] });
  const commit = gh(['api', '--method', 'POST', `repos/${FORK}/git/commits`, '--input', '-'],
    { message: `${TITLE}\n\nOne entry, ${ENTRY_PATH}.`, tree: tree.sha, parents: [base] });

  const ref = `refs/heads/${BRANCH}`;
  let mode;
  try {
    gh(['api', '--method', 'POST', `repos/${FORK}/git/refs`, '--input', '-'], { ref, sha: commit.sha });
    mode = 'created';
  } catch {
    // The branch already exists from an earlier run, so move it. Probing for it
    // first is a trap: GET /git/ref/{ref} wants `heads/<branch>`, and passing
    // `refs/heads/<branch>` 404s — which reads as "missing", so the create then
    // fails with 422 and a re-run stops being safe.
    gh(['api', '--method', 'PATCH', `repos/${FORK}/git/refs/heads/${BRANCH}`, '--input', '-'],
      { sha: commit.sha, force: true });
    mode = 'updated';
  }
  console.log(`branch ${mode} : ${BRANCH} -> ${commit.sha.slice(0, 8)}`);

  const compare = `https://github.com/${UPSTREAM}/compare/main...${OWNER}:${FORK.split('/')[1]}:${BRANCH}?expand=1`;
  console.log(`\nfile   : ${ENTRY_PATH}`);
  console.log(`compare: ${compare}`);

  if (!open) {
    console.log('\nprepared only. Run again with --open once the repository is 1 day old:');
    console.log('  node tools/open-awesome-pr.mjs --open');
    return 0;
  }

  const pr = gh(['api', '--method', 'POST', `repos/${UPSTREAM}/pulls`, '--input', '-'],
    { title: TITLE, head: `${OWNER}:${BRANCH}`, base: 'main', body: BODY, draft: true });
  console.log(`\nopened draft PR #${pr.number}: ${pr.html_url}`);
  return 0;
}

process.exit(await main());
