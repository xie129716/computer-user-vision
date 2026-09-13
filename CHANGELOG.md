# Changelog

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
