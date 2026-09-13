# computer-user / overlay.ps1 - the "an agent is driving your computer" indicator.
#
# Shows three things while the plugin holds control of the desktop:
#   1. a slowly pulsing gradient along all four screen edges
#   2. a coloured halo that tracks the mouse cursor (the OS cursor bitmap itself
#      cannot be recoloured, so the halo is what actually changes colour)
#   3. a top banner naming the controller, with a Cancel button and a global
#      hotkey (default Ctrl+Alt+Esc) so the user can always take the wheel back
#
# It is a separate process from the DSH host on purpose: the indicator must keep
# rendering and stay clickable even if the agent loop stalls, and it must vanish
# on its own if the host dies. Liveness is therefore driven by a heartbeat file
# the host refreshes on every tool call - no heartbeat for `idleSeconds` and the
# overlay exits.
#
# Every window is WS_EX_NOACTIVATE so it never steals focus from the app being
# driven, and every decorative window is WS_EX_TRANSPARENT so it never swallows
# a click (the screen-edge strips would otherwise eat taskbar clicks).
#
# Input: -Json <base64(UTF8 JSON)>
#   { heartbeatFile, stopFile, label, hint, accentA, accentB, thickness,
#     idleSeconds, hotkeyMods, hotkeyVk }
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
} catch { Write-Output ('{"ok":false,"error":"bad json"}'); exit 2 }

$heartbeat = [string]$cfg.heartbeatFile
$stopFile = [string]$cfg.stopFile
$label = if ($cfg.label) { [string]$cfg.label } else { "An AI agent is controlling this computer" }
$hint = if ($cfg.hint) { [string]$cfg.hint } else { "Ctrl+Alt+Esc" }
$accentA = if ($cfg.accentA) { [string]$cfg.accentA } else { "#4D6BFE" }
$accentB = if ($cfg.accentB) { [string]$cfg.accentB } else { "#22D3EE" }
$thickness = if ($cfg.thickness) { [int]$cfg.thickness } else { 7 }
$idleSeconds = if ($cfg.idleSeconds) { [int]$cfg.idleSeconds } else { 25 }
$hotkeyMods = if ($null -ne $cfg.hotkeyMods) { [int]$cfg.hotkeyMods } else { 3 }   # MOD_ALT|MOD_CONTROL
$hotkeyVk = if ($null -ne $cfg.hotkeyVk) { [int]$cfg.hotkeyVk } else { 27 }        # VK_ESCAPE

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
  [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, int mods, int vk);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_LAYERED = 0x00080000;
  public const uint LWA_ALPHA = 0x2;
  public const uint LWA_COLORKEY = 0x1;
  public static void NoActivate(IntPtr h, bool clickThrough) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    ex |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED;
    if (clickThrough) ex |= WS_EX_TRANSPARENT;
    SetWindowLong(h, GWL_EXSTYLE, ex);
  }
  public static void SetAlpha(IntPtr h, byte a) { SetLayeredWindowAttributes(h, 0, a, LWA_ALPHA); }
  public static void SetKeyAlpha(IntPtr h, uint key, byte a) { SetLayeredWindowAttributes(h, key, a, LWA_ALPHA | LWA_COLORKEY); }
}
'@
Add-Type -TypeDefinition $native -ErrorAction Stop
[CUOverlayNative]::SetProcessDPIAware() | Out-Null

# A message filter is how a hotkey press reaches managed code without a subclass.
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

function New-Strip([int]$x, [int]$y, [int]$w, [int]$h, [bool]$horizontal) {
  $f = New-Object System.Windows.Forms.Form
  $f.FormBorderStyle = 'None'
  $f.ShowInTaskbar = $false
  $f.StartPosition = 'Manual'
  $f.TopMost = $true
  $f.SetBounds($x, $y, $w, $h)
  $f.add_Paint({
    param($sender, $e)
    $rc = $sender.ClientRectangle
    if ($rc.Width -le 0 -or $rc.Height -le 0) { return }
    $mode = if ($horizontal) { [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal }
            else { [System.Drawing.Drawing2D.LinearGradientMode]::Vertical }
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rc, $script:colA, $script:colB, $mode)
    try { $e.Graphics.FillRectangle($brush, $rc) } finally { $brush.Dispose() }
  })
  [void]$forms.Add($f)
  return $f
}

# Four click-through edge strips that together read as one glowing frame.
$top = New-Strip $vs.X $vs.Y $vs.Width $thickness $true
$bottom = New-Strip $vs.X ($vs.Y + $vs.Height - $thickness) $vs.Width $thickness $true
$left = New-Strip $vs.X $vs.Y $thickness $vs.Height $false
$right = New-Strip ($vs.X + $vs.Width - $thickness) $vs.Y $thickness $vs.Height $false

# Cursor halo: a small colour-keyed window that follows the pointer.
$haloSize = 92
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
  # TransparencyKey cannot express soft alpha: a semi-transparent pixel COMPOSITES
  # with the key colour instead of vanishing, so alpha-graded glow rings came out
  # as pink residue that the key never removed. Grade the ring BRIGHTNESS with
  # fully opaque colours instead, and keep edges hard so anti-aliasing cannot
  # fringe against the key colour either.
  $e.Graphics.SmoothingMode = 'None'
  $c = $script:haloColor
  $mid = $haloSize / 2
  for ($i = 4; $i -ge 1; $i--) {
    $outerness = ($i - 1) / 3.0                    # 1 = outermost, 0 = innermost
    $dim = 0.30 + 0.70 * (1 - $outerness)
    $col = [System.Drawing.Color]::FromArgb(
      255,
      [int]($c.R * $dim), [int]($c.G * $dim), [int]($c.B * $dim))
    $pen = New-Object System.Drawing.Pen($col, 2.0)
    try { $e.Graphics.DrawEllipse($pen, $mid - ($i * 9), $mid - ($i * 9), $i * 18, $i * 18) } finally { $pen.Dispose() }
  }
  $core = New-Object System.Drawing.Pen($c, 2.2)
  try { $e.Graphics.DrawEllipse($core, $mid - 8, $mid - 8, 16, 16) } finally { $core.Dispose() }
})
[void]$forms.Add($halo)

# Banner: the only interactive window.
$banner = New-Object System.Windows.Forms.Form
$banner.FormBorderStyle = 'None'
$banner.ShowInTaskbar = $false
$banner.StartPosition = 'Manual'
$banner.TopMost = $true
$banner.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 33)
$bannerWidth = 620
$bannerHeight = 46
$banner.SetBounds(
  [int]($vs.X + ($vs.Width - $bannerWidth) / 2),
  [int]($vs.Y + 10),
  $bannerWidth,
  $bannerHeight)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.SetBounds(0, 0, 4, $bannerHeight)
$accentBar.BackColor = $colA
$banner.Controls.Add($accentBar)

$txt = New-Object System.Windows.Forms.Label
$txt.AutoSize = $false
$txt.TextAlign = 'MiddleLeft'
$txt.SetBounds(18, 0, 400, $bannerHeight)
$txt.ForeColor = [System.Drawing.Color]::FromArgb(236, 240, 248)
$txt.BackColor = [System.Drawing.Color]::Transparent
$txt.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10.5, [System.Drawing.FontStyle]::Regular)
$txt.Text = $label
$banner.Controls.Add($txt)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.AutoSize = $false
$hintLabel.TextAlign = 'MiddleRight'
$hintLabel.SetBounds(400, 0, 110, $bannerHeight)
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(150, 158, 176)
$hintLabel.BackColor = [System.Drawing.Color]::Transparent
$hintLabel.Font = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
$hintLabel.Text = $hint
$banner.Controls.Add($hintLabel)

$cancel = New-Object System.Windows.Forms.Button
$cancel.SetBounds($bannerWidth - 108, 8, 96, 30)
$cancel.FlatStyle = 'Flat'
$cancel.FlatAppearance.BorderSize = 0
$cancel.BackColor = [System.Drawing.Color]::FromArgb(64, 74, 102)
$cancel.ForeColor = [System.Drawing.Color]::FromArgb(240, 244, 252)
$cancel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Regular)
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
$hotkeyOk = $false

$script:colA = $colA
$script:colB = $colB
$script:haloColor = $colA
$phase = 0.0

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60
$timer.add_Tick({
  # stop conditions -------------------------------------------------------
  if (Test-Path -LiteralPath $stopFile) { Stop-Overlay 'external'; return }
  if (-not [string]::IsNullOrWhiteSpace($heartbeat) -and (Test-Path -LiteralPath $heartbeat)) {
    $age = ([DateTime]::UtcNow - [System.IO.File]::GetLastWriteTimeUtc($heartbeat)).TotalSeconds
    if ($age -gt $idleSeconds) { Stop-Overlay 'idle'; return }
  }

  # slow pulse ------------------------------------------------------------
  $script:phase = ($script:phase + 0.035) % (2 * [Math]::PI)
  $pulse = 0.5 + 0.5 * [Math]::Sin($script:phase * 2)
  $alpha = [byte](70 + 110 * $pulse)

  # the decorative windows must exist before their handles are styled.
  # The halo is colour-keyed as well as alpha-blended, so it must never go
  # through plain SetAlpha - that would drop the key and show a magenta square.
  foreach ($f in @($script:topStrip, $script:bottomStrip, $script:leftStrip, $script:rightStrip)) {
    if ($f -and $f.IsHandleCreated) { [CUOverlayNative]::SetAlpha($f.Handle, $alpha) }
  }
  if ($script:haloForm -and $script:haloForm.IsHandleCreated) {
    [CUOverlayNative]::SetKeyAlpha($script:haloForm.Handle, [uint32]0x00FF00FF, $alpha)
  }

  # cursor halo -----------------------------------------------------------
  $p = [System.Windows.Forms.Cursor]::Position
  $script:haloForm.SetBounds(
    [int]($p.X - $script:haloSize / 2),
    [int]($p.Y - $script:haloSize / 2),
    $script:haloSize, $script:haloSize)
  $mix = 0.5 + 0.5 * [Math]::Sin($script:phase)
  $script:haloColor = [System.Drawing.Color]::FromArgb(
    255,
    [int]($script:colA.R + ($script:colB.R - $script:colA.R) * $mix),
    [int]($script:colA.G + ($script:colB.G - $script:colA.G) * $mix),
    [int]($script:colA.B + ($script:colB.B - $script:colA.B) * $mix))
  $script:haloForm.Invalidate()

  # keep the banner on top of fullscreen apps ------------------------------
  if ($script:bannerForm -and $script:bannerForm.IsHandleCreated) { $script:bannerForm.TopMost = $true }
})

$script:topStrip = $top
$script:bottomStrip = $bottom
$script:leftStrip = $left
$script:rightStrip = $right
$script:haloForm = $halo
$script:bannerForm = $banner
$script:haloSize = $haloSize

$banner.add_Shown({
  foreach ($pair in @(
      @{ f = $script:topStrip; ct = $true }, @{ f = $script:bottomStrip; ct = $true },
      @{ f = $script:leftStrip; ct = $true }, @{ f = $script:rightStrip; ct = $true },
      @{ f = $script:haloForm; ct = $true }, @{ f = $script:bannerForm; ct = $false })) {
    if ($pair.f -and $pair.f.IsHandleCreated) { [CUOverlayNative]::NoActivate($pair.f.Handle, $pair.ct) }
  }
  if ($script:haloForm.IsHandleCreated) {
    [CUOverlayNative]::SetKeyAlpha($script:haloForm.Handle, [uint32]0x00FF00FF, 255)
  }
  $hotkeyOk = [CUOverlayNative]::RegisterHotKey($script:bannerForm.Handle, 1, $hotkeyMods, $hotkeyVk)
  $script:timer.Start()
})

# Show every window without activating any of them.
foreach ($f in @($top, $bottom, $left, $right, $halo)) { $f.Show() }
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($banner)
} finally {
  $timer.Stop()
  try { [CUOverlayNative]::UnregisterHotKey($banner.Handle, 1) | Out-Null } catch { }
  foreach ($f in $forms) { try { $f.Close(); $f.Dispose() } catch { } }
  [System.Windows.Forms.Application]::RemoveMessageFilter($hotkeyFilter)
  # A user stop leaves the marker for the host; an exit without one is a no-op.
  if (-not $script:stopped) { Stop-Overlay 'closed' }
}
