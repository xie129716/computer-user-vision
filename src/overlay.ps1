# computer-user-vision / overlay.ps1 - the "an agent is driving your computer" indicator.
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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr inst, int id);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_LAYERED = 0x00080000;
  public const int WS_EX_TOPMOST = 0x00000008;
  public const uint LWA_ALPHA = 0x2;
  public const uint LWA_COLORKEY = 0x1;
  public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4,
                    SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_NOOWNERZORDER = 0x200;
  public const int SW_HIDE = 0, SW_SHOWNOACTIVATE = 4;

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

  /** Make a window decorative: never focused, never a click target when asked. */
  public static void NoActivate(IntPtr h, bool clickThrough, bool layered) {
    int ex = GetWindowLong(h, GWL_EXSTYLE);
    ex |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
    if (layered) ex |= WS_EX_LAYERED;
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

  /**
   * Place a window at an exact size, bypassing Windows' minimum window size.
   *
   * A Form with FormBorderStyle=None is still a plain OVERLAPPED window - WinForms
   * does not give it WS_POPUP - and DefWindowProc clamps an overlapped window to
   * SM_CXMIN x SM_CYMIN. Measured on this machine: 136x39. The Stop button is
   * 96x30, so the brake window came out 136x39: 28px of dead strip past the
   * banner's right edge and 40px more height than the button it holds.
   *
   * The clamp is applied when the bounds are SET (WinForms' SetBounds goes through
   * WM_WINDOWPOSCHANGING), not by SetWindowPos itself - verified by measuring a
   * 96x30 window before and after this call. So this is the fix, and it needs the
   * handle to exist already.
   */
  public static bool PlaceExactly(IntPtr h, int x, int y, int cx, int cy) {
    return SetWindowPos(h, IntPtr.Zero, x, y, cx, cy, SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  }

  /** True while the window still carries WS_EX_TOPMOST. */
  public static bool IsTopMost(IntPtr h) { return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0; }

  /** Re-assert topmost z-order, touching nothing else. */
  public static void ReassertTopMost(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1) /* HWND_TOPMOST */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst,
    ref LPOINT pptDst, ref LSIZE psize, IntPtr hdcSrc, ref LPOINT pptSrc, uint crKey,
    ref LBLEND pblend, uint dwFlags);

  [StructLayout(LayoutKind.Sequential)] public struct LSIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential)] public struct LPOINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  public struct LBLEND { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

  /**
   * Commit an HBITMAP to a layered window with REAL per-pixel alpha.
   *
   * This replaces the TransparencyKey approach entirely. A colour key cannot
   * express partial transparency - a semi-transparent pixel composites with the
   * key colour instead of vanishing - which is what ate the gradient, tinted it
   * pink and squeezed a 7px band down to 1-2px. UpdateLayeredWindow takes a 32bpp
   * ARGB bitmap directly, so every pixel carries its own alpha and nothing gets
   * keyed away. SourceConstantAlpha applies the global pulse without redrawing.
   */
  public static bool PushHBitmap(IntPtr hwnd, IntPtr hBmp, int w, int h, int x, int y, int alpha) {
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr old = IntPtr.Zero;
    try {
      old = SelectObject(memDc, hBmp);
      LSIZE size; size.cx = w; size.cy = h;
      LPOINT src; src.x = 0; src.y = 0;
      LPOINT dst; dst.x = x; dst.y = y;
      LBLEND blend;
      blend.BlendOp = 0;          /* AC_SRC_OVER */
      blend.BlendFlags = 0;
      blend.SourceConstantAlpha = (byte)alpha;
      blend.AlphaFormat = 1;      /* AC_SRC_ALPHA */
      return UpdateLayeredWindow(hwnd, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);
    } finally {
      if (old != IntPtr.Zero) SelectObject(memDc, old);
      DeleteDC(memDc);
      ReleaseDC(IntPtr.Zero, screenDc);
    }
  }

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

# --- the frame: ONE full-screen window -------------------------------------
# It used to be four thin strip windows, which failed for a reason no geometry
# could fix: Windows enforces a minimum window size (SM_CXMIN/SM_CYMIN = 136x39
# on this machine), so a 7px-tall window was stretched to 39 and a 7px-wide one
# to 136 - the left and top edges came out several times thicker than the right
# and bottom. A screen-sized window cannot be stretched, so that whole failure
# mode disappears; and with a single Paint there is no per-edge closure to get
# wrong. The interior is colour-keyed away and the window is click-through, so
# only the four bands are ever visible or hit-testable.
$colMid = [System.Drawing.Color]::FromArgb(
  255,
  [int](($colA.R + $colB.R) / 2),
  [int](($colA.G + $colB.G) / 2),
  [int](($colA.B + $colB.B) / 2))

$frame = New-Object System.Windows.Forms.Form
$frame.FormBorderStyle = 'None'
$frame.ShowInTaskbar = $false
$frame.StartPosition = 'Manual'
$frame.TopMost = $true
$frame.SetBounds($vs.X, $vs.Y, $vs.Width, $vs.Height)
[void]$forms.Add($frame)

# The frame is drawn ONCE into a 32bpp ARGB bitmap at full screen size. Every
# pulse tick only re-commits that bitmap with a different SourceConstantAlpha,
# which costs no drawing at all. Nothing here is colour-keyed, so the gradient
# keeps its real colours and its real 7px width.
[int]$frmW = $vs.Width
[int]$frmH = $vs.Height
[int]$fbt = $thickness
$frameBmp = New-Object System.Drawing.Bitmap($frmW, $frmH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$fg = [System.Drawing.Graphics]::FromImage($frameBmp)
try {
  $fg.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $fg.SmoothingMode = 'None'
  # The colour flows around the perimeter (TL=A, TR=mid, BR=B, BL=mid) instead of
  # restarting per edge, so the four corners agree.
  $rTop = New-Object System.Drawing.Rectangle(0, 0, $frmW, $fbt)
  $rBottom = New-Object System.Drawing.Rectangle(0, ($frmH - $fbt), $frmW, $fbt)
  $rLeft = New-Object System.Drawing.Rectangle(0, $fbt, $fbt, ($frmH - 2 * $fbt))
  $rRight = New-Object System.Drawing.Rectangle(($frmW - $fbt), $fbt, $fbt, ($frmH - 2 * $fbt))
  $bTop = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rTop, $colA, $colMid, [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
  $bBottom = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rBottom, $colMid, $colB, [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
  $bLeft = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rLeft, $colA, $colMid, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $bRight = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rRight, $colMid, $colB, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  try {
    $fg.FillRectangle($bTop, $rTop)
    $fg.FillRectangle($bBottom, $rBottom)
    $fg.FillRectangle($bLeft, $rLeft)
    $fg.FillRectangle($bRight, $rRight)
  } finally {
    $bTop.Dispose(); $bBottom.Dispose(); $bLeft.Dispose(); $bRight.Dispose()
  }
} finally { $fg.Dispose() }
$frmHB = $frameBmp.GetHbitmap([System.Drawing.Color]::FromArgb(0, 0, 0, 0))

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
$halo.SetBounds(0, 0, $haloSize, $haloSize)
[void]$forms.Add($halo)

# The halo is an ARGB bitmap too: drawn into a transparent surface, so the ring's
# soft edges are real alpha instead of a colour key that would tint them pink.
function New-HaloBitmap([System.Drawing.Color]$colour) {
  $bmp = New-Object System.Drawing.Bitmap($script:haloSize, $script:haloSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    $g.SmoothingMode = 'AntiAlias'
    Draw-HaloShape $g $script:cursorShape $colour (New-DimColor $colour 0.5) $script:uiScale
  } finally { $g.Dispose() }
  return $bmp
}

# --- the banner: TWO windows, so only the brake can eat a click -------------
# This used to be one 620x46 window, and that whole strip swallowed mouse input.
# The obvious fix - WS_EX_TRANSPARENT on it - was tried and MEASURED to break the
# Stop button: because the banner is WS_EX_LAYERED, hit-testing is done for the
# WHOLE layer, so the style took the button's children with it and every probe
# point inside the button rect returned the window underneath. The emergency brake
# must not rest on a subtlety like that, so the banner is split instead:
#
#   * $deco   - background, accent bar and both labels. Click-through, layered,
#               non-activating: the 620x46 strip now costs the user nothing.
#   * $brake  - a window exactly the size of the Stop button (96x30) holding only
#               that button. Deliberately NOT layered and NOT transparent, so it
#               is the single place in the indicator that can consume a click.
#
# The two rects are adjacent and never overlap (the hint label ends at base 510,
# the brake begins at base 512), so it still reads as one banner, and the area that
# can swallow a click drops from 620x46 to 96x30.
$bannerBack = [System.Drawing.Color]::FromArgb(24, 26, 33)
$bannerWidth = [int][Math]::Round(620 * $uiScale)
$bannerHeight = [int][Math]::Round(46 * $uiScale)
$bannerX = [int]($vs.X + ($vs.Width - $bannerWidth) / 2)
$bannerY = [int]($vs.Y + [Math]::Round(10 * $uiScale))

$deco = New-Object System.Windows.Forms.Form
$deco.FormBorderStyle = 'None'
$deco.ShowInTaskbar = $false
$deco.StartPosition = 'Manual'
$deco.TopMost = $true
$deco.BackColor = $bannerBack
$deco.SetBounds($bannerX, $bannerY, $bannerWidth, $bannerHeight)

$accentBar = New-Object System.Windows.Forms.Panel
$accentBar.SetBounds(0, 0, [int][Math]::Round(4 * $uiScale), $bannerHeight)
$accentBar.BackColor = $colA
$deco.Controls.Add($accentBar)

$txt = New-Object System.Windows.Forms.Label
$txt.AutoSize = $false
$txt.TextAlign = 'MiddleLeft'
$txt.SetBounds([int][Math]::Round(18 * $uiScale), 0, [int][Math]::Round(370 * $uiScale), $bannerHeight)
$txt.ForeColor = [System.Drawing.Color]::FromArgb(236, 240, 248)
$txt.BackColor = [System.Drawing.Color]::Transparent
$txt.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](10.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$txt.Text = $label
$deco.Controls.Add($txt)

$hintLabel = New-Object System.Windows.Forms.Label
$hintLabel.AutoSize = $false
$hintLabel.TextAlign = 'MiddleRight'
$hintLabel.SetBounds([int][Math]::Round(400 * $uiScale), 0, [int][Math]::Round(110 * $uiScale), $bannerHeight)
$hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(150, 158, 176)
$hintLabel.BackColor = [System.Drawing.Color]::Transparent
$hintLabel.Font = New-Object System.Drawing.Font('Segoe UI', [single](8.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$hintLabel.Text = $hint
$deco.Controls.Add($hintLabel)

$brakeW = [int][Math]::Round(96 * $uiScale)
$brakeH = [int][Math]::Round(30 * $uiScale)
$brakeX = $bannerX + $bannerWidth - $brakeW - [int][Math]::Round(12 * $uiScale)
$brakeY = $bannerY + [int][Math]::Round(8 * $uiScale)
$brake = New-Object System.Windows.Forms.Form
$brake.FormBorderStyle = 'None'
$brake.ShowInTaskbar = $false
$brake.StartPosition = 'Manual'
$brake.TopMost = $true
$brake.BackColor = $bannerBack
$brake.SetBounds($brakeX, $brakeY, $brakeW, $brakeH)

$cancel = New-Object System.Windows.Forms.Button
$cancel.SetBounds(0, 0, $brakeW, $brakeH)
$cancel.FlatStyle = 'Flat'
$cancel.FlatAppearance.BorderSize = 0
$cancel.BackColor = [System.Drawing.Color]::FromArgb(64, 74, 102)
$cancel.ForeColor = [System.Drawing.Color]::FromArgb(240, 244, 252)
$cancel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', [single](9.5 * $uiScale), [System.Drawing.FontStyle]::Regular)
$cancel.Text = if ($cfg.stopLabel) { [string]$cfg.stopLabel } else { "Stop" }
$cancel.Cursor = [System.Windows.Forms.Cursors]::Hand
$cancel.UseVisualStyleBackColor = $false
$brake.Controls.Add($cancel)
[void]$forms.Add($deco)
[void]$forms.Add($brake)

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
$script:frameForm = $frame
$script:frameThickness = $thickness
$script:colMid = $colMid
$script:frmHB = $frmHB
$script:frmW = $frmW
$script:frmH = $frmH
$script:frameX = $vs.X
$script:frameY = $vs.Y
$script:haloForm = $halo
$script:haloColor = $colA
$script:haloX = 0
$script:haloY = 0
$script:tick = 0
$script:haloBmp = New-HaloBitmap $colA
$script:haloHB = $script:haloBmp.GetHbitmap([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$script:decoForm = $deco
$script:brakeForm = $brake
$script:allForms = @($frame, $halo, $deco, $brake)
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
    if ($script:frameForm -and $script:frameForm.IsHandleCreated) {
      [CUOverlayNative]::PushHBitmap($script:frameForm.Handle, $script:frmHB, $script:frmW, $script:frmH, $script:frameX, $script:frameY, $alpha) | Out-Null
    }
    if ($script:haloForm -and $script:haloForm.IsHandleCreated) {
      [CUOverlayNative]::PushHBitmap($script:haloForm.Handle, $script:haloHB, $script:haloSize, $script:haloSize, $script:haloX, $script:haloY, [byte](170 + 85 * $pulse)) | Out-Null
    }
  }

  # cursor halo -----------------------------------------------------------
  $p = [System.Windows.Forms.Cursor]::Position
  $script:haloX = [int]($p.X - $script:haloSize / 2)
  $script:haloY = [int]($p.Y - $script:haloSize / 2)

  $shape = [CUOverlayNative]::CursorShape()
  $mix = 0.5 + 0.5 * [Math]::Sin($script:phase)
  $newColor = [System.Drawing.Color]::FromArgb(
    255,
    [int]($script:colA.R + ($script:colB.R - $script:colA.R) * $mix),
    [int]($script:colA.G + ($script:colB.G - $script:colA.G) * $mix),
    [int]($script:colA.B + ($script:colB.B - $script:colA.B) * $mix))
  # Rebuild the ring when its SHAPE changes, and every few ticks so the colour
  # still drifts with the pulse. Each rebuild replaces the HBITMAP, so the stale
  # one is deleted rather than leaked.
  $script:tick = ($script:tick + 1) % 5
  if ($shape -ne $script:cursorShape -or $script:tick -eq 0) {
    $script:cursorShape = $shape
    $script:haloColor = $newColor
    $stale = $script:haloHB
    $script:haloBmp = New-HaloBitmap $newColor
    $script:haloHB = $script:haloBmp.GetHbitmap([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    if ($stale -ne [IntPtr]::Zero) { [CUOverlayNative]::DeleteObject($stale) | Out-Null }
  }

  # Keep the indicator on top, but ONLY repair the z-order when it has actually
  # been lost - never as a heartbeat.
  #
  # Re-asserting Form.TopMost every tick was measured to silently disable the Stop
  # button. $deco overlaps the brake (the deco strip is 620x46; the button sits
  # inside it), so bumping $deco to the top of the topmost band slid a window
  # between the cursor and the button while the button was pressed. A message
  # trace shows WM_LBUTTONDOWN and WM_LBUTTONUP both still arriving at the button,
  # and the control's own state machine running ENTER -> DOWN -> UP, yet WinForms
  # never raised Click: the press had been cancelled. The old single-window banner
  # was immune only because the window it re-asserted was the button's own parent.
  # Twenty SetWindowPos calls a second bought nothing and broke the brake.
  if (-not $script:hidden) {
    foreach ($bf in @($script:decoForm, $script:brakeForm)) {
      if ($bf -and $bf.IsHandleCreated -and -not [CUOverlayNative]::IsTopMost($bf.Handle)) {
        [CUOverlayNative]::ReassertTopMost($bf.Handle)
      }
    }
  }
})

$brake.add_Shown({
  # First commit with real per-pixel alpha. There is no colour key any more, so
  # neither window needs SetLayeredWindowAttributes for correctness - but a layered
  # window that has never been given an alpha is not guaranteed to paint, and $deco
  # is the one layered window here with no pushed bitmap behind it, so it gets an
  # explicit full-alpha call. Its children (accent bar, both labels) then ride along
  # as they always did.
  if ($script:frameForm.IsHandleCreated) {
    [CUOverlayNative]::PushHBitmap($script:frameForm.Handle, $script:frmHB, $script:frmW, $script:frmH, $script:frameX, $script:frameY, 140) | Out-Null
  }
  if ($script:haloForm.IsHandleCreated) {
    [CUOverlayNative]::PushHBitmap($script:haloForm.Handle, $script:haloHB, $script:haloSize, $script:haloSize, $script:haloX, $script:haloY, 220) | Out-Null
  }
  # The hotkey is owned by the thread, but RegisterHotKey needs a window of that
  # thread; the brake is the one window here that is guaranteed to live as long as
  # the message loop, so it posts the WM_HOTKEY the filter is waiting for.
  [CUOverlayNative]::RegisterHotKey($script:brakeForm.Handle, 1, $hotkeyMods, $hotkeyVk) | Out-Null
  $timer.Start()
})

# WinForms' Show() ACTIVATES the window, and a window style can only be set once a
# handle exists - so the old code showed first and styled in a Shown handler, which
# meant the window had already taken the foreground by the time it was told not to.
# The frame is a full-screen TOPMOST window, so the indicator used to seize the
# foreground the instant it appeared: focus was stolen from whatever the user was
# typing in, and computer_activate_window reported failure because its success check
# compares the foreground window against the requested one and kept finding the
# overlay instead.
#
# Force every handle into existence FIRST, apply the styles, and only then show
# anything, so nothing is ever activated in the first place. The foreground is still
# recorded and handed back as a belt-and-braces measure.
#
# Click-through: the frame, the halo and $deco. NOT click-through: $brake, which is
# the single window in the indicator that is allowed to consume a mouse click.
$previousForeground = [CUOverlayNative]::GetForegroundWindow()
foreach ($f in @($frame, $halo, $deco, $brake)) { $null = $f.Handle }
[CUOverlayNative]::NoActivate($frame.Handle, $true, $true)
[CUOverlayNative]::NoActivate($halo.Handle, $true, $true)
[CUOverlayNative]::NoActivate($deco.Handle, $true, $true)
[CUOverlayNative]::NoActivate($brake.Handle, $false, $false)
# $deco is layered with no pushed bitmap, so it needs an explicit full alpha or it
# may never be painted. Without this the banner text would vanish into a hole.
[CUOverlayNative]::SetAlpha($deco.Handle, 255)

foreach ($f in @($frame, $halo, $deco, $brake)) { $f.Show() }
# Undo the OS minimum-window clamp. A Form with FormBorderStyle=None is still an
# overlapped window, so Windows clamps it to SM_CXMIN x SM_CYMIN (136x39 here) -
# which turned the 96x30 brake into a 136x39 strip that hung 28px past the banner.
# The clamp is applied when bounds are set, so a direct SetWindowPos after the
# window exists is what actually makes the brake the size of its button.
[CUOverlayNative]::PlaceExactly($brake.Handle, $brakeX, $brakeY, $brakeW, $brakeH) | Out-Null
if ($previousForeground -ne [IntPtr]::Zero) {
  [CUOverlayNative]::SetForegroundWindow($previousForeground) | Out-Null
}
$timer.Start()

try {
  [System.Windows.Forms.Application]::Run($brake)
} finally {
  $timer.Stop()
  try { [CUOverlayNative]::UnregisterHotKey($brake.Handle, 1) | Out-Null } catch { }
  foreach ($f in $forms) { try { $f.Close(); $f.Dispose() } catch { } }
  [System.Windows.Forms.Application]::RemoveMessageFilter($hotkeyFilter)
  if (-not $script:stopped) { Stop-Overlay 'closed' }
}
