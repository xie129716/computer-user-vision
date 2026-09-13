# Changelog

## 0.3.10 (honest `activated_only` advice)

`computer_click` flags `activated_only` when the foreground window changed and the click landed
inside the new one — the activation-click trap. The hint then said, flatly, "replay the same click".

That advice is unsafe in one case the heuristic cannot distinguish: a click that **closes a dialog**
also brings the window underneath forward, producing an identical signature. Replaying there would
apply the action **twice**. The hint now says so and asks the caller to check `foreground_after`
against the window it expected before deciding to replay. `skills/computer-use.md` carries the same
caveat.

## 0.3.9 (focus guard + an honest control switch)

Both defects below were found by driving the build through a scripted acceptance run rather than by
reading the code — the first from watching the UI, the second from an accident.

- **The control switch claimed control was on while every call was being refused.** After a Stop
  (button or `Ctrl+Alt+Esc`) the mode is still `auto`, so `enabled` stays true — and the switch read
  only that field, ignoring the `stopped` label the server was already returning. It rendered the
  green "on" state, and clicking it sent `!enabled`, which **turned the mode off** instead of
  clearing the stop. A page reload did not help, because the mount-time read saw the same `enabled`.
  A stop now outranks the mode: `on = enabled && !stopped`, the switch renders an amber
  "stopped by you" with a matching tooltip, clicking re-approves, and it re-reads the route every
  four seconds so an out-of-band stop shows up without a reload.

- **`expect_window`: refuse focus-sensitive input instead of explaining it afterwards.** The tools
  reported `focused_window` only *after* acting, which is a post-mortem — during this very
  acceptance run a `Ctrl+H` meant for Notepad went to the browser, because focus had drifted between
  two steps. `computer_type`, `computer_keypress`, `computer_click`, `computer_scroll` and
  `computer_drag` now take an optional `expect_window` substring; on a mismatch they refuse
  **without sending any input** and return `refused`, `expected_window`, `focused_window` and a
  `hint`. Verified both ways: a bogus name yields `chars: 0` and the intended text never reaches the
  document, while a real match proceeds normally.

- **Lossless-JSON hardening.** `describeWindow` assigned `title`/`pid`/`hwnd`/`rect`
  unconditionally, so any absent field became an `undefined` property — which is not lossless JSON
  and makes the harness discard the *entire* tool result. It now assigns only present fields, the
  same rule `describeElement` already followed.

Acceptance evidence for this release: the Stop button wrote `button` and the hotkey wrote `hotkey`
to the stop marker with the indicator exiting cleanly; the gate refused the next call and named the
cause; the walk-back switch showed the amber stopped state; a Notepad round-trip
(type → `Ctrl+A`/`Ctrl+C` → clear → `Ctrl+V`) restored exactly the copied text; `computer_scroll`
advanced 5 notches = exactly 15 lines and returned to the identical line; and a two-line
`computer_drag` selection landed its endpoints on the predicted rows to the character.

## 0.3.6+vision.3 (approval persistence)

`/computer` was granted into a module-level Set. It did survive across turns
within one session, but it evaporated on every host restart and had to be typed
again in every new conversation — and because the command is a toggle, a second
press silently revoked it.

- **Approvals are now stored on disk** (`$DSH_HOME/computer-user-approvals.json`,
  falling back to `~/.dsh`). A session grant survives a host restart, so the
  computer is not silently taken away by a routine `dsh web` restart. The file
  holds session ids and one boolean — no transcripts, no paths, nothing read
  from the screen.
- **New `approval_scope` setting**: `session` (default) keeps the per
  conversation grant; `profile` makes one `/computer` cover every conversation,
  current and future, until it is revoked with another `/computer`. This is the
  answer to "do I really have to type this in every new chat".
- The command now reports exactly what it granted and for how long, and prints
  the approval file path so the grant is auditable.
- The settings card gained a generic enum dropdown (the old `mode` field type
  hard-wired the run-mode choices) and now renders **every** top-level field —
  it used to hard-code the first two, so a new setting could vanish from the UI
  without a word.

For zero friction there is still `mode: auto`, which needs no approval at all;
the indicator and the stop button keep working in that mode.

## 0.3.6+vision.2 (control indicator, third pass)

Four defects reported from watching the second pass run, each fixed at its root:

- **The frame looked crooked.** The four edge strips OVERLAPPED at the corners
  (the vertical ones spanned the full height while the horizontal ones spanned
  the full width), so two semi-transparent windows composited there and the
  corners came out denser than the edges. The strips now tile: vertical strips
  are inset by the thickness, so each corner pixel belongs to exactly one
  window. Verified by geometry (sum of strip areas now equals the frame area
  exactly, 41804 px) and by pixel measurement (corner pixel identical to a
  mid-edge pixel of the same strip).
- **The slow pulse was invisible.** `WS_EX_LAYERED` was being added to windows
  that already existed, and Windows only applies that style after a frame
  change — so every `SetLayeredWindowAttributes` call failed silently and the
  per-frame alpha never took effect. Each decorative window now gets a
  `SetWindowPos(SWP_FRAMECHANGED)` right after the style change. Measured over
  five seconds the strip brightness now swings 170 -> 232 -> 176 (spread 61),
  a full breath about every five seconds.
- **The indicator appeared in the AI's own screenshots.** It is drawn for the
  human watching, never for the model: a bright frame baked into every capture
  also covers real content along the screen edges. The host now writes a pause
  file before capturing and removes it after; the overlay hides every window
  within one 50ms tick. Verified: strip present (mean 209.9) -> paused
  (mean 249.4, frame gone) -> resumed.
- **The halo ignored the cursor shape.** It now reads the live cursor via
  `GetCursorInfo` and compares it against the system `IDC_*` handles, then draws
  a matching outline: a vertical capsule for the I-beam and vertical resize, a
  horizontal capsule for horizontal resize, a rotated capsule for both
  diagonals, a crosshair for cross, a slashed ring for "no", and a plain ring
  for the arrow, the hand and any app-drawn cursor. Detection verified at
  several positions; the I-beam capsule confirmed visually.

Also reworked the stop contract. A stop previously produced a bare refusal,
which invites the agent to look for a workaround. The refusal now states what
stopped it and spells out the three things a stop usually means — the user
thinks this turn is risky, does not want the AI driving right now, or wants a
different approach — then constrains the turn: stop immediately, do not retry or
route around it, say what was already done and what may need checking, and ask
how to proceed. Re-raising control within the turn remains impossible.

## 0.3.6+vision.1 (local adaptation, second pass)

Every item below comes from a failure observed while actually driving Windows
with the previous build — not from speculation.

- **New `computer_list_windows`**: visible top-level windows in z-order with
  their exact virtual-screen rectangles. Reading a window position off a
  downscaled screenshot produced a ~240px error in practice (a 1.84x preview);
  asking the OS removes that class of mistake entirely.
- **New `computer_activate_window`**: focus a window by hwnd/pid/title using
  AttachThreadInput + SetForegroundWindow. Windows consumes the FIRST synthetic
  click on a background window as the activation click — the control never sees
  it and nothing reports the loss. A sacrificial click is no longer needed.
- **Actions now report context**: `computer_click` returns `at` (the UI element
  under the cursor, via UI Automation), `foreground_before`/`foreground_after`
  and `activated_only`; `computer_type`/`computer_keypress` return
  `focused_window`. Typing into the wrong window used to be completely silent.
  New setting `verify_actions` (default on) — off saves a subprocess per action.
- **Optional coordinate grid**: `computer_screenshot({ grid: 100 })` draws
  labelled lines in virtual-screen coordinates, so coordinates can be read
  directly off a downscaled image instead of counted. Setting `grid_spacing`.
- **Control indicator (Codex-style)**: while the agent holds control, a separate
  process draws a slowly pulsing gradient frame on all four screen edges, a
  colour-shifting halo that tracks the cursor (the OS cursor bitmap cannot be
  recoloured, so the halo is what changes), and a top banner naming the
  controller with a Stop button. New `src/overlay.js` owns its lifetime and a
  heartbeat file that makes the overlay self-reap if the host dies.
- **Halo colour fix**: the glow rings were drawn with per-ring alpha, but a
  `TransparencyKey` window cannot express alpha — a semi-transparent pixel
  composites with the key colour instead of vanishing, so the rings survived
  the key as pink residue instead of fading out. Rings are now fully opaque
  with graded BRIGHTNESS and hard edges. Because the indicator is a fresh
  process per takeover, this fix applies on the next takeover with no host
  restart.
- **User stop is absolute**: the banner button and the global Ctrl+Alt+Esc
  hotkey both write a stop marker; the mode gate then refuses every computer_*
  tool with a message naming the cause, until the user re-approves with
  `/computer` (which clears the mark). Only a user action writes that marker —
  an idle reap or a host shutdown leaves no trace.
- New settings: `overlay`, `overlay_idle_seconds`, `overlay_label`,
  `verify_actions`, `grid_spacing`. Skill/README/docs updated around them.

## 0.3.6+vision (local adaptation)

- **Fixed a total load failure on DSH 0.1.5**: `src/index.js` imported
  `settingsNamespace` by name from `@deepseek-ai/dsh-settings`, but that
  module-level helper was removed in the 0.1.5 line (the installed 0.1.5-rc.2
  exports only `SettingsConflictError`, `SettingsProvider`, `default`,
  `redactSecrets`). A missing named export fails the whole ES module at load, so
  **no** `computer_*` tool, no settings card and no `/computer` command ever
  registered — the plugin was silently inert. It now imports the module
  namespace and feature-detects, mirroring dsh-imagegen's cross-generation bridge.
- **Settings writes moved to the current API**: `SettingsScope.set(key, value)`
  no longer exists; `sourceSetter` now writes through `SettingsScope.update(patch)`.
- **Vision-facing screenshot**: when the calling route declares `image` input
  (e.g. `deepseek-flash` / DeepSeek-V41-Flash), `computer_screenshot` now commits
  the PNG through the host `attachments` service and returns a real image block,
  so the model reads the screen itself — picturereader is no longer required.
- **Exact coordinate mapping**: the result carries `screen_per_pixel`, derived
  from the capture scale, the saved image size, and any host normalization, so
  `screen = virtual_offset + image_pixel * screen_per_pixel` is authoritative.
  The host downscales anything above its vision budget silently, which would
  otherwise skew coordinates.
- **Budget-aware capture**: in vision mode the capture is re-taken smaller to fit
  `vision_max_pixels` (default 640000, DeepSeek's projection budget) instead of
  letting the host downscale behind the plugin's back.
- **Graceful degradation**: text-only routes, `vision_feedback=false`, a missing
  attachment service, or a failed `saveImage` all fall back to the original
  path-based contract; a failed attach never loses the screenshot.
- New settings: `vision_feedback` (default on) and `vision_max_pixels`
  (default 640000), exposed in the settings card's Advanced section.
- Docs/skill rewritten around the two modes (vision direct vs path fallback).

## 0.1.0 (2026-08-21)

- Initial release: `computer_screenshot` + `computer_click` / `computer_type` /
  `computer_keypress` / `computer_scroll` / `computer_drag` / `computer_move_mouse` /
  `computer_wait` / `computer_get_cursor_position`.
- PowerShell + Win32 SendInput backend (Windows only, zero native deps).
- Settings card with up-front **Enabled** / **Ask-before-acting** switches and a
  default-collapsed Advanced section.
- Works with picturereader to close the look → act → verify loop.
- Node:test unit suite; safe-window smoke scripts; headless integration verified.
