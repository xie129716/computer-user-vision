# computer-user / context.ps1 - window enumeration, UI-element hit testing and
# deliberate window activation.
#
# Why this exists (each action maps to a real failure observed in the field):
#   windows    - reading window rectangles off a downscaled screenshot is error
#                prone; ask the OS for exact pixels instead of guessing.
#   element_at - a synthetic click can land on the wrong control, or be consumed
#                by window activation, with no feedback. Report what is actually
#                under the cursor so the caller can verify.
#   foreground - the first synthetic click on a background window only activates
#                it; callers must be able to detect that.
#   activate   - focus a window deliberately instead of spending a click on it.
#
# Input:  -Json <base64(UTF8 JSON)>  { action, x, y, hwnd, pid, title }
# Output: stdout single JSON object carrying ok:true, or { ok:false, error }
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $msg }); exit 2 }

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct CU_RECT { public int Left, Top, Right, Bottom; }
public class CUContext {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out CU_RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  delegate bool EnumProc(IntPtr h, IntPtr p);

  public static List<IntPtr> Handles() {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static bool RectOf(IntPtr h, out CU_RECT r) { return GetWindowRect(h, out r); }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static uint ForegroundThread() { uint pid; return GetWindowThreadProcessId(GetForegroundWindow(), out pid); }

  /** Focus a window the way the plugin's smoke test does: attach to the current
      foreground thread first, otherwise Windows refuses the foreground change. */
  public static bool Activate(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9); /* SW_RESTORE */
    uint fgTid = ForegroundThread();
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    try {
      if (fgTid != 0 && fgTid != myTid) attached = AttachThreadInput(myTid, fgTid, true);
      BringWindowToTop(h);
      ShowWindow(h, 5); /* SW_SHOW */
      bool ok = SetForegroundWindow(h);
      return ok;
    } finally {
      if (attached) AttachThreadInput(myTid, fgTid, false);
    }
  }
}
'@
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { Fail("Add-Type failed: $($_.Exception.Message)") }
[CUContext]::SetProcessDPIAware() | Out-Null

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
  $cfg = $raw | ConvertFrom-Json
} catch { Fail("bad -Json: $($_.Exception.Message)") }

$action = [string]$cfg.action
if ([string]::IsNullOrWhiteSpace($action)) { Fail("action is required") }

function WindowRecord($h) {
  $r = New-Object CU_RECT
  [CUContext]::RectOf($h, [ref]$r) | Out-Null
  return @{
    hwnd        = $h.ToInt64()
    pid         = [int][CUContext]::PidOf($h)
    title       = [CUContext]::Title($h)
    rect        = @($r.Left, $r.Top, $r.Right, $r.Bottom)
    width       = $r.Right - $r.Left
    height      = $r.Bottom - $r.Top
    minimized   = [bool][CUContext]::IsIconic($h)
    foreground  = ($h -eq [CUContext]::Foreground())
    tool_window = (([CUContext]::GetWindowLong($h, -20) -band 0x80) -ne 0)
  }
}

function Emit($obj) {
  Write-Output ([System.Text.Encoding]::UTF8.GetString([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -Depth 6 $obj))))
  exit 0
}

function ElementAt($x, $y) {
  try {
    # WindowsBase carries System.Windows.Point, which FromPoint requires.
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase -ErrorAction Stop
  } catch { return @{ available = $false; reason = "UIAutomation assembly unavailable" } }
  try {
    $pt = New-Object System.Windows.Point([int]$x, [int]$y)
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
    if ($null -eq $el) { return @{ available = $true; element = $null } }
    $r = $el.Current.BoundingRectangle
    return @{
      available = $true
      element   = @{
        name          = $el.Current.Name
        localizedType = $el.Current.LocalizedControlType
        controlType   = $el.Current.ControlType.ProgrammaticName
        className     = $el.Current.ClassName
        automationId  = $el.Current.AutomationId
        pid           = [int]$el.Current.ProcessId
        enabled       = [bool]$el.Current.IsEnabled
        focused       = [bool]$el.Current.HasKeyboardFocus
        rect          = @([int]$r.X, [int]$r.Y, [int]([int]$r.X + $r.Width), [int]($r.Y + $r.Height))
      }
    }
  } catch {
    return @{ available = $true; element = $null; error = $_.Exception.Message }
  }
}

switch ($action) {
  'foreground' {
    $h = [CUContext]::Foreground()
    if ($h -eq [IntPtr]::Zero) { Emit @{ ok = $true; window = $null } }
    Emit @{ ok = $true; window = (WindowRecord $h) }
  }

  # One round trip that answers "what is focused now, and what is under this
  # point?" - the two facts a click needs to prove it did what was intended.
  'probe' {
    $res = @{ ok = $true }
    $h = [CUContext]::Foreground()
    $res.foreground = if ($h -eq [IntPtr]::Zero) { $null } else { WindowRecord $h }
    if ($null -ne $cfg.x -and $null -ne $cfg.y) {
      $ea = ElementAt $cfg.x $cfg.y
      $res.available = $ea.available
      $res.element = $ea.element
      if ($ea.reason) { $res.reason = $ea.reason }
      if ($ea.error) { $res.error = $ea.error }
    }
    Emit $res
  }

  'windows' {
    $minW = if ($null -ne $cfg.minWidth) { [int]$cfg.minWidth } else { 1 }
    $minH = if ($null -ne $cfg.minHeight) { [int]$cfg.minHeight } else { 1 }
    $fg = [CUContext]::Foreground()
    $out = New-Object System.Collections.ArrayList
    foreach ($h in [CUContext]::Handles()) {
      if (-not [CUContext]::IsWindowVisible($h)) { continue }
      $rec = WindowRecord $h
      if ($rec.width -lt $minW -or $rec.height -lt $minH) { continue }
      if ($rec.tool_window -and $h -ne $fg) { continue }
      if ([string]::IsNullOrWhiteSpace($rec.title) -and $h -ne $fg) { continue }
      [void]$out.Add($rec)
    }
    # EnumWindows walks in z-order, top first; keep it so the caller can tell
    # what occludes what.
    Emit @{ ok = $true; count = $out.Count; zOrderTopFirst = $true; windows = @($out) }
  }

  'element_at' {
    $ea = ElementAt ([int]$cfg.x) ([int]$cfg.y)
    $out = @{ ok = $true; available = $ea.available; element = $ea.element }
    if ($ea.reason) { $out.reason = $ea.reason }
    if ($ea.error) { $out.error = $ea.error }
    Emit $out
  }

  'activate' {
    $target = [IntPtr]::Zero
    if ($null -ne $cfg.hwnd -and [int64]$cfg.hwnd -ne 0) {
      $target = [IntPtr][int64]$cfg.hwnd
    } elseif ($null -ne $cfg.pid -and [int]$cfg.pid -ne 0) {
      # Do NOT require IsWindowVisible here. A hidden or minimized window still
      # has to be reachable, and filtering on visibility made exactly those
      # impossible to activate. A non-empty title is the right filter instead: it
      # skips the invisible IME/helper windows without excluding real ones.
      $best = $null; $bestArea = -1
      foreach ($h in [CUContext]::Handles()) {
        if ([int][CUContext]::PidOf($h) -ne [int]$cfg.pid) { continue }
        if ([string]::IsNullOrWhiteSpace([CUContext]::Title($h))) { continue }
        $r = New-Object CU_RECT; [CUContext]::RectOf($h, [ref]$r) | Out-Null
        $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
        if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
      }
      $target = $best
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$cfg.title)) {
      $needle = [string]$cfg.title
      foreach ($h in [CUContext]::Handles()) {
        if (-not [CUContext]::IsWindowVisible($h)) { continue }
        $t = [CUContext]::Title($h)
        if ($t -and $t.ToLower().Contains($needle.ToLower())) { $target = $h; break }
      }
    }
    # `$null -eq [IntPtr]::Zero` is FALSE in PowerShell, so a null target slipped
    # through and reached Activate(), which reported a misleading IntPtr
    # conversion error instead of saying that nothing matched.
    if ($null -eq $target -or $target -eq [IntPtr]::Zero) { Emit @{ ok = $false; error = "no matching window (not found by hwnd/pid/title)" } }
    [CUContext]::Activate($target) | Out-Null
    Start-Sleep -Milliseconds 180
    Emit @{
      ok         = $true
      requested  = $target.ToInt64()
      foreground = (WindowRecord ([CUContext]::Foreground()))
    }
  }

  default { Fail("unknown action: $action") }
}
