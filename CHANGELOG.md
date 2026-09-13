# Changelog

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
