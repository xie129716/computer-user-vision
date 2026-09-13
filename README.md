# computer-user-vision

An **unofficial fork** of [computer-user](https://github.com/jing-hy/computer-user) — Codex-style
computer use for **DeepSeek Harness (DSH)** on Windows: read the screen, drive mouse & keyboard,
close the *look → act → verify* loop.

It exists because the upstream 0.3.6 release is **silently inert on any DSH ≥ 0.1.2**, and because
it was written before the models could see.

---

## Why this fork

### 1. Upstream does not load at all on current DSH

`src/index.js` took a named import from a package that no longer exports it:

```js
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
```

The 0.1.5 line of `dsh-settings` exports only
`SettingsConflictError`, `SettingsProvider`, `default`, `redactSecrets`.
A missing named export fails the **whole ES module at load time**, so on a current host you get:

- none of the ten `computer_*` tools
- no settings card
- no `/computer` command

…and **no error anywhere**. The plugin simply isn't there. Upstream's own peers
(`^0.1.0-rc.6 || ^0.1.1-rc.2`) can never match a `0.1.5-rc.*` release, which is the drift this fork
absorbs.

### 2. It only knew how to be looked at through OCR

`computer_screenshot` returned a PNG **path** and instructed the model to hand it to a local OCR
plugin. That was the right design for text-only models. It is the wrong design for a model whose
catalog entry says `inputModalities: ["text", "image"]` — such a model can simply look.

---

## What this fork changes

| # | Change | File |
|---|---|---|
| 1 | Named import → namespace import + feature-detecting shim (works on both API generations) | `src/index.js` |
| 2 | `SettingsScope.set(k, v)` → `SettingsScope.update({[k]: v})`, old path kept as fallback | `src/index.js` |
| 3 | Screenshot committed through the host `attachments` service, returned as a real image block | `src/tools.js` |
| 4 | Result carries `screen_per_pixel`, the authoritative image-pixel → screen-pixel factor | `src/tools.js` |
| 5 | Vision mode re-captures smaller to fit `vision_max_pixels` instead of letting the host downscale opaquely | `src/tools.js` |
| 6 | Four graceful fallbacks to the original path contract | `src/tools.js` |
| 7 | New settings `vision_feedback` (default on) and `vision_max_pixels` (default 640000) | `src/config.js`, `client.js` |
| 8 | Skill / README / settings-card copy rewritten around the two modes | `skills/`, `README*.md`, `client.js` |
| 9 | `computer_list_windows` — exact window rectangles from the OS instead of eyeballing a downscaled screenshot | `src/act.ps1`, `src/tools.js` |
| 10 | `computer_activate_window` — focus a window deliberately, dodging the activation-click trap | `src/act.ps1`, `src/tools.js` |
| 11 | Actions report context: the UI element under the cursor, foreground before/after, `activated_only` | `src/tools.js` |
| 12 | Optional labelled coordinate grid drawn onto screenshots | `src/act.ps1` |
| 13 | Codex-style control indicator with a hard user stop | `src/overlay.ps1`, `src/overlay.js` |
| 14 | **Element refs.** Every screenshot enumerates the focused window's controls; `computer_click` takes `ref` or `name` and UI Automation resolves them to the control's exact rectangle, so a click needs no pixel arithmetic at all. New `computer_elements` tool returns refs without a screenshot. | `src/act.ps1`, `src/tools.js` |
| 15 | **Window rectangles are the DWM visible frame.** The raw `GetWindowRect` value is 8 px larger on every side (invisible resize border), which made any window-relative aim wrong by 8 px. Both are now reported; `rect` is the one on screen. | `src/act.ps1` |
| 16 | **PerMonitorV2 DPI awareness.** `powershell.exe` starts DPI-*unaware*, so on a scaled display Windows virtualised every coordinate — a systematic misalignment that is invisible at 100%. | `src/act.ps1` |
| 17 | **One PowerShell process per tool call** instead of three or four. A single click used to spawn three of them (focus check, before-foreground, click, probe) for ~1.1–1.5 s of pure process and `Add-Type` overhead. | `src/act.ps1`, `src/tools.js` |
| 18 | `input.ps1` / `context.ps1` / `capture.ps1` merged into one executor, `src/act.ps1` | `src/act.ps1` |

### The three mistakes this second pass fixes

Each of these was observed while actually driving Windows with the first build:

1. **Estimating coordinates from a downscaled screenshot.** A 1920×1080 capture comes back at
   1045×588; counting pixels in it produced a ~240 px error and a click that landed on the wrong
   desktop icon. `computer_list_windows` now returns the OS's own window rectangles, and
   `computer_screenshot({ grid: 100 })` can label the image with screen coordinates.
2. **The first click on a background window is consumed by activation.** It never reaches the
   control and nothing reports the loss — the window simply comes forward and the button does not
   press. `computer_activate_window` focuses first, and every click now reports
   `foreground_before`/`foreground_after` plus `activated_only` when that is what happened.
3. **Typing into the wrong window is silent.** `computer_type` and `computer_keypress` now return
   `focused_window`, and `computer_click` returns `at` — the accessible name, type and class of
   whatever sat under the cursor.

### Focus is checked *before* the input, not only after it

Reporting where the text went is a post-mortem: by the time `focused_window` says "Microsoft Edge",
the chord has already been delivered. That is not hypothetical — a `Ctrl+H` meant for Notepad landed
in the browser this way, because focus drifted between two steps.

So every input tool (`computer_type`, `computer_keypress`, `computer_click`, `computer_scroll`,
`computer_drag`) takes an optional **`expect_window`**: a substring the foreground window title must
contain. On a mismatch the tool **refuses without sending any input** and answers with
`refused: true`, the `expected_window` it wanted, the `focused_window` it actually found, and a
`hint` naming the fix. It is opt-in, so callers that omit it are unaffected.

```jsonc
// foreground is the browser, not Notepad → nothing is typed
{ "text": "hello", "expect_window": "记事本" }
// → { "chars": 0, "refused": true, "expected_window": "记事本",
//     "focused_window": { "title": "... Microsoft? Edge", "pid": 281252 }, "hint": "..." }
```

### The control indicator

While the plugin holds control, a separate process draws a slowly pulsing gradient along all four
screen edges, a colour-shifting halo that tracks the cursor (the OS cursor bitmap cannot be
recoloured, so the halo is the thing that changes), and a top banner naming the controller.

The banner carries a **Stop** button and the global **Ctrl+Alt+Esc** hotkey. Either one writes a
stop marker that the mode gate turns into a hard refusal of **every** `computer_*` tool, naming the
cause, until the user re-approves with `/computer`. Only a deliberate user action writes that
marker — an idle reap or a host shutdown leaves nothing behind, so the plugin can never mistake its
own cleanup for a user stop.

The banner is **two windows**, so it does not eat your clicks: the decoration (background, accent
bar and both labels) is click-through, and the only part of the strip that consumes a click is the
Stop button itself — 96x30 rather than the whole 620x46 banner. A click on the `Ctrl+Alt+Esc` hint
goes to whatever is underneath, which is where it looks like it should go. `verify/overlay-hit.mjs`
asserts exactly that, point by point.

The chat-input switch tells the truth about that state: it treats a stop as outranking the mode, so
after a button or hotkey stop it shows an amber **"stopped by you"** instead of the green "on" it
used to show while every call was being refused. It re-reads the state every four seconds, so the
stop appears without a page reload, and clicking it performs the re-approval.

The indicator is deliberately a separate process with a heartbeat file: it keeps rendering and stays
clickable even if the agent loop stalls, and it removes itself if the host dies.

It also never takes the foreground. WinForms' `Show()` activates a window, so the full-screen frame
used to become the foreground window the instant it appeared — stealing focus from whatever you were
typing in, and making `computer_activate_window` report failure, because its success check compares
the foreground window against the requested one and kept finding the overlay. It now records who had
focus before appearing and hands it straight back.

### The coordinate problem (the part that actually bites)

The host tells a model the **preview dimensions** of an image but never how to get back to desktop
coordinates. Worse, DeepSeek's **request-level** image budget is 640 000 pixels — not the 64 M
attachment limit — so a 1920×1080 screenshot is silently downscaled before the model sees it. Any
naive "click where I saw it" logic is then off by the downscale factor.

This fork makes the mapping explicit and single-sourced:

```
screen_x = virtual_offset[0] + image_x * screen_per_pixel[0]
screen_y = virtual_offset[1] + image_y * screen_per_pixel[1]
```

`screen_per_pixel` folds in the capture scale, the stored image size, **and** any normalization the
attachment service applied on save. In vision mode the capture is also re-taken smaller to fit the
budget, so the preview dimensions equal the file dimensions and the factor stays exact.

For detail work — small UI text, small buttons — capture a `region` instead; the same pixel budget
then covers far fewer pixels and the picture stays sharp.

---

## Install

Requires **Windows**, **Node 22.19+ or 24+**, and a DSH profile (default `web`).

```bash
dsh plugin --profile web add git+https://github.com/xie129716/computer-user-vision.git
```

### Why this fork ships no patch file

Patching a stock `computer-user@0.3.6` in place with `pnpm patch` works — that is how this fork was
developed and validated on a live host — but the patch pnpm generates is **pnpm-specific**. Against
a pristine 0.3.6 tarball it does not apply with `git apply`, neither on upstream's actual CRLF bytes
nor on an LF-normalized copy. Shipping an artifact that looks portable but is not would be worse
than shipping none, so install the fork instead.

If you *do* keep a local pnpm patch, **pin the version exactly** (`"computer-user": "0.3.6"`, no
caret). A patched-dependency key is version-exact, so a caret range resolving to a newer release
silently drops the patch — taking both fixes with it.

### Installing a source checkout into a profile

`dsh plugin add` fetches the published package. When you are working on the source itself, the
profile can otherwise keep serving an older copy — a fix made in the checkout appears to do
nothing. This puts the checkout you are looking at into the profile:

```bash
node tools/install.mjs web --dry-run     # list what would be copied
node tools/install.mjs web               # copy it in
```

Nothing is tied to one machine: the DSH home comes from `$DSH_HOME` (falling back to `~/.dsh`) and
the profile is an argument. It **refuses** when the profile installs this package through a pnpm
patch, because the next `pnpm install` re-applies that patch and would silently undo the copy — pass
`--force` once you have decided how you want to own that.

### Then

Restart `dsh web` — bundle lists are composed at boot, so an already-running server will not pick
the plugin up. The default mode is `manual`, which requires a per-session `/computer` approval
before any side-effecting tool runs; `auto` lets the agent drive freely.

---

## The self-healing doctor

`tools/computer-user-doctor.mjs` is a version-independent health check that **re-derives the
defects from the installed source** instead of replaying a diff, so it keeps working across
releases. It verifies that the patch is registered, the vision adaptation is present, the settings
import is generation-agnostic, the write path uses the current API, and the module actually loads —
and it **repairs** the two API-drift items automatically.

```bash
node tools/computer-user-doctor.mjs           # check, exit 1 when unhealthy
node tools/computer-user-doctor.mjs --heal    # repair what is repairable
```

Installed into a profile as `scripts/`, it can run from a `postinstall` hook so any
`dsh plugin add|update` self-checks. `tools/doctor.cmd` exists because pnpm's lifecycle shell does
not reliably have `node` on `PATH` (nor sets `npm_node_execpath`); it searches, and always exits 0 —
a health report must never fail an install.

The vision adaptation itself is **not** auto-repairable: it is a ~300-line change across five files
and cannot be derived from a future upstream release. The doctor reports it loudly, and the version
pin keeps it in place.

---

## Verification

```bash
node verify/registration.mjs        # 21/21 — tools, settings namespace, /computer, update() write path
node verify/vision-screenshot.mjs   # 16/16 — real capture, image block, budget fit, mapping, fallbacks
node verify/overlay.mjs             #  9/9  — indicator spawns once, heartbeats, reaps, honours overlay=false
node verify/doctor-heal.mjs         # VALIDATED — break the source, heal it, re-check
node verify/plugin-exports.mjs      # audit every plugin in the profile for the same class of defect
```

Set `DSH_PROFILE` to target a non-default profile. `vision-screenshot.mjs` grabs the real screen
(that is the point) but transmits it nowhere — the bytes go to a stubbed attachment service held in
memory.

Verified against **DSH 0.1.5-rc.1** on Windows 11, model route `deepseek-flash` (registered as
*DeepSeek-V41-Flash*, `inputModalities: ["text","image"]`), single 1920×1080 display: a full capture
becomes 1045×588 with `screen_per_pixel = 1.8367`, and the mapping reproduces the true screen size to
under one pixel.

---

## Privacy — what does and does not leave the machine

- **Screenshot capture and input injection are fully local** (PowerShell + Win32 `SendInput`).
- **Vision mode necessarily sends the picture to your configured model provider.** That is what
  using a vision model means, and it is the trade this fork makes. The frame is written to a local
  temp file first; only that frame is attached, and nothing else is read.
- **Path mode stays fully local** when paired with a local OCR plugin — only text tokens leave.
- **The doctor and the verification scripts transmit nothing** and contain no telemetry.
- Screenshots land in the OS temp directory (or `screenshot_dir`) and are **not deleted
  automatically**. Clear them out if your screen showed anything sensitive.
- Framing matters: capture a `region` around the target window instead of the whole desktop, so
  unrelated windows never enter the model context.
- Prefer the default `manual` mode over `auto` when you are not actively watching the run.

### What it does to the system, plainly

The list above is about what *leaves* the machine. This is the other half — the side effects a
reader should be able to check line by line rather than discover:

- **Spawns a hidden `powershell.exe`** while control is held. That process draws the full-screen
  topmost indicator and registers the `Ctrl+Alt+Esc` global hotkey, then exits when the heartbeat
  goes stale. It is deliberately **not** detached, so it cannot outlive the host — a detached GUI
  process is exactly how an indicator gets stuck on screen forever. Turn it off with `overlay: false`.
- **Registers exactly one HTTP route on the DSH web server**: `GET`/`POST /computer-user/control`,
  the endpoint behind the chat-input switch. It refuses any socket that is not loopback
  (`127.0.0.1` / `::1`), and the only thing it can change is this plugin's own run mode and stop
  marker — it cannot read files or run commands.
- **Writes files outside the package**, and nothing else: `$DSH_HOME/computer-user-approvals.json`
  (which sessions and whether the profile is trusted — it outlives a host restart on purpose, so a
  restart does not silently revoke control), plus heartbeat / pause / stop / `route.log` files under
  the OS temp directory. No transcript, no screen content, no keystroke log.
- **Wraps the LLM provider adapters** (`ctx.llm`) to run the output guard that rejects tool calls
  written as conversation text. Every chunk is forwarded unchanged unless that pattern matches;
  `output_guard: false` disables the wrapping entirely.
- **No telemetry and no outbound requests** from the plugin itself. The only network traffic is the
  screenshot your model provider already receives, described above.

All of these are also asserted by `verify/` — `registration.mjs`, `overlay.mjs`, `overlay-hit.mjs`,
`general-workflows.mjs` and `plugin-exports.mjs` fail loudly if one of them stops being true.
`general-workflows.mjs` is the scenario-neutral one: it drives the whole interaction surface across
four unrelated UI stacks (Win32, UWP/XAML, Chromium, the desktop shell) and asserts an observable
outcome each time rather than "the call returned ok".

---

## Layout

```
src/                     plugin source (act.ps1 — the single executor — tools.js, overlay.*, index.js, …)
skills/computer-use.md   the model-facing skill: the two modes, click discipline, coordinate rules
client.js                web settings card
tools/                   doctor (health check / self-heal) and install.mjs (put a checkout into a profile)
verify/                  portable verification scripts (plain node, no browser required)
docs/                    adaptation notes
contrib/                 repository housekeeping, not shipped (the awesome-list submission script)
```

---

## Credits & license

Original plugin and design: **[jing-hy](https://github.com/jing-hy/computer-user)** (MIT).
The cross-generation settings bridge follows the pattern used by
[dsh-imagegen](https://www.npmjs.com/package/@dickpy/dsh-imagegen).

MIT — see [LICENSE](LICENSE). This fork is not affiliated with or endorsed by the upstream author;
please report fork-specific problems here rather than upstream.

**On the package name.** This package is called `computer-user`, the same name as the upstream npm
package, and that is deliberate rather than an attempt to pass itself off as it: `cordis.patch.yml`
registers the plugin under that specifier, so a profile can drop this fork in exactly where the
original sat. The fork is stated where identity is actually read instead — `description`, `author`
and a `forkedFrom` field in `package.json`, the first line of this README, and `repository`, which
points here. The package has **no `dependencies` at all**; the only entries are `peerDependencies` on
the harness's own `@deepseek-ai/*` packages, so nothing here resolves to a copy of anyone's work.
