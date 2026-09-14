# Changelog

## 0.3.30 (a shipped verifier that failed about one run in three)

No plugin code changed. `verify/general-workflows.mjs` D2 — "a refused call sends no input at all" —
failed intermittently, and the cause was the harness, not the plugin:

- **`Set-Clipboard` fails with `CLIPBRD_E_CANT_OPEN` whenever another process holds the clipboard
  open**, and that happens often enough to be roughly one run in three. The helper ignored the error,
  so the check then read the PREVIOUS clipboard contents — the user's own `2026/9/9` — and reported it
  as "input was sent". A test that blames the code for a clipboard race is worse than no test.
- `setClip` now retries and **confirms the write took**, and D2 asserts the property directly (the
  refused text appears nowhere) with the strong "clipboard is byte-for-byte unchanged" form used when
  priming succeeded — and it says which form ran. Measured **4/4 green** afterwards, against 1 failure
  in 3 before.

Worth recording because it is the second time in this series that a red result was the test's own
fault rather than the plugin's, and the first `Set-Clipboard` failure was silently indistinguishable
from a real one.

## 0.3.29 (snapshot-scoped element refs — and the first rule was too strict)

- **Every enumeration now returns a `snapshot` id** (`s7`), and refs are stored per
  snapshot instead of in a rolling pile where a name could quietly change meaning.
  Retention is 3 enumerations, which keeps `screenshot -> computer_elements -> click`
  working and nothing older.

- **`computer_click` and `computer_type` take an optional `snapshot:` to pin.** A pinned
  ref resolves inside exactly that enumeration, and a pin to an evicted snapshot is
  **refused as stale** rather than silently re-pointed:

  > 快照 s999999 已过期（只保留最近 3 次枚举：s2, s1）。引用只在产生它的那次枚举内有效，请重新
  > computer_screenshot / computer_elements 后再操作。

- **A bare ref follows the newest enumeration that contains it**, which is the list the
  caller just read. The result now reports `ref_snapshot` — which enumeration it came
  from — and `ref_ambiguous` when an older live snapshot disagreed about that name:

  > 引用 e1 在更早的快照里指向不同控件（s3 -> "计算器"）；本次按最新快照 s4 解析。若你本意是更早
  > 那次，请带上 snapshot 明确指定。

- **`purpose: "look"` creates no snapshot**, because it enumerates nothing. A look
  capture must not shadow refs the caller is already holding, and it does not.

- **The first implementation of this refused.** It rejected any bare ref that two live
  snapshots disagreed about, and `verify/element-refs.mjs --click` broke on its very
  first integration run: that test enumerates the focused window, launches its own
  Notepad, enumerates that, then clicks `e1` — unambiguously meaning the Notepad it just
  enumerated — and the refusal rejected a correct call. So a contest became a **report**
  rather than a refusal, and refusing is reserved for what genuinely cannot be honoured:
  an unknown ref, or a pin to an evicted snapshot. Recorded because the strict version
  looked obviously right until it was run.

- **New `verify/ref-snapshots.mjs` (12 checks)** proves all of the above against the live
  desktop, including that pinning an *older* snapshot resolves to that enumeration
  rather than the newest.

**This is a stability change, not a speed change.** It costs one `resolveRef` per call —
no measurable latency — and it does not touch the real bottlenecks (process spawn,
UI Automation enumeration, capture). What it buys is that a ref can no longer silently
mean a different control, and that a caller can say which enumeration it meant.

## 0.3.28 (0.3.27 over-fitted to the one window it was found on)

- **0.3.27 refused to enumerate any window whose root element reports no rectangle. That was an
  over-fit, and it is reverted.** It was written against a single observed case — a minimized ToDesk
  window whose root `BoundingRectangle` is `Rect.Empty` — but a host can report `Rect.Empty` for the
  root while its children carry perfectly usable rectangles. Returning early therefore threw away
  windows that are perfectly enumerable, which is exactly the kind of "fix the case in front of you,
  break the general one" change this plugin cannot afford.

  The behaviour now is: **enumerate always.** `rootW`/`rootH` of 0 means *unknown*, and the only
  place that consults it — the "a nameless element covering the whole window is a container" filter —
  stands down when the window's own size is unknown, because at 0 it would match every element. If
  nothing is found *and* the rectangle was missing, the caller gets the missing rectangle as the
  explanation. A window with no rectangle and real children returns its children.

- **New `verify/general-workflows.mjs` (17 checks).** The plugin is not for any one application, so
  this drives the whole interaction surface against **four unrelated UI stacks** and asserts an
  observable outcome each time, never "the call returned ok":

  | group | stack | what it proves |
  | --- | --- | --- |
  | A | window manager | inventory rectangles are consistent; activate by hwnd / title / pid; a packaged app does not resolve to its 0x0 helper; a bogus pid is refused with a reason |
  | B | plain Win32 (Notepad) | refs enumerate; a click by ref lands on the ref's exact centre; mixed ASCII + CJK + Cyrillic typed text round-trips through the clipboard; the wheel really scrolls (proved by a luminance profile of the page); a press-and-hold drag really selects |
  | C | UWP/XAML (Calculator) | live pattern flags are present (the cached-flag regression cannot return); clicking a digit changes the display's accessible name |
  | D | guards | `expect_window` refuses on a mismatch and sends **no** input; an unknown ref is refused |

  Three of its first-run failures were the test's own bugs, and two of them are worth recording
  because they would mislead anyone repeating this:
  - equal-length lines make a band-luminance profile **periodic**, so a document can scroll a long
    way with the profile unmoved — the document has to be non-uniform for the oracle to mean anything;
  - a digit button must be identified by `automationId` (`num4Button`), not by accessible name: the
    name is localised, and on a Chinese UI matching `0`-`9` finds nothing.

- **Two general behaviours recorded, not changed.** `computer_activate_window` by the pid of
  `ApplicationFrameHost` is genuinely ambiguous — that process hosts several frames at once
  (measured: 计算器 and 设置 both belong to it), so it resolves to one of them and there is no way to
  know which the caller meant. Pass the app's own pid, an hwnd, or a title. And `pointer_landed` is a
  display string like `[995,558]`, consistent with `target` and `under_cursor`, not an array.

## 0.3.27 (a window with no rectangle took the whole tool call down)

Found by running `verify/element-refs.mjs` against a minimized ToDesk window, which the desktop
happened to leave in the foreground.

- **A `BoundingRectangle` of `Rect.Empty` aborted every enumeration with exit 1.** The property is a
  `System.Windows.Rect`, and an element with no on-screen area - minimized, hidden, or owned by a
  remote-control session - reports `Rect.Empty`, whose `Width` and `Height` are
  `double.NegativeInfinity`. Casting that to `[int]` throws *"value too large or too small for an
  Int32"*, and because the cast sat in the middle of the screenshot path, `computer_screenshot`
  returned a hard error rather than a result.

  It now says why instead of crashing:

  > UI Automation is unavailable for this window: the window reports no on-screen rectangle
  > (minimized, hidden, or a remote-control session), so there are no controls to enumerate

  The same shape is guarded on the two other `BoundingRectangle` reads - the per-element loop
  (which already checked `IsEmpty`) and the "what is under the cursor" report. Since an empty root
  rectangle now returns early, the "element covers the whole window" filter no longer has to
  defend against `rootW`/`rootH` being 0.

## 0.3.26 (the banner stopped eating clicks — and the brake works again)

Two bugs, both in the control indicator, both found by measuring instead of looking. The second one
is the reason this release exists: the emergency brake had been silently dead.

### The banner swallowed a 620x46 strip of the screen

The banner is decoration plus one button, but it was a single window, so **every pixel of it consumed
a mouse click**. A click on the `Ctrl+Alt+Esc` hint — which reads as a caption — reached nothing. The
user hit this for real: a click near the top of the screen went nowhere.

The obvious fix was tried first and **measured to break the brake**, so it was reverted rather than
shipped: adding `WS_EX_TRANSPARENT` to the banner made all four probe points inside the Stop button
return the window *underneath*. The cause is that a `WS_EX_LAYERED` window is hit-tested as a whole
**layer**, so the style takes the children with it.

The fix that works is structural — **one window becomes two**:

| window | contents | click behaviour |
| --- | --- | --- |
| `deco` | background, accent bar, both labels | click-through (layered + transparent) |
| `brake` | nothing but the Stop button, exactly 96x30 | **the only part that can take a click** |

Measured with `WindowFromPoint`, which is the same question Windows asks when routing a click:

| | banner strip points eaten | interactive area |
| --- | --- | --- |
| before | **10 / 10** | 620x46 = 28 520 px² |
| after | **0 / 10** | 96x30 = 2 880 px² |

Every non-button point now resolves to the window underneath. The brake stays where it was, at
`[1162,18 .. 1258,48]`.

### The Stop button had silently stopped working

Splitting the banner broke the brake, and the symptom was not a missing click. A message-level trace
showed `WM_LBUTTONDOWN` **and** `WM_LBUTTONUP` both arriving at the button, with the control's own
state machine running `ENTER -> DOWN -> UP` — and no `Click`.

The cause was one line in the 50 ms animation tick:

```powershell
foreach ($bf in @($script:decoForm, $script:brakeForm)) { $bf.TopMost = $true }
```

`deco` overlaps `brake` (the button sits inside the banner strip), so re-asserting the deco's z-order
**every tick slid a window between the cursor and the button mid-press**, and WinForms cancelled the
press. Twenty `SetWindowPos` calls a second bought nothing. The old single-window banner was immune
only because the window it re-asserted was the button's own parent — which is exactly why this was a
regression introduced by the split, and why it had to be found by bisection rather than by reading.

Fixed by only repairing the z-order when it has actually been lost:

```powershell
if (-not [CUOverlayNative]::IsTopMost($bf.Handle)) { [CUOverlayNative]::ReassertTopMost($bf.Handle) }
```

### The 96x30 brake window came out 136x39

Windows clamps a top-level window to `SM_CXMIN x SM_CYMIN` — measured here as **136x39** — because a
Form with `FormBorderStyle='None'` is still a plain *overlapped* window, not `WS_POPUP`. WinForms'
own `MinimumSize` was 0x0, so this is the OS, not the framework. The result was a brake 28 px wider
than the banner and 40 px of dead strip.

The clamp is applied when the bounds are **set**, not by `SetWindowPos` — verified by measuring one
96x30 window before and after. So `PlaceExactly` (a direct `SetWindowPos`) after the handle exists is
the fix.

### New verifier: `verify/overlay-hit.mjs` (9 checks)

The lifecycle test proves the indicator starts and stops; it cannot see either bug above. This one
asks the routing question directly and **is the instrument that caught the reverted fix before it
shipped**. It also fires one real synthetic click and requires the stop marker to say `button`.

`verify/overlay.mjs` and `verify/overlay-hit.mjs` both had a process filter matching a bare
`overlay.ps1` substring, which also matched the shell that launched them — killing the test runner
mid-run. Both now match the real spawn shape, `-File ... overlay.ps1`.

## 0.3.25 (`purpose: "look"` — the cheap way to just see the screen)

Prompted by measuring what a "read the screen" call actually costs across the tool boundary.

- **New `purpose` parameter on `computer_screenshot`.** `"look"` means "just show me the screen"
  and turns on the whole cheap recipe at once: no element enumeration, a JPEG instead of a PNG, and
  scale 0.35. `"inspect"` (the default) keeps the refs and the exact coordinate mapping.

  Why a parameter instead of writing the recipe in the docs: it is **four** settings, and the
  documented version was usually half-followed. Measured on this machine:

  | | capture cost | frame handed to the vision model |
  | --- | --- | --- |
  | default `inspect` | 1075–1150 ms | 135 KB PNG, 1920x1080 |
  | `purpose: "look"` | **514 ms** | **23 KB JPEG, 672x378** |

  The enumeration alone is half the capture — it is a full UI Automation pass, and on a Chromium
  window it was measured at ~600 ms on its own. Nothing needs it when no click is being aimed.

- **New guards `A11` / `A12`**: `look` must really skip the enumeration and come back as a small
  JPEG, and it must really be faster than the default. The second one is the point — a "fast path"
  that is not measurably faster is just a second name for the same thing.

Also recorded, because it was assumed rather than measured: **lowering the subagent reasoning effort
to `low` did NOT make a screen read faster** (21 s against 20 s at default effort). A bare subagent
that calls no tool at all already costs **11 s** to spawn, so half the round trip is fixed overhead
and the thinking is not the bottleneck. What does work, measured: **reusing one warm subagent** for
repeated looks — the second look cost **6 s**, about 3.3x faster than spawning a fresh one.

## 0.3.24 (gestures: the press had no duration, and nothing said so)

Found by re-running the 4399 Gomoku game that defeated an earlier attempt, and then verifying the
whole gesture set against a clipboard instead of by eye.

- **EVERY PRESS WAS INSTANTANEOUS.** Merging the three one-shot scripts in 0.3.18 put the button-down
  and the button-up into a **single `SendInput` batch**, so the press lasted ~0 ms. The upstream
  script had slept 40 ms between them; that was lost. A zero-length press silently breaks every
  target that measures it: long-press-to-place games, press-and-hold menus, and double-click
  detection that needs two real presses. Restored, as a parameter rather than a constant:

  - `computer_click` takes **`press_ms`** (default 50, 0..10000)
  - `computer_drag` takes **`hold_ms`** (how long to hold BEFORE the pointer starts moving,
    default 0) — which is also how a press-and-hold is expressed at all: give the same point twice.

- **The duration was applied but never reported**, so a caller could not tell a 50 ms click from a
  600 ms one. Both tools now return `press_ms` / `hold_ms`. The new guard below caught this on its
  first run, which is exactly what it is for.

- **New guard `B2c`**: a `press_ms: 600` click must report `press_ms=600` AND take at least 600 ms of
  wall clock. A regression here is invisible in the result payload alone.

Gesture set verified objectively — the clipboard is the ground truth, not a look at the screen:

| gesture | evidence |
| --- | --- |
| double-click | double-clicking the word `bravo` in Notepad put `bravo ` on the clipboard; a **single** click at the same point selected nothing |
| drag | dragging from the start of one line to the end of another put exactly `DELTA echo foxtrot` on the clipboard |
| press duration | `press_ms=50` → 718 ms wall, `press_ms=800` → 1537 ms wall |

For the record, on the Gomoku game itself: the grid was measured from the screenshot pixels
(15 lines each way, 28.5 px pitch, cross-checked against the four star points and the centre stone),
and the long-press-drag then placed stones **within 3 px of the intended intersections** — against
an earlier run where nine blind clicks placed a single stone. The game's instruction, 长按拖动落子,
is literally "long-press, then drag"; it was never a missing feature, only a broken press.

## 0.3.23 (a click that could not be aimed was still sent)

Found by driving a real application end to end: a VPN client, the Windows desktop, and a browser
session through Amazon — mouse and keyboard only, no shortcuts.

- **A MIS-AIMED CLICK WAS STILL DELIVERED.** The caller asked for `[900,712]`; the pointer never
  moved from `[787,627]`; the tool reported the mismatch — and then pressed the mouse anyway, so the
  click landed on a different control. An unaimable click is not a degraded click, it is a **wrong**
  click. `click`, `scroll`, `drag` and `move` now abort **without sending a single event** when the
  pointer cannot be placed, and they name what blocked it.

  The trigger, measured: the target window belonged to an **elevated** process while the host did
  not. Windows UIPI refuses `SetCursorPos` from a lower integrity level (it returns FALSE) and
  silently discards `SendInput`, so the pointer is pinned. The result now says exactly that, with
  the foreground window, its pid, and the remedy — and `SetCursorPos` returning false is what
  distinguishes "refused" from "the move did not take".

- **A minimized window was described by its 146x21 sliver.** While minimized, a maximized
  1920x1040 browser reports a DWM extended frame of **146x21**, which is not where anything is —
  and a listing filtered by size then dropped the window entirely, so "bring Edge to the front"
  could not even find Edge. Minimized windows now report their **restored** geometry
  (`GetWindowPlacement`'s `rcNormalPosition`) and set `rect_is_restored`, keeping `minimized: true`.

- **"Hit confirmed" was broken for unnamed controls — in both directions.** The check compared
  accessible names, so for an unnamed control it compared two empty strings: it asserted a hit while
  confirming nothing. Tightening it (as the name-truncation fix in 0.3.21 did) then made an unnamed
  control **never** confirmable — and Windows 11 Notepad exposes its whole text area with an empty
  name, so this is a common case, not a corner. It now compares the target's rectangle with the
  rectangle of the element actually under the cursor, with the name as a secondary signal.

- **New regression guards** in `verify/element-refs.mjs`: **A10** — a window reported as minimized
  must carry usable geometry (it exercised 8 genuinely minimized windows) — and **B2b** — the
  pointer must really be where the click says it clicked. B2b is what caught the unnamed-control
  regression above, immediately.

Acceptance context for this release: QuickQ connected to a Tokyo node, the desktop, Edge opened from
its desktop icon, an InPrivate window opened through Edge's own menu, a Bing search for 亚马逊, the
Amazon home page, a search for `oui`, the sort switched to 畅销商品 (Best Sellers — Amazon has no
literal "sales" option), the first product opened, and its review section reached by scrolling and
screenshotted. Every step was a mouse click or a keystroke.

## 0.3.22 (a big window, and a bound that saved nothing)

Found by pointing the plugin at a 4000-control page in Chromium and at its own dense annotation.

- **The element scan was capped at 2500, and the cap was buying nothing.** On a
  **4054-element** Chromium tree, asking for 200 controls returned **71** — the scan stopped early
  and the difference was reported as nothing at all. Measured cost: the single cached property pass
  is **~605 ms** and happens regardless, while filtering **2500** elements added **~13 ms**. The cap
  was therefore truncating the answer to save an overhead of roughly 5 microseconds per element.
  Raised to 20000 (a runaway guard, not a budget); the same request now scans all 4054 and returns
  **83**, the true number of addressable controls.

- **Enumeration now reports what the tree actually is.** `total`, `fetch_ms`, `capped`,
  `limited_by_max` and `limited_by_scan` distinguish "this window has eight controls" from "the list
  was cut short", and say *which* limit cut it. Without them a caller cannot tell a small window from
  a large one.

- **Annotation chips were a fixed 15 pt, which is taller than a toolbar button.** A 22 px control is
  only 11 px tall at 0.5 scale, so every label had to be placed above its control, collided with the
  row above, and was silently dropped: **6 of 40 labels drawn** on a dense page, leaving 34 outlines
  with no way to tell which ref belonged to which control. Chips are now sized from the **median
  control height** (measured: chip height ≈ 2 × point size, floor 7 pt below which a label is not
  reliably readable). The dense page went **6 → 14** labelled and the Calculator **31 of 40**.
  Where that is still not enough the result says so and gives `median_element_h`, because the honest
  answer is that a tight list **cannot** be fully labelled at a given capture scale — 22 px pitch at
  0.5 scale would need a 5.5 pt font. The remedy is more pixels (`region` + `scale:1`), not a
  smaller font, and the skill document now says that.

Acceptance evidence for this release, on a local 4000-button page in Edge:
`computer_click {name: "BTN-0005"}` — a control that was **not** in the refs returned by the
preceding enumeration — was delivered as `method: "invoke"`, `hit_confirmed: true`, and the page's
own handler ran (window title became `CU-CLICKED-BTN-0005`), which is end-to-end proof rather than a
coordinate claim. Scrolling 40 notches moved the addressable set from `BTN-0001…0038` to
`BTN-0038…0080` (42 new, the early ones gone, matching Chromium dropping off-screen nodes), and
clicking one of the newly reachable buttons set the title to `CU-CLICKED-BTN-0039`.

## 0.3.21 (an accessible name has no size limit)

Found by scrolling, dragging and window-switching through real applications.

- **An element's accessible name is unbounded, and one window made a tool result
  12.6 KB.** Notepad's edit control reports the **entire document** as its name —
  measured at **11800 characters** for a 200-line file. The element list, the
  click's `target` and the click's `under_cursor` each carried it in full; a
  multi-megabyte document would have been carried in full too, on every call.
  Names are now capped at 100 characters at all three emission sites and a
  truncated one is flagged (`name_truncated`), and re-resolution matches the
  stored prefix instead of demanding an exact whole-name match — otherwise a ref
  to that very control would have stopped resolving the moment it was truncated.
  Measured effect: the click result went from **12652 bytes to 554**.

- **`max_elements: 0` reported "no actionable elements were found"**, which is a
  different and misleading claim from "enumeration was skipped as asked". The
  envelope now says which one happened.

- **`hit_confirmed` was missing for UI-Automation deliveries.** Invoking a
  control's own action is *stronger* evidence than a cursor probe — the click was
  performed on the resolved element, not inferred from where the pointer ended up —
  but no mouse moves, so no `at` probe runs and the result looked unverified. An
  action-pattern delivery now reports `hit_confirmed: true` and
  `delivery: "uia-invoke"` (or toggle/select/expand).

Acceptance evidence for this release:
scrolling 5 notches moved the view exactly 15 lines and 5 back restored it line-for-line;
a drag from screen x=300 on line 1 to x=300 on line 5 selected exactly the characters between
those two points (`NE-001… / 002 / 003 / 004 / LI`, both endpoints character-exact, verified through
the clipboard rather than by eye); and 9 consecutive `computer_activate_window` calls across
Notepad, a packaged Calculator and Explorer all landed on the intended window (9/9, 655 ms average).

## 0.3.20 (four defects the acceptance run found)

Driving real applications — a WinUI Calculator, Notepad, and a 22 px toolbar-density target board —
turned up four things that source review and the unit-level checks could not see.

- **`expect_window` was silently ignored by every input tool except `click`.** Merging the three
  one-shot scripts into `act.ps1` carried the pre-flight guard into `click` only; `type`,
  `keypress`, `scroll` and `drag` accepted the parameter, never checked it, and reported success.
  Caught by asking `computer_type` to type into Notepad with `expect_window: "计算器"` while Notepad
  had focus — it typed all 17 characters. The guard is now one shared `Test-ExpectWindow` called by
  every action that sends input, and the acceptance run proves a refused call leaves the document
  byte-identical.

- **`activate` by pid resolved to a 0x0 input-method helper.** A packaged (UWP) app owns no visible
  top-level window of its own — the Calculator's frame is an `ApplicationFrameWindow` owned by
  ApplicationFrameHost — so the only top-level window carrying that pid was a zero-area
  `MSCTFIME UI`. Activation then **reported success**, because the handles matched. Windows under
  20000 px and tool windows are now skipped, and when a process owns nothing usable the executor
  asks which top-level window *hosts* it.

- **Activation could not take the foreground from a packaged app, and retrying never helped.** The
  hint used to say "retrying usually works"; measured against the Calculator it failed every single
  time, because `SetForegroundWindow` is refused unless the caller already owns the foreground. The
  documented remedy — synthesise an ALT press so the calling thread owns the most recent input — is
  now the fallback, and Calculator → Notepad succeeds on the first call.

- **Cached pattern-availability flags are always false.** `IsInvokePatternAvailable` and its
  siblings read `True` on a live read and `False` through a `CacheRequest`, so the ref list claimed
  no control supported anything and every XAML button looked inert. Patterns are queried live, per
  kept element; the Calculator now reports `{Invoke,ScrollItem}` and `computer_click` succeeds with
  `method: "invoke"` — the mouse never moves.

- **Annotation labels were drawn above the control**, which put a window-sized element's label
  outside its own rectangle and on top of the neighbouring window. The chip now prefers the
  control's own top-left corner, and only goes above when the control is too short to hold it.

- **New `verify/ps1-hygiene.mjs`**: every bundled `.ps1` must be pure ASCII (PowerShell 5.1 decodes
  BOM-less files as ANSI) and no code may reference the retired one-shot scripts. Both rules had
  already been broken once, each time silently.

- **`verify/plugin-exports.mjs`** no longer scans a plugin's own `verify/` directory. It was reading
  a test fixture that quotes the broken import shape and reporting it as a missing export in the
  plugin, which made a clean package look broken the moment `verify/` started shipping.

Acceptance evidence for this release, measured on the live desktop:
Calculator `7 × 8 = 56` via four `name` clicks (all `method: "invoke"`, UIA read back
`显示为 56`); Notepad round-trip whose clipboard contents compared **byte-identical** to the 31
characters requested (CJK, `×÷`, `①②③`, em dashes); and 8/8 ref clicks on a 22 px-tall target grid
landing exactly on the control centre — **maximum absolute error 0 px**.

## 0.3.19 (packaging fix: 0.3.18 shipped without its manifest)

- **0.3.18 is withdrawn.** Its tarball was assembled from the `files` list with `tar` instead of
  `npm pack`. `package.json` is not in that list — npm always includes it regardless, a hand-rolled
  archive does not — so the published 0.3.18 archive contained no manifest at all. pnpm installs such
  a package behind a placeholder (`{"_pnpmPlaceholder": ...}`), which means no `dsh.bundle` metadata
  for the host to read and no version for the plugin to report. The blast radius is exactly one
  release: 0.3.15-0.3.17 were built with `npm pack` and do carry their manifest.
- The tarball is now produced by `npm pack`, and the check that should have caught this is explicit —
  assert that `package/package.json` is inside the archive *and that it parses* — instead of reading
  a file listing and noticing only the entry I was looking for.

## 0.3.18 (clicks that land, and a click that costs one step)

Everything here came from driving a real desktop and measuring, not from reading the code. The two
reports were "the click lands in the wrong place" and "one simple click takes several steps of
thinking"; both turned out to be structural rather than incidental.

- **The coordinate path *was* the misalignment.** A 1920x1080 desktop is 2,073,600 px, over the
  640,000 px vision budget, so the preview a model reasons about is ~1045x588: one image pixel is
  **1.84** screen pixels, and a 22 px toolbar button is 12 px tall in that picture. The OS already
  knew the exact rectangle of every control — the plugin used it only to *verify* a click after the
  fact. Now `computer_screenshot` (always) and the new `computer_elements` enumerate the focused
  window's controls and return refs, and `computer_click` accepts `ref` (`e12`) or `name` (visible
  text). Nothing is estimated any more: a ref click lands on `left + floor(width/2)` by
  construction, measured at **0 px** error.

- **`GetWindowRect` is 8 px larger on every side than the window you can see.** It includes the
  invisible DWM resize border — measured on Edge: raw `-8,-8 1936x1056` against visible
  `0,0 1920x1040`. `computer_list_windows` reported the raw value, so any window-relative aiming
  carried a systematic 8 px error. `rect` is now the DWM extended frame bounds; the raw value is
  kept as `window_rect`.

- **`powershell.exe` starts DPI-UNAWARE.** Measured: `GetAwarenessFromDpiAwarenessContext == 0`. The
  old scripts raised it only to System-aware, which is still wrong on a scaled display: Windows
  virtualises the coordinates, so every click is off by the scale ratio. That is invisible on a
  100% monitor and is exactly the class of bug that only appears on someone else's machine. The
  executor lifts the process to PerMonitorV2 and reports `monitor_dpi` so a caller can tell.

- **One click cost three or four processes.** Every PowerShell start is ~380 ms of process creation
  plus re-compiling the `Add-Type` C# — `input.ps1` doing nothing but reading the cursor took
  **376 ms**. `computer_click` spawned three or four of them (expect-window check, before-foreground,
  the click, then a probe) for **1.1-1.5 s** of pure overhead. `capture.ps1`, `input.ps1` and
  `context.ps1` are merged into a single executor, `src/act.ps1`; one tool call is now one process,
  and the focus check, ref resolution, click and probe cannot disagree about the desktop because
  they are the same process.

- **DPI-correct mouse movement, and a move that proves itself.** `SetCursorPos` was a bare call with
  no event attached. Moves now go through an absolute `SendInput` addressed to the whole virtual
  desktop (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`) and are verified with `GetCursorPos`
  before the click follows, because a move that silently failed used to be indistinguishable from
  one that worked.

- **`ControlType` is not a usable filter.** A WinForms button — the backbone of most Windows
  applications — is exposed by the MSAA bridge as `ControlType.Pane` and reports **no supported
  patterns at all**. Filtering by control type discarded precisely those controls. Enumeration now
  tests capability instead (accessible name, action pattern, value, or a control-like class name)
  over every descendant, with all properties fetched in **one** cached `CacheRequest` pass.

- **Degenerate states are reported instead of guessed.** `computer_activate_window` used to say "the
  window never came forward" even when the real cause was a *hidden* window the system still
  reported as foreground; it now tells the two apart. An ambiguous `name` is refused with the
  candidate list rather than resolved arbitrarily. An unknown ref says so, and lists what is
  available.

- **New `verify/element-refs.mjs`** proves the contract on the live desktop: 8 safe checks plus
  `--click`, which spawns its own Notepad and asserts that a ref click and a name click both land
  exactly on the reported centre and are confirmed by the tool. It asserts that the window under
  test is actually in front, because an earlier revision of the test silently measured the wrong
  window and passed.

- Tool count 12 -> 13 (`computer_elements`). The ref annotation is opt-in (`annotate: true`): on a
  dense window the chips collide into an unreadable band, so the element list is the better channel
  and the drawing is kept for sparse windows.

## 0.3.17 (a second pass over the submission rules, and the machine-specifics they exposed)

The first pass checked the hard gates — `dsh.bundle`, repo age, topic, peer ranges — and stopped
there. Going back through the contributing guide rule by rule turned up four things, three of them
in our own repository rather than in the entry.

- **Two machine-specifics were sitting in a public file.** The submission script hard-coded a local
  proxy (`http://127.0.0.1:8800`) and the path to the `gh` binary *this* installation happens to
  bundle. Neither means anything on another machine. The proxy is gone — the environment is
  inherited, so `HTTPS_PROXY` works like it does for any other tool — and `gh` is now resolved from
  `PATH` first with the bundled copy only as a fallback, failing with a real message when neither
  exists. A re-scan for `D:\dsh`, `C:\Users`, the proxy address and the user name comes back empty.

- **The README described what leaves the machine but not what the plugin does to it.** Review point
  5 asks about surprising behaviour, and four things were only discoverable by reading the source:
  it spawns a hidden `powershell.exe` that draws a full-screen topmost window and registers a global
  hotkey; it registers **one HTTP route on the DSH web server** (`/computer-user/control`, the chat
  switch, loopback-only); it writes an approvals file under `$DSH_HOME` plus heartbeat/stop files in
  the temp directory; and it **wraps the LLM provider adapters** for the output guard. All four are
  now stated plainly, with what each one can and cannot do.

- **The `tools/` directory shipped a script that has nothing to do with the plugin.** The
  awesome-list submission script is repository housekeeping; it moved to `contrib/`, which is
  deliberately absent from `package.json#files`, so it no longer lands in anyone's install.

- **The entry description was adjectives where it could have been claims.** Review point 1 checks
  the description against the code, so "vision-native screenshots" was replaced by what can actually
  be verified: 12 `computer_*` tools, `computer_screenshot` returning a real image plus an
  image-to-screen pixel mapping, `expect_window` refusing input on a focus mismatch, and the Stop
  button / `Ctrl+Alt+Esc` blocking calls until re-approval. `tarball:` and its `latest/download/`
  form were confirmed against real entries already on the list.

## 0.3.16 (the fork relationship is stated where identity is read)

The README had always opened with "An **unofficial fork** of computer-user", credited jing-hy, and
disclaimed affiliation — but the **package metadata did not**. It read `author: "jing-hy"` with a
description that never mentioned a fork, which is precisely the shape a reviewer is told to look
askance at: a package that appears to be someone else's work re-uploaded under a different account.
Nothing here depended on a copy of anything (there are no `dependencies` at all), but the metadata
invited the question, so it is answered in the metadata now:

- `description` leads with "Unofficial fork of computer-user by jing-hy".
- `author` names the original **and** states that this is an unofficial fork with its home.
- `forkedFrom` records the upstream repository explicitly — a non-standard field, deliberately: it
  is for a human reading the manifest, not for tooling.

The **package name stays `computer-user`** and is not part of this change. `cordis.patch.yml`
registers the plugin under that specifier, so renaming it would stop a profile from dropping this
fork in where the original sat. The README now says so, so the choice does not have to be guessed.

Note that this repository is **not** a GitHub fork (`fork: false`, no `parent`): it was built from
the published 0.3.6 tarball rather than from a clone, and GitHub sets fork status only at creation.
The relationship is therefore carried by the README, `LICENSE`, this changelog and the metadata
above rather than by a platform badge.

## 0.3.15 (a repeatable submission for the awesome list)

- **`tools/open-awesome-pr.mjs`** prepares the `awesome-dsh-plugin` entry: it forks the list, then
  builds one commit containing one added file through the Git Data API, so the enormous upstream
  repository is never cloned. `--open` opens the PR as a draft. Re-running it is safe — the second
  run moves the branch instead of failing on it. That matters because the list's CI refuses any
  repository younger than one day, so the intended flow is to prepare now and open later.
- **The fork-then-probe trap is documented in the script.** `GET /git/ref/{ref}` wants
  `heads/<branch>`; passing `refs/heads/<branch>` 404s, which reads as "branch missing", so the
  following create fails with 422 and a re-run stops being safe. Measured here, then removed
  rather than worked around.

## 0.3.14 (the peer range actually admits the harness people run)

`@deepseek-ai/dsh-settings` was declared as `>=0.1.0-rc.6`. That looks broad and is not: node-semver
only lets a prerelease satisfy a range when *some* comparator in it carries the same
`major.minor.patch` tuple **and** a prerelease tag of its own. The harness shipping on this machine
is `0.1.5-rc.2`, whose tuple is `0.1.5` — no comparator in that range has it, so the requirement was
silently unsatisfiable and a fresh `dsh plugin add` would hand the user an `ERESOLVE` to work around
by hand.

Measured, not reasoned: `>=0.1.0-rc.6` → `0.1.0-rc.6` yes, **`0.1.5-rc.2` no**; the "match
everything" `>=0.0.0-0 <0.2.0-0` → no; and even an explicit `>=0.1.0-rc.6 <0.2.0-0` → no. Only
enumerating the prerelease tuples works:

```jsonc
">=0.1.0-rc.6 <0.1.5-0 || >=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0"
```

Verified across `0.1.0-rc.6` … `0.2.0` (prereleases included). The `dsh-plugin` topic is now set on
the repository as well.

## 0.3.13 (the repository is the upgraded plugin, and nothing else)

A download of this repository used to arrive as the upgraded plugin **plus** whatever the original
`computer-user` package happened to carry along — files nobody here had touched, referenced by
nothing, and indistinguishable at a glance from the parts that matter.

- **Removed the original package's leftovers.** `scripts/smoke-*.ps1` (seven unmodified upstream
  hand-test scripts) and `docs/upstream-README.md` (a copy of the original README) are gone. Neither
  was referenced by any file here, and the portable `verify/*.mjs` scripts superseded the smoke
  tests. The `LICENSE` stays: MIT requires the upstream copyright notice to travel with the code.
- **`package.json#files` now matches what the plugin actually is.** It still listed `scripts` (now
  gone) and omitted `tools`, so the installer added in 0.3.12 would not have been packaged at all.
  A published tarball and a `git clone` now contain the same set.
- **The doctor runs from the repository too.** `tools/computer-user-doctor.mjs` hard-coded its own
  location as `<profile>/scripts/`, which is where it is *deployed* — so running it straight from a
  checkout searched `<repo>/node_modules/computer-user` and reported a perfectly healthy profile as
  "package not installed". It now resolves the profile from either layout, with `CU_PROFILE_DIR` /
  `CU_PROFILE` overrides, and is verified working from both.

## 0.3.12 (a user message is the re-approval; the plugin stops carrying stale copies of itself)

- **A new user message now lifts a stop.** The stop marker is a hard gate — while it is set every
  `computer_*` call is refused, and the agent deliberately cannot clear it, so no agent can ever
  un-stop itself. But that made `/computer` and the chat switch the *only* ways back, so a user who
  simply typed *"go on, take over again"* was told to go and click a switch: the same instruction,
  demanded twice. A real user message already is an authorisation event, and an agent cannot forge
  one — `session/event` carries `source.kind`, which is `'user'` only for a message the human
  actually sent — so the plugin now listens for it and clears the marker, tracing the reason to
  `route.log`. The guarantee is unchanged: the stop still lands instantly, and only the user can
  lift it. The refusal message no longer tells the user to go and find a switch.

- **The plugin reports its real version.** `export const version` was a hard-coded `0.3.0` while the
  package had reached 0.3.11, so anything naming "the version the plugin says it is" pointed at the
  wrong code. It is now read from `package.json`, which removes the drift instead of documenting it.

- **`tools/install.mjs`: put a source checkout into a profile.** The fork is not on the registry, so
  a checkout had to be copied in by hand — which is exactly how the profile and the source drift
  apart, with the profile quietly serving an older copy while a fix appears to do nothing. The
  script derives the DSH home (`$DSH_HOME`, else `~/.dsh`) and takes the profile as an argument, so
  nothing is tied to one machine, and it **refuses** when the profile covers this package with a
  pnpm patch — the next `pnpm install` would re-apply that patch and silently undo the copy.

## 0.3.11 (the indicator stops stealing focus; activation failures stop lying)

Both defects surfaced while driving a real HTML5 game on 4399, and each one hid the other.

- **The control indicator seized the foreground the moment it appeared.** `overlay.ps1` showed the
  full-screen, topmost frame and halo with WinForms' `Show()` — which *activates* — while
  `WS_EX_NOACTIVATE` is only applied later, in the banner's `Shown` handler, because a window style
  cannot be set before its handle exists. So the overlay became the foreground window on every
  first appearance: focus was taken from whatever the user was typing in, and
  `computer_activate_window` reported failure because its success check compares the foreground
  window against the requested one and kept finding the overlay instead. The overlay now records
  the foreground window before showing and hands it straight back. Verified: with the indicator
  running (fresh heartbeat, process alive) the foreground stays the application, not the overlay.

- **A failed activation threw away every useful detail.** `context.ps1` returned `ok: $false` when
  the requested window did not come forward, but with no `error` field — and `ps.js` rejects on a
  false `ok`, so all the caller ever saw was a bare *"PowerShell 执行失败"*. The foreground record
  and the hint the script had already built ("a UWP or privileged window may be holding it; retrying
  usually works, or click its title bar") were built and then discarded. Activation now reports
  `ok: $true` with a separate `activated` flag, and `computer_activate_window` turns that into
  `activated: false` plus the hint instead of throwing.

- **`describeWindow` only assigns present fields**, the same lossless-JSON rule `describeElement`
  already followed: a single `undefined` property makes the harness discard the entire tool result.

Acceptance evidence for this release: `Ctrl+Alt+Esc` and the banner's Stop button each wrote the
correct stop marker with the indicator exiting cleanly; the mode gate refused the next call and
named the cause; the chat switch showed the amber "stopped by you" state within one poll interval;
a Notepad round-trip (type → `Ctrl+A`/`Ctrl+C` → clear → `Ctrl+V`) restored exactly the copied
text; `computer_scroll` advanced 5 notches = exactly 15 lines and returned to the identical line; a
two-line `computer_drag` selection landed its endpoints on the predicted rows to the character; and
in a live 4399 gomoku game the board was read back from pixels to confirm the stones actually
landed.

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
