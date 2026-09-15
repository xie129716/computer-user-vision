#!/usr/bin/env node
/**
 * Prepare — and optionally open — the awesome-dsh-plugin submission PR.
 *
 * Repository housekeeping, not part of the plugin: it lives in `contrib/`, which
 * is deliberately absent from `package.json#files`, so nothing here ships to a
 * user who installs the plugin.
 *
 * The upstream list is huge (thousands of entry files), so this never clones it:
 * it forks, then builds one commit containing one added file through the Git
 * Data API. That also makes it idempotent — re-running it after the 24-hour
 * repository-age gate has passed is the intended workflow.
 *
 *   node contrib/open-awesome-pr.mjs           # prepare the branch, print the compare URL
 *   node contrib/open-awesome-pr.mjs --open    # also open the PR (ready for review)
 *   node contrib/open-awesome-pr.mjs --open --draft   # open it as a draft instead
 *
 * Needs an authenticated `gh`. If github.com needs a proxy on your machine,
 * export HTTPS_PROXY first — this script inherits the environment and never
 * overrides it.
 *
 * Why the two modes: awesome-dsh-plugin's CI refuses any repository younger than
 * one day (scripts/check-submission.mjs, MIN_AGE_DAYS = 1). Opening the PR before
 * that just paints a red X on a submission that is otherwise complete, and their
 * contributing guide asks you to wait. Prepare now, `--open` later.
 *
 * Why ready-for-review is the default rather than a draft: a draft is still a
 * `pull_request` event, so pr-check.yml/pr-gate.yml do run — but pr-guard.yml,
 * regate.yml and held-rescan.yml all skip drafts (`if (pr.isDraft) continue`), so
 * a draft also opts out of the scheduled re-gate and rescan bookkeeping. The age
 * bar is a one-time gate and this submission is past it, so a draft would only
 * delay the review. `--draft` is still there for when only CI is wanted.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Locate the `gh` CLI.
 *
 * `gh` from PATH first, then the copy DSH happens to bundle — a hard-coded path
 * only ever works on the machine it was written on, and this repository is meant
 * to be usable from a clone on someone else's.
 */
function resolveGh() {
  const candidates = ['gh'];
  if (process.env.USERPROFILE) {
    candidates.push(join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'gh', 'bin', 'gh.exe'));
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* not this one */ }
  }
  console.error('gh CLI not found. Install https://cli.github.com and run `gh auth login` first.');
  process.exit(1);
}

const UPSTREAM = 'awesome-dsh-plugin/awesome-dsh-plugin';
const OWNER = 'xie129716';
const FORK = `${OWNER}/awesome-dsh-plugin`;
const PLUGIN = 'computer-user-vision';
const ENTRY_PATH = `data/plugins/${OWNER}__${PLUGIN}.yml`;
const BRANCH = `add/${OWNER}__${PLUGIN}`;
const GH = resolveGh();

const REPO_URL = `https://github.com/${OWNER}/${PLUGIN}`;
const TARBALL = `${REPO_URL}/releases/latest/download/computer-user.tgz`;

/**
 * The one file this PR adds.
 *
 * Every clause is a claim the reviewer can check against the code, which is what
 * the guide asks for — and why there are no adjectives here: "13 computer_* tools"
 * is countable, `expect_window` and `Ctrl+Alt+Esc` are greppable, and
 * "vision-native" would only have been a word. A description containing ": "
 * must be quoted.
 *
 * The image capability leads, because it is the difference from upstream and the
 * only reason the repository is called what it is: upstream had to be looked at
 * through an external OCR tool, this one hands the picture to the model's own
 * image input. An earlier revision of this line described only the element refs
 * and dropped that — the reviewer would never have seen the upgrade.
 *
 * Length is deliberate as well. The list's own entries run 182 characters at the
 * median and 314 at the 90th percentile; this line is 304, so the vision clause
 * cost nothing — it replaced the longer "rather than a pixel estimated from a
 * downscaled screenshot" phrasing. Fewer clauses means fewer claims to verify.
 */
const ENTRY = `url: ${REPO_URL}
name: ${OWNER}/${PLUGIN}
category: tools
tarball: ${TARBALL}
description:
  en: 'Windows desktop control forked from computer-user: 13 computer_* tools. Image-capable routes get the screenshot as a real image with an exact image-to-screen mapping, so no external OCR; elements return as UI Automation refs so a click lands on the exact control rectangle; Ctrl+Alt+Esc stops every call.'
  zh: 'computer-user 分叉的 Windows 桌面操控插件：13 个 computer_* 工具。模型支持图像输入时截图直接作为图片返回，附精确的图像→屏幕映射，无需外接 OCR；控件以 UI Automation 引用返回，点击落在精确矩形上；Ctrl+Alt+Esc 可阻断所有调用。'
`;

const TITLE = `Add ${OWNER}/${PLUGIN}`;

const BODY = `Adds one entry for \`${OWNER}/${PLUGIN}\` under \`tools\`. It is an unofficial fork of
[jing-hy/computer-user](https://github.com/jing-hy/computer-user), **which is already on this list**
(\`data/plugins/jing-hy__computer-user.yml\`, also under \`tools\`). Please read the next section first —
that overlap is the decision this PR is asking for, not a detail underneath it.

## The slot question, first

This is not an addition beside that entry: the two cannot be installed together — same package name,
same cordis row id, stated just below — so one of them has to be the row. The review rules say a fork
*is* added when it is the better-kept one or when it genuinely adds something, and that "the rule is
not first-come; the rule is whichever is better". I am not asking you to take that on faith.

**Upstream does not load on the DSH that ships today.** Its \`src/index.js\` opens with

    import { settingsNamespace } from '@deepseek-ai/dsh-settings';

and \`@deepseek-ai/dsh-settings@0.1.5-rc.2\` exports exactly four names — \`SettingsConflictError\`,
\`SettingsProvider\`, \`default\`, \`redactSecrets\`. A missing named export fails the whole ES module at
link time, so \`apply()\` never runs: the plugin appears in \`dsh --dump-config\` and then does nothing,
with nothing in the boot log. Both halves are reproducible in about a minute:

    node -e "import('@deepseek-ai/dsh-settings').then(m=>console.log(Object.keys(m).sort().join(', ')))"
    # SettingsConflictError, SettingsProvider, default, redactSecrets   <- no settingsNamespace

    curl -s https://raw.githubusercontent.com/jing-hy/computer-user/main/src/index.js | head -3

The fork's fix is \`import * as settingsModule from '@deepseek-ai/dsh-settings'\` — a namespace import
cannot fail at link time on a missing name — commented at \`src/index.js:63\`, with the mechanism
written up in \`docs/adaptation-notes.md\`.

Maintenance points the same direction: upstream last pushed 2026-08-27; this fork 2026-09-14, 18
releases, 0.3.32 (upstream's npm tag is 0.3.6).

So the outcome I am asking for is either "list this one, and drop or annotate
\`jing-hy__computer-user.yml\`", or whichever form you would rather have. I maintain the fork, not
upstream, and the call is yours to make on the evidence above.

Why it is a binary choice rather than an addition: the package name is still \`computer-user\`, and
\`cordis.patch.yml\` registers cordis row id \`computer-user\` — deliberately, so a profile can drop this
fork in exactly where the original sat. A profile cannot hold both: one \`node_modules/computer-user\`,
one row id. Renaming would break the drop-in, which is why it is stated here rather than changed
quietly.

## What the fork adds, all of it in the repository

- **The screenshot goes to the model as an image — no external OCR step.** The tool asks the harness
  what the routed model accepts (\`ctx.llm.resolveModelInfo(provider, model)\`, then
  \`inputModalities.includes('image')\`) instead of trusting a manual switch or a guess; for
  \`deepseek-flash\` (DeepSeek-V41-Flash) that declaration includes \`image\`. On such a route the
  capture is saved through the host's \`attachments.saveImage()\` and rides the tool result as a real
  image block; on a text-only route it falls back to the PNG path and reports \`vision: false\`.
  Upstream had to be looked at through an external OCR tool because the model could not see the
  screen; this fork does not, so \`picturereader\` becomes a fallback rather than a requirement.
- **The coordinate mapping stays exact through the host's own downscale.** The capture is fitted to the
  adapter's declared \`imagePixelBudget\` (640,000 — the same \`DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET\`
  \`dsh-llm-deepseek\` sets for this model), so the server does not downscale a second time.
  \`screen_per_pixel\` then folds the capture's own crop/scale together with whatever normalization the
  host applied when saving, and the envelope prints the resulting formula for the model:
  \`screen_mapping: screen_x = vx + image_x * kx ; screen_y = vy + image_y * ky\`.
- **Element refs, so a click stops depending on a pixel estimate.** A 1920x1080 desktop is
  2,073,600 px, above the 640,000 px vision budget, so the preview a model reasons about is
  ~1045x588 — one image pixel is 1.84 screen pixels and a 22 px toolbar button is 12 px tall in
  that picture. \`computer_screenshot\` and the new \`computer_elements\` now enumerate the focused
  window's UI Automation controls and return refs; \`computer_click\` takes \`ref\` or \`name\` and
  the OS supplies the exact rectangle, so the measured click error is 0 px. Enumeration tests
  capability rather than control type, because a WinForms button reports as \`ControlType.Pane\`
  with no patterns at all.
- **Exact geometry, and honest geometry.** \`computer_list_windows\` returns the DWM extended frame
  bounds as \`rect\` — \`GetWindowRect\` is 8 px larger on every side (it includes the invisible
  resize border), which made every window-relative aim wrong by 8 px. Both values are reported.
- **One process per tool call.** Each PowerShell start costs ~380 ms of process creation plus
  \`Add-Type\` compilation, and a click used to spawn three or four of them (~1.1-1.5 s). The three
  one-shot scripts are merged into \`src/act.ps1\`; the focus check, ref resolution, the click and
  the probe now happen in the same process. Moves also use absolute \`SendInput\` over the virtual
  desktop and are verified before the click follows.
- **PerMonitorV2 DPI awareness.** \`powershell.exe\` starts DPI-*unaware*, so on a scaled display
  Windows virtualised every coordinate; the old scripts only reached System-aware.
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

## Two things to know before listing

**On "do its dependencies point at the original".** That rule governs bundles, and this is not one: it
ships behaviour, and it has **no \`dependencies\` at all** — the only entries are \`peerDependencies\` on
the harness's own \`@deepseek-ai/*\` packages, with an explicit prerelease branch per tuple:
\`>=0.1.0-rc.6 <0.1.5-0 || >=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0\`. Nothing here resolves to a
copy of anyone's work.

**The \`tarball:\` field is load-bearing, not cosmetic.** npm's \`computer-user\` is upstream's package
(\`repository\` -> \`jing-hy/computer-user\`), so anyone installing by that name gets upstream's code —
the version that does not load. The release tarball is the only install path for this fork, so please
keep the field. The corollary is expected rather than a defect: the npm-linkage rule will not attach a
download figure here, because npm's \`computer-user\` points at a different repository.

## Flagged rather than left to be found

- This repository is **not** a GitHub fork (\`fork: false\`, no \`parent\`). It was built from the
  published 0.3.6 tarball rather than from a clone, and GitHub sets fork status only at creation, so
  it cannot be added afterwards. The relationship is recorded in \`package.json\` instead: \`author\`,
  an explicit \`forkedFrom\`, and a \`repository\` pointing at this repository, with upstream's
  copyright line kept in \`LICENSE\` (MIT).
- \`screenshots.json\` declares 4 relative paths; all exist and stay inside the plugin directory, so
  the storefront has a stable source it can pick up on its next nightly build.

## Not a duplicate of the other computer-use entries

\`988hj7tczd-oss/dsh-computer-use\`, \`Anionex/dsh-computer-use\`,
\`qphotoai/dsh-computer-use-windows\`, \`Yu-tao-Li/dsh-computer-use-win\`, \`ZRui-C/dsh-computer-use\`,
\`JohnXu22786/computer-control\` and \`Fish121380/auto-mouse\` are separate implementations; this one is
PowerShell/SendInput with UI Automation refs and a user-visible stop.

## Checks I ran before submitting

- \`dsh.bundle\` is declared in the root \`package.json\` with a \`cordis.patch.yml\` beside it.
- \`scripts/check-submission.mjs --only-list\` against current \`main\` — **pass**.
- \`scripts/generate-readme.mjs\` — exit 0, and the entry line renders.
- \`scripts/check-bleed.mjs\` — **no pair**: this description shares no 40-character run with any
  existing entry, including the upstream one it forks.
- The description is 304 characters (the list runs 182 at the median and 314 at p90), so there are
  fewer claims to check; every remaining one is countable or greppable.
- \`verify/vision-screenshot.mjs\` — **16/16**, including that an image block is attached on an
  image-capable route, that none is attached on a text-only route, and that \`screen_per_pixel\` still
  reproduces the real screen size after the host halves the picture
  (522 * 3.6782 = 1920.0 vs screen 1920).
- \`releases/latest/download/computer-user.tgz\` returns HTTP 200 and the asset name is version-free,
  so it will not 404 on the next release.
- Official packages are \`peerDependencies\`, with an explicit prerelease branch per tuple. The
  previous \`>=0.1.0-rc.6\` silently excluded \`0.1.5-rc.2\`, the build actually shipping — verified
  with node-semver, not by eye.
- Installed into a real \`web\` profile and exercised: \`apply()\` registers 13 tools, the settings
  namespace resolves through the 0.1.5 provider API, and \`/computer\` registers.
`;

// Inherit the environment exactly as it is. A proxy address is a property of the
// machine, not of this repository, so none is hard-coded here; if github.com needs
// one where you run this, export HTTPS_PROXY first and it is picked up like any
// other tool's.
const env = { ...process.env };

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
  const open = process.argv.includes('--open')
  const draft = process.argv.includes('--draft');

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
    console.log('\nprepared only. Re-run with --open once the repository is 1 day old:')
    console.log('  node contrib/open-awesome-pr.mjs --open')
    return 0
  }

  // Re-running this after the PR exists must not crash. Creating a second PR for
  // the same head/base is a 422 from GitHub, and the branch update above is
  // idempotent, so the honest thing is to update the open PR in place: a re-run
  // after editing ENTRY or BODY should publish the edit, not fail.
  const open_prs = ghQuiet(['api', `repos/${UPSTREAM}/pulls?head=${OWNER}:${BRANCH}&state=open`]);
  const existing = Array.isArray(open_prs) ? open_prs[0] : null;

  let pr;
  if (existing) {
    // `draft` is create-only on this endpoint, so an update leaves the draft
    // flag as it is rather than sending a field GitHub may reject.
    pr = gh(['api', '--method', 'PATCH', `repos/${UPSTREAM}/pulls/${existing.number}`, '--input', '-'],
      { title: TITLE, body: BODY });
    console.log(`\nupdated PR #${pr.number} (draft flag unchanged): ${pr.html_url}`)
  } else {
    pr = gh(['api', '--method', 'POST', `repos/${UPSTREAM}/pulls`, '--input', '-'],
      { title: TITLE, head: `${OWNER}:${BRANCH}`, base: 'main', body: BODY, draft });
    console.log(`\nopened ${draft ? 'draft ' : ''}PR #${pr.number}: ${pr.html_url}`)
  }
  return 0;
}

process.exit(await main());
