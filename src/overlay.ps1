# computer-user / overlay.ps1 - the "an agent is driving your computer" indicator.
#
# Shows, while the plugin holds control of the desktop:
#   1. a slowly pulsing gradient frame on all four screen edges
#   2. a halo that follows the mouse and changes SHAPE with the cursor
#      (the OS cursor bitmap cannot be recoloured, so the halo is the thing
#      that visibly marks it)
#   3. a top banner naming the controller, with a Stop button and a global
#      hotkey (default Ctrl+Alt+Esc) so the user can always take the wheel back
#
# Three details are load-bearing:
#
#   * The frame is four NON-OVERLAPPING strips. Overlapping strips double-blend
#     at the corners, which makes the frame look crooked and uneven.
#   * WS_EX_LAYERED is added to windows that already exist, so every such window
#     gets a SetWindowPos(SWP_FRAMECHANGED) afterwards. Without it
#     SetLayeredWindowAttributes silently fails and the pulse is invisible.
#   * While the AI is capturing the screen the indicator must not exist in the
#     picture, so the host drops a pause file and every window hides until it is
#     removed. The indicator is for the human watching, not for the model.
#
# Input: -Json <base64(UTF8 JSON)>
#   { heartbeatFile, stopFile, pauseFile, label, stopLabel, hint, accentA,
#     accentB, thickness, idleSeconds, hotkeyMods, hotkeyVk }
# ASCII-only source: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so
# every user-visible string arrives through the UTF-8 base64 payload instead.
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($Json)) { Write-Output '{"ok":false,"error":"missing -Json"}'; exit 2 }
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
  $cfg = $raw | ConvertFrom-Json
} catch { Write-Output '{"ok":false,"error":"bad json"}'; exit 2 }

$heartbeat = [string]$cfg.heartbeatFile
$stopFile = [string]$cfg.stopFile
$pauseFile = [string]$cfg.pauseFile
$label = if ($cfg.label) { [string]$cfg.label } else { "An AI agent is controlling this computer" }
$hint = if ($cfg.hint) { [string]$cfg.hint } else { "Ctrl+Alt+Esc" }
$accentA = if ($cfg.accentA) { [string]$cfg.accentA } else { "#4D6BFE" }
$accentB = if ($cfg.accentB) { [string]$cfg.accentB } else { "#22D3EE" }
$thickness = if ($cfg.thickness) { [int]$cfg.thickness } else { 7 }
$idleSeconds = if ($cfg.idleSeconds) { [int]$cfg.idleSeconds } else { 25 }
$hotkeyMods = if ($null -ne $cfg.hotkeyMods) { [int]$cfg.hotkeyMods } else { 3 }
$hotkeyVk = if ($null -ne $cfg.hotkeyVk) { [int]$cfg.hotkeyVk } else { 27 }

function HexToColor([string]$hex) {
  $h = $hex.TrimStart('#')
  return [System.Drawing.Color]::FromArgb(
    255,
    [Convert]::ToInt32($h.Substring(0, 2), 16),
    [Convert]::ToInt32($h.Substring(2, 2), 16),
    [Convert]::ToInt32($h.Substring(4, 2), 16))
}

# Must load before any System.Drawing type is touched.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop

$colA = HexToColor $accentA
$colB = HexToColor $accentB

$native = @'
using System;
using System.Runtime.InteropServices;
public class CUOverlayNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr h, int id, int mods, int vk);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr inst, int id);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_LAYERED = 0x00080000;
  public const uint LWA_ALPHA = 0x2;
  public const uint LWA_COLORKEY = 0x1;
  public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4,
                    SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
  public const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

  /** Make a window decorative: never focused, never a click target when asked. */
  public static void NoActivate(IntPtr h, bool clickThrough) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    ex |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED;
    if (clickThrough) ex |= WS_EX_TRANSPARENT;
    SetWindowLong(h, GWL_EXSTYLE, ex);
    // WS_EX_LAYERED added to an EXISTING window only takes effect after a frame
    // change. Skip this and SetLayeredWindowAttributes fails silently, which is
    // exactly how the breathing animation disappeared before.
    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  public static void SetAlpha(IntPtr h, byte a) { SetLayeredWindowAttributes(h, 0, a, LWA_ALPHA); }
  public static void SetKeyAlpha(IntPtr h, uint key, byte a) { SetLayeredWindowAttributes(h, key, a, LWA_ALPHA | LWA_COLORKEY); }
  public static void Hide(IntPtr h) { ShowWindow(h, SW_HIDE); }
  public static void ShowNoActivate(IntPtr h) { ShowWindow(h, SW_SHOWNOACTIVATE); }

  /** The IDC_* id matching the live cursor, or 0 when the app uses its own art. */
  public static int CursorShape() {
    var ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci)) return 0;
    int[] ids = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651 };
    foreach (int id in ids) {
      IntPtr h = LoadCursor(IntPtr.Zero, id);
      if (h != IntPtr.Zero && h == ci.hCursor) return id;
    }
    return 0;
  }
}
'@
Add-Type -TypeDefinition $native -ErrorAction Stop

# Per-monitor DPI awareness v2 first. Plain SetProcessDPIAware() only makes the
# process system-DPI aware, so on a mixed-DPI desk Windows bitmap-stretches the
# overlay on secondary monitors and the frame stops landing on the real edges.
# The context call only exists on newer Windows, so fall back rather than fail.
$dpiOk = $false
try { $dpiOk = [CUOverlayNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $dpiOk = $false }
if (-not $dpiOk) { [CUOverlayNative]::SetProcessDPIAware() | Out-Null }

# Everything below is authored at 100% and scaled here, so the same code reads the
# same on a 1366x768 laptop, a plain 1920x1080 desktop and a 200%-scaled 4K panel.
$systemDpi = 96
try {
  $probe = [int][CUOverlayNative]::GetDpiForSystem()
  if ($probe -gt 0) { $systemDpi = $probe }
} catch { $systemDpi = 96 }
$uiScale = $systemDpi / 96.0
$thickness = [Math]::Max(3, [int][Math]::Round($thickness * $uiScale))

$filterSrc = @'
using System;
using System.Windows.Forms;
public class CUHotkeyFilter : IMessageFilter {
  public event EventHandler Fired;
  public bool PreFilterMessage(ref Message m) {
    if (m.Msg == 0x0312) { var h = Fired; if (h != null) h(this, EventArgs.Empty); return true; }
    return false;
  }
}
'@
Add-Type -TypeDefinition $filterSrc -ReferencedAssemblies System.Windows.Forms -ErrorAction Stop

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$stopped = $false
$forms = New-Object System.Collections.ArrayList

# --- the frame -------------------------------------------------------------
# Four strips that TILE the border without overlapping: the vertical strips are
# inset by the thickness so each corner belongs to exactly one window. Overlap
# would double-blend there and make the frame look crooked.
function New-Strip([int]$x, [int]$y, [int]$w, [int]$h, [bool]$horizontal, $from, $to) {
  $f = New-Object System.Windows.Forms.Form
  $f.FormBorderStyle = 'None'
  $f.ShowInTaskbar = $false
  $f.StartPosition = 'Manual'
  $f.TopMost = $true
  $f.SetBounds($x, $y, $w, $h)
  # GetNewClosure() captures $from/$to/$horizontal per strip. Passing them through
  # a script-scope variable instead made the FIRST strip paint before that
  # variable was set, so its brush was built from null, the Paint handler threw,
  # and that edge simply never appeared - which is exactly the asymmetry being
  # reported.
  $f.add_Paint({
    param($sender, $e)
    $rc = $sender.ClientRectangle
    if ($rc.Width -le 0 -or $rc.Height -le 0) { return }
    $mode = if ($horizontal) { [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal }
            else { [System.Drawing.Drawing2D.LinearGradientMode]::Vertical }
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rc, $from, $to, $mode)
    try { $e.Graphics.FillRectangle($brush, $rc) } finally { $brush.Dispose() }
  }.GetNewClosure())
  [void]$forms.Add($f)
  return $f
}

# The frame's colour flows around the perimeter instead of restarting on every
# edge. With an independent A->B gradient per edge the corners disagree - the
# top-left is blue/blue while the top-right is cyan/blue and the bottom-right is
# cyan/cyan - and that reads as a crooked, asymmetric frame however level the
# geometry actually is. Parameterising the perimeter diagonally makes every
# corner agree: TL=A, TR=mid, BR=B, BL=mid.
$colMid = [System.Drawing.Color]::FromArgb(
  255,
  [int](($colA.R + $colB.R) / 2),
  [int](($colA.G + $colB.G) / 2),
  [int](($colA.B + $colB.B) / 2))

$top = New-Strip $vs.X $vs.Y $vs.Width $thickness $true $colA $colMid
$bottom = New-Strip $vs.X ($vs.Y + $vs.Height - $thickness) $vs.Width $thickness $true $colMid $colB
$left = New-Strip $vs.X ($vs.Y + $thickness) $thickness ($vs.Height - 2 * $thickness) $false $colA $colMid
$right = New-Strip ($vs.X + $vs.Width - $thickness) ($vs.Y + $thickness) $thickness ($vs.Height - 2 * $thickness) $false $colMid $colB

# --- the cursor halo -------------------------------------------------------
$haloSize = [int][Math]::Max(48, [Math]::Round(96 * $uiScale))

function New-DimColor([System.Drawing.Color]$c, [double]$dim) {
  return [System.Drawing.Color]::FromArgb(255, [int]($c.R * $dim), [int]($c.G * $dim), [int]($c.B * $dim))
}

# A stadium (rounded capsule) outline: two straight sides plus two round caps.
# Rotating the graphics context is what lets one routine draw the horizontal,
# the vertical and both diagonal resize shapes.
function Draw-Stadium($g, $pen, [double]$cx, [double]$cy, [double]$w, [double]$h, [double]$angle) {
  $state = $g.Save()
  try {
    $g.TranslateTransform([single]$cx, [single]$cy)
    if ($angle -ne 0) { $g.RotateTransform([single]$angle) }
    if ($w -ge $h) {
      $r = $h / 2
      $g.DrawLine($pen, [single](-$w / 2 + $r), [single](-$h / 2), [single]($w / 2 - $r), [single](-$h / 2))
      $g.DrawLine($pen, [single](-$w / 2 + $r), [single]($h / 2), [single]($w / 2 - $r), [single]($h / 2))
      $g.DrawArc($pen, [single](-$w / 2), [single](-$h / 2), [single]$h, [single]$h, 90, 180)
      $g.DrawArc($pen, [single]($w / 2 - $h), [single](-$h / 2), [single]$h, [single]$h, 270, 180)
    } else {
      $r = $w / 2
      $g.DrawLine($pen, [single](-$w / 2), [single](-$h / 2 + $r), [single](-$w / 2), [single]($h / 2 - $r))
      $g.DrawLine($pen, [single]($w / 2), [single](-$h / 2 + $r), [single]($w / 2), [single]($h / 2 - $r))
      $g.DrawArc($pen, [single](-$w / 2), [single](-$h / 2), [single]$w, [single]$w, 180, 180)
      $g.DrawArc($pen, [single](-$w / 2), [single]($h / 2 - $w), [single]$w, [single]$w, 0, 180)
    }
  } finally { $g.Restore($state) }
}

# IDC_* ids reported by the native helper.
$CUR_IBEAM = 32513; $CUR_CROSS = 32515
$CUR_SIZENWSE = 32642; $CUR_SIZENESW = 32643; $CUR_SIZEWE = 32644; $CUR_SIZENS = 32645
$CUR_SIZEALL = 32646; $CUR_NO = 32648

function Draw-HaloShape($g, [int]$cursorId, [System.Drawing.Color]$bright, [System.Drawing.Color]$dim, [double]$scale) {
  $mid = $haloSize / 2
  $penBright = New-Object System.Drawing.Pen($bright, 1.8)
  $penDim = New-Object System.Drawing.Pen($dim, 1.4)
  try {
    switch ($cursorId) {
      $CUR_IBEAM {
        Draw-Stadium $g $penBright $mid $mid (14 * $scale) (40 * $scale) 0
        Draw-Stadium $g $penDim $mid $mid (24 * $scale) (52 * $scale) 0
      }
      $CUR_SIZENS {
        Draw-Stadium $g $penBright $mid $mid (16 * $scale) (42 * $scale) 0
        Draw-Stadium $g $penDim $mid $mid (26 * $scale) (54 * $scale) 0
      }
      $CUR_SIZEWE {
        Draw-Stadium $g $penBright $mid $mid (42 * $scale) (16 * $scale) 0
        Draw-Stadium $g $penDim $mid $mid (54 * $scale) (26 * $scale) 0
      }
      $CUR_SIZENWSE {
        Draw-Stadium $g $penBright $mid $mid (42 * $scale) (16 * $scale) 45
        Draw-Stadium $g $penDim $mid $mid (54 * $scale) (26 * $scale) 45
      }
      $CUR_SIZENESW {
        Draw-Stadium $g $penBright $mid $mid (42 * $scale) (16 * $scale) -45
        Draw-Stadium $g $penDim $mid $mid (54 * $scale) (26 * $scale) -45
      }
      $CUR_SIZEALL {
        Draw-Stadium $g $penBright $mid $mid (40 * $scale) (40 * $scale) 0
        Draw-Stadium $g $penBright $mid $mid (40 * $scale) (40 * $scale) 45
        Draw-Stadium $g $penDim $mid $mid (54 * $scale) (54 * $scale) 0
      }
      $CUR_CROSS {
        $r = 22 * $scale
        $g.DrawLine($penBright, [single]($mid - $r), [single]$mid, [single]($mid + $r), [single]$mid)
        $g.DrawLine($penBright, [single]$mid, [single]($mid - $r), [single]$mid, [single]($mid + $r))
        $g.DrawEllipse($penDim, [single]($mid - $r), [single]($mid - $r), [single](2 * $r), [single](2 * $r))
      }
      $CUR_NO {
        $r = 20 * $scale
        $g.DrawEllipse($penBright, [single]($mid - $r), [single]($mid - $r), [single](2 * $r), [single](2 * $r))
        $d = $r * 0.72
        $g.DrawLine($penBright, [single]($mid - $d), [single]($mid + $d), [single]($mid + $d), [single]($mid - $d))
      }
      default {
        # Arrow, text-hand, busy, and any app-drawn cursor: a ring reads as
        # "this pointer is being driven" without pretending to be a shape.
        $r = 15 * $scale
        $g.DrawEllipse($penBright, [single]($mid - $r), [single]($mid - $r), [single](2 * $r), [single](2 * $r))
        $r2 = 24 * $scale
        $g.DrawEllipse($penDim, [single]($mid - $r2), [single]($mid - $r2), [single](2 * $r2), [single](2 * $r2))
      }
    }
  } finally { $penBright.Dispose(); $penDim.Dispose() }
}

$halo = New-Object System.Windows.Forms.Form
$halo.FormBorderStyle = 'None'
$halo.ShowInTaskbar = $false
$halo.StartPosition = 'Manual'
$halo.TopMost = $true
$halo.BackColor = [System.Drawing.Color]::Magenta
$halo.TransparencyKey = [System.Drawing.Color]::Magenta
$halo.SetBounds(0, 0, $haloSize, $haloSize)
$halo.add_Paint({
  param($sender, $e)
  # TransparencyKey cannot express soft alpha - a semi-transparent pixel
  # composites with the key colour instead of vanishing, which is what once
  # turned these rings pink. Keep every stroke fully opaque.
  $e.Graphics.SmoothingMode = 'None'
  $c = $script:haloColor
  Draw-HaloShape $e.Graphics $script:cursorShape (New-DimColor $c 1.0) (New-DimColor $c 0.5) $script:uiScale
})
[void]$forms.Add($halo)

# --- the banner (the only interactive window) ------------------------------
$banner = New-Object System.Windows.Forms.Form
$banner.FormBorderStyle = 'None'
$banner.ShowInTaskbar = $false
$banner.StartPosition = 'Manual'
$banner.TopMost = $true
$banner.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 33)
$bannerWidth = [int][Math]::Round(620 * $uiScale)
$bannerHeight = [int][Math]::Round(46 * $uiScale)
$banner.SetBounds(
  [int]($vs.X + ($vs.Width - $bannerWidth) / 2),
  [int]($vs.Y + [Math]::Round(10 * $uiScale)),
  $bannerWidth,
  $bannerHeight)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.SetBounds(0, 0, [int][Math]::Round(4 * $uiScale), $bannerHeight)
$accentBar.BackColor = $colA
$banner.Controls.Add($accentBar)

$txt = New-Object System.Windows.Forms.Label
$txt.AutoSize = $false
$txt.TextAlign = 'MiddleLeft'
$txt.SetBounds([int][Math]::Round(18 * $uiScale), 0, [int][Math]::Round(370 * $uiScale), $bannerHeight)
$txt.ForeColor = [System.Drawing.Color]::FromArgb(236, 240, 248)
$txt.BackColor = [System.Drawing.Color]::Transparent
$txt.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](10.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$txt.Text = $label
$banner.Controls.Add($txt)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.AutoSize = $false
$hintLabel.TextAlign = 'MiddleRight'
$hintLabel.SetBounds([int][Math]::Round(400 * $uiScale), 0, [int][Math]::Round(110 * $uiScale), $bannerHeight)
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(150, 158, 176)
$hintLabel.BackColor = [System.Drawing.Color]::Transparent
$hintLabel.Font = New-Object System.Drawing.Font('Segoe UI', [single](8.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$hintLabel.Text = $hint
$banner.Controls.Add($hintLabel)

$cancel = New-Object System.Windows.Forms.Button
$cancel.SetBounds(
  [int][Math]::Round($bannerWidth - 108 * $uiScale),
  [int][Math]::Round(8 * $uiScale),
  [int][Math]::Round(96 * $uiScale),
  [int][Math]::Round(30 * $uiScale))
$cancel.FlatStyle = 'Flat'
$cancel.FlatAppearance.BorderSize = 0
$cancel.BackColor = [System.Drawing.Color]::FromArgb(64, 74, 102)
$cancel.ForeColor = [System.Drawing.Color]::FromArgb(240, 244, 252)
$cancel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](9.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$cancel.Text = if ($cfg.stopLabel) { [string]$cfg.stopLabel } else { "Stop" }
$cancel.Cursor = [System.Windows.Forms.Cursors]::Hand
$cancel.UseVisualStyleBackColor = $false
$banner.Controls.Add($cancel)
[void]$forms.Add($banner)

function Stop-Overlay([string]$reason) {
  if ($script:stopped) { return }
  $script:stopped = $true
  # Only an explicit user action writes the marker. An idle reap or a host
  # shutdown must NOT leave one behind, or the host would read it as "the user
  # stopped control" and refuse to work until a fresh approval.
  if ($reason -eq 'button' -or $reason -eq 'hotkey') {
    try {
      $dir = [System.IO.Path]::GetDirectoryName($stopFile)
      if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
      [System.IO.File]::WriteAllText($stopFile, $reason, [System.Text.Encoding]::UTF8)
    } catch { }
  }
  try { [System.Windows.Forms.Application]::ExitThread() } catch { }
}

$cancel.add_Click({ Stop-Overlay 'button' })

$hotkeyFilter = New-Object CUHotkeyFilter
$hotkeyFilter.add_Fired({ Stop-Overlay 'hotkey' })
[System.Windows.Forms.Application]::AddMessageFilter($hotkeyFilter)

$script:colA = $colA
$script:colB = $colB
$script:uiScale = $uiScale
$script:haloColor = $colA
$script:haloSize = $haloSize
$script:cursorShape = 0
$script:topStrip = $top
$script:bottomStrip = $bottom
$script:leftStrip = $left
$script:rightStrip = $right
$script:haloForm = $halo
$script:bannerForm = $banner
$script:allForms = @($top, $bottom, $left, $right, $halo, $banner)
$script:hidden = $false
$script:phase = 0.0

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.add_Tick({
  # stop conditions -------------------------------------------------------
  if (Test-Path -LiteralPath $stopFile) { Stop-Overlay 'external'; return }
  if (-not [string]::IsNullOrWhiteSpace($heartbeat) -and (Test-Path -LiteralPath $heartbeat)) {
    $age = ([DateTime]::UtcNow - [System.IO.File]::GetLastWriteTimeUtc($heartbeat)).TotalSeconds
    if ($age -gt $idleSeconds) { Stop-Overlay 'idle'; return }
  }

  # hide while the AI captures the screen ---------------------------------
  $shouldHide = (-not [string]::IsNullOrWhiteSpace($pauseFile)) -and (Test-Path -LiteralPath $pauseFile)
  if ($shouldHide -ne $script:hidden) {
    foreach ($f in $script:allForms) {
      if (-not $f.IsHandleCreated) { continue }
      if ($shouldHide) { [CUOverlayNative]::Hide($f.Handle) }
      else { [CUOverlayNative]::ShowNoActivate($f.Handle) }
    }
    $script:hidden = $shouldHide
  }

  # slow pulse ------------------------------------------------------------
  # ~50ms ticks with this phase step give a full breath every ~5 seconds.
  $script:phase = ($script:phase + 0.042) % (2 * [Math]::PI)
  $pulse = 0.5 + 0.5 * [Math]::Sin($script:phase)
  $alpha = [byte](45 + 165 * $pulse)
  if (-not $script:hidden) {
    foreach ($f in @($script:topStrip, $script:bottomStrip, $script:leftStrip, $script:rightStrip)) {
      if ($f -and $f.IsHandleCreated) { [CUOverlayNative]::SetAlpha($f.Handle, $alpha) }
    }
    # The halo is colour-keyed as well as alpha-blended, so it must never go
    # through plain SetAlpha - that would drop the key and show a magenta square.
    if ($script:haloForm -and $script:haloForm.IsHandleCreated) {
      [CUOverlayNative]::SetKeyAlpha($script:haloForm.Handle, [uint32]0x00FF00FF, [byte](120 + 135 * $pulse))
    }
  }

  # cursor halo -----------------------------------------------------------
  $p = [System.Windows.Forms.Cursor]::Position
  $script:haloForm.SetBounds(
    [int]($p.X - $script:haloSize / 2),
    [int]($p.Y - $script:haloSize / 2),
    $haloSize, $haloSize)

  $shape = [CUOverlayNative]::CursorShape()
  $mix = 0.5 + 0.5 * [Math]::Sin($script:phase)
  $newColor = [System.Drawing.Color]::FromArgb(
    255,
    [int]($script:colA.R + ($script:colB.R - $script:colA.R) * $mix),
    [int]($script:colA.G + ($script:colB.G - $script:colA.G) * $mix),
    [int]($script:colA.B + ($script:colB.B - $script:colA.B) * $mix))
  if ($shape -ne $script:cursorShape -or $newColor.ToArgb() -ne $script:haloColor.ToArgb()) {
    $script:cursorShape = $shape
    $script:haloColor = $newColor
    $script:haloForm.Invalidate()
  }

  if ($script:bannerForm -and $script:bannerForm.IsHandleCreated -and -not $script:hidden) {
    $script:bannerForm.TopMost = $true
  }
})

$banner.add_Shown({
  foreach ($pair in @(
      @{ f = $script:topStrip; ct = $true }, @{ f = $script:bottomStrip; ct = $true },
      @{ f = $script:leftStrip; ct = $true }, @{ f = $script:rightStrip; ct = $true },
      @{ f = $script:haloForm; ct = $true }, @{ f = $script:bannerForm; ct = $false })) {
    if ($pair.f -and $pair.f.IsHandleCreated) { [CUOverlayNative]::NoActivate($pair.f.Handle, $pair.ct) }
  }
  if ($script:haloForm.IsHandleCreated) {
    [CUOverlayNative]::SetKeyAlpha($script:haloForm.Handle, [uint32]0x00FF00FF, 235)
  }
  foreach ($f in @($script:topStrip, $script:bottomStrip, $script:leftStrip, $script:rightStrip)) {
    if ($f.IsHandleCreated) { [CUOverlayNative]::SetAlpha($f.Handle, 140) }
  }
  [CUOverlayNative]::RegisterHotKey($script:bannerForm.Handle, 1, $hotkeyMods, $hotkeyVk) | Out-Null
  $timer.Start()
})

foreach ($f in @($top, $bottom, $left, $right, $halo)) { $f.Show() }
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($banner)
} finally {
  $timer.Stop()
  try { [CUOverlayNative]::UnregisterHotKey($banner.Handle, 1) | Out-Null } catch { }
  foreach ($f in $forms) { try { $f.Close(); $f.Dispose() } catch { } }
  [System.Windows.Forms.Application]::RemoveMessageFilter($hotkeyFilter)
  if (-not $script:stopped) { Stop-Overlay 'closed' }
}
