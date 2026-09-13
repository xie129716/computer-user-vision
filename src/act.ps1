# computer-user / act.ps1 - the single compound action executor.
#
# Why this file exists (each point was measured on a real desktop, not assumed):
#
#  * Every one-shot PowerShell start costs ~380 ms, almost all of it process
#    creation plus re-compiling the Add-Type C# below. The old design ran THREE
#    or FOUR of those per click (expect-window check, before-foreground, the
#    click itself, then a probe), which is 1.1-1.5 s of pure overhead for one
#    mouse click. One process now does the whole click: resolve target, verify
#    focus, act, probe. One spawn per tool call.
#
#  * Clicking used to mean "estimate the target's pixel position on a downscaled
#    screenshot and multiply by ~1.84". The OS already knows the exact rectangle
#    of every control, so the caller can name an element instead of guessing a
#    coordinate. `elements` lists them, `screenshot` draws them, `click` accepts
#    a ref or a name.
#
#  * GetWindowRect includes the invisible DWM resize border (8 px per side on
#    Windows 10/11), so a window "rect" was 16 px wider and taller than anything
#    on screen. Any window-relative targeting inherited that error. `windows`
#    now reports the DWM extended frame bounds as `rect` - the pixels that are
#    actually visible - and keeps the raw value as `window_rect`.
#
# Input:  -Json <base64(UTF8 JSON)> with an `action` field.
# Output: one line of UTF8 JSON on stdout, always carrying `ok`.
#
# ASCII only: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so a
# non-ASCII literal here would arrive as mojibake and can break parsing outright.
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = "$msg" }); exit 2 }
function Emit($obj) {
  Write-Output ([System.Text.Encoding]::UTF8.GetString([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -Depth 8 $obj))))
  exit 0
}

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public struct A_RECT { public int Left, Top, Right, Bottom; }

public class CUAct {
  // ---------------- mouse / keyboard input ----------------
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);

  public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
                    MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
                    MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040,
                    MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000,
                    MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
  public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  public static INPUT M(uint data, uint flags) {
    INPUT i = new INPUT(); i.type = 0; i.U.mi.dx = 0; i.U.mi.dy = 0;
    i.U.mi.mouseData = data; i.U.mi.dwFlags = flags; i.U.mi.time = 0; i.U.mi.dwExtraInfo = IntPtr.Zero; return i;
  }
  public static INPUT K(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan;
    i.U.ki.dwFlags = flags; i.U.ki.time = 0; i.U.ki.dwExtraInfo = IntPtr.Zero; return i;
  }
  public static void Send(INPUT[] a) { SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))); }
  public static void Wheel(uint signedDelta) { INPUT[] a = new INPUT[1]; a[0] = M(signedDelta, MOUSEEVENTF_WHEEL); Send(a); }
  public static void HWheel(uint signedDelta) { INPUT[] a = new INPUT[1]; a[0] = M(signedDelta, MOUSEEVENTF_HWHEEL); Send(a); }
  public static void Button(uint down, uint up) {
    INPUT[] a = new INPUT[2]; a[0] = M(0, down); a[1] = M(0, up); Send(a);
  }
  // Separate press/release primitives: a drag has to hold the button down while
  // the pointer moves, so it cannot use the paired helper above.
  public static void Down(uint f) { INPUT[] a = new INPUT[1]; a[0] = M(0, f); Send(a); }
  public static void Up(uint f) { INPUT[] a = new INPUT[1]; a[0] = M(0, f); Send(a); }
  public static void KeyDown(ushort vk) { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, 0); Send(a); }
  public static void KeyUp(ushort vk) { INPUT[] a = new INPUT[1]; a[0] = K(vk, 0, KEYEVENTF_KEYUP); Send(a); }
  public static void CharDown(char c) { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, KEYEVENTF_UNICODE); Send(a); }
  public static void CharUp(char c) { INPUT[] a = new INPUT[1]; a[0] = K(0, (ushort)c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP); Send(a); }

  /**
   * Move the pointer with an ABSOLUTE SendInput event addressed to the whole
   * virtual desktop.
   *
   * SetCursorPos alone is what the previous version used. It is a single call
   * with no event attached, so it races with whatever the target application is
   * doing, and on a mixed-DPI multi-monitor desktop it is interpreted in the
   * coordinate space of the process that calls it. MOUSEEVENTF_VIRTUALDESK plus
   * the virtual-screen metrics removes both problems.
   */
  public static bool MoveAbs(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    if (vw <= 1 || vh <= 1) return false;
    double nx = (double)(x - vx) * 65535.0 / (double)(vw - 1);
    double ny = (double)(y - vy) * 65535.0 / (double)(vh - 1);
    if (nx < 0) nx = 0; if (ny < 0) ny = 0;
    if (nx > 65535) nx = 65535; if (ny > 65535) ny = 65535;
    INPUT[] a = new INPUT[1];
    a[0] = M(0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
    a[0].U.mi.dx = (int)Math.Round(nx);
    a[0].U.mi.dy = (int)Math.Round(ny);
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
    return true;
  }

  /**
   * Move to a point and PROVE the pointer arrived. A move that silently failed
   * used to be indistinguishable from a successful one, and the click that
   * followed landed wherever the pointer already was.
   */
  public static int[] MoveVerified(int x, int y) {
    MoveAbs(x, y);
    int[] got = Cursor();
    if (got[0] == x && got[1] == y) return got;
    SetCursorPos(x, y);
    return Cursor();
  }

  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

  // ---------------- window enumeration ----------------
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out A_RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out A_RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out A_RECT r, int size);

  public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  public static List<IntPtr> Handles() {
    var l = new List<IntPtr>();
    EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero);
    return l;
  }
  public static string Title(IntPtr h) {
    int len = GetWindowTextLength(h);
    var sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
  public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static uint ForegroundThread() { uint pid; return GetWindowThreadProcessId(GetForegroundWindow(), out pid); }

  /** The rectangle that is actually on screen: DWMWA_EXTENDED_FRAME_BOUNDS.
      GetWindowRect includes the invisible resize border (8 px per side). */
  public static A_RECT VisibleRect(IntPtr h) {
    A_RECT r;
    int hr = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(A_RECT)));
    if (hr != 0) { GetWindowRect(h, out r); return r; }
    if ((r.Right - r.Left) <= 0 || (r.Bottom - r.Top) <= 0) { GetWindowRect(h, out r); }
    return r;
  }
  public static A_RECT RawRect(IntPtr h) { A_RECT r; GetWindowRect(h, out r); return r; }
  public static A_RECT ClientBox(IntPtr h) {
    A_RECT r; GetClientRect(h, out r);
    POINT p = new POINT(); p.X = 0; p.Y = 0;
    ClientToScreen(h, ref p);
    A_RECT o; o.Left = p.X; o.Top = p.Y; o.Right = p.X + (r.Right - r.Left); o.Bottom = p.Y + (r.Bottom - r.Top);
    return o;
  }

  static void RevealUwpContent(IntPtr parent) {
    EnumChildWindows(parent, (child, p) => {
      if (Cls(child) == "Windows.UI.Core.CoreWindow" && !IsWindowVisible(child)) ShowWindow(child, 5);
      return true;
    }, IntPtr.Zero);
  }

  public static bool Activate(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    RevealUwpContent(h);
    uint fgTid = ForegroundThread();
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    try {
      if (fgTid != 0 && fgTid != myTid) attached = AttachThreadInput(myTid, fgTid, true);
      BringWindowToTop(h);
      ShowWindow(h, 5);
      SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      return SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(myTid, fgTid, false);
    }
  }

  // ---------------- DPI ----------------
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr h, int t, out uint x, out uint y);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint f);

  /**
   * Prefer PER_MONITOR_AWARE_V2. This matters more than it looks: powershell.exe
   * starts DPI-UNAWARE (measured: GetAwarenessFromDpiAwarenessContext == 0), and
   * an unaware process has every coordinate virtualised by Windows on a scaled
   * display. That is a systematic misalignment which grows with the display
   * scale, and it is invisible on a 100% single-monitor desktop.
   *
   * Idempotent on purpose: awareness can only be raised once per process, so a
   * second call reports the CURRENT level instead of falling through to the
   * weaker fallback and claiming the process is only System aware.
   */
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  public static int CurrentAwareness() {
    try { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()); } catch { return -1; }
  }
  public static int MakeDpiAware() {
    int cur = CurrentAwareness();
    if (cur >= 2) return cur;
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return CurrentAwareness(); } catch { }
    try { if (SetProcessDpiAwareness(2) == 0) return CurrentAwareness(); } catch { }
    try { if (SetProcessDPIAware()) return CurrentAwareness(); } catch { }
    return CurrentAwareness();
  }
  public static uint MonitorDpi(int x, int y) {
    POINT p = new POINT(); p.X = x; p.Y = y;
    IntPtr m = MonitorFromPoint(p, 2);
    uint dx = 0, dy = 0;
    try { if (GetDpiForMonitor(m, 0, out dx, out dy) != 0) return 0; } catch { return 0; }
    return dx;
  }
}
'@
try { Add-Type -TypeDefinition $src -ErrorAction Stop } catch { Fail("Add-Type failed: $($_.Exception.Message)") }
try { [void][CUAct]::MakeDpiAware() } catch { }

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
$cfg = $null
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
  $cfg = $raw | ConvertFrom-Json
} catch { Fail("bad -Json: $($_.Exception.Message)") }

$action = [string]$cfg.action
if ([string]::IsNullOrWhiteSpace($action)) { Fail("action is required") }

function To-U32([int]$v) { if ($v -lt 0) { return [uint32]($v + 4294967296) }; return [uint32]$v }

# ---------------------------------------------------------------------------
# window records
# ---------------------------------------------------------------------------
function WindowRecord($h) {
  $vis = [CUAct]::VisibleRect($h)
  $rawR = [CUAct]::RawRect($h)
  $cli = [CUAct]::ClientBox($h)
  return @{
    hwnd        = $h.ToInt64()
    pid         = [int][CUAct]::PidOf($h)
    title       = [CUAct]::Title($h)
    class       = [CUAct]::Cls($h)
    rect        = @($vis.Left, $vis.Top, $vis.Right, $vis.Bottom)
    window_rect = @($rawR.Left, $rawR.Top, $rawR.Right, $rawR.Bottom)
    client_rect = @($cli.Left, $cli.Top, $cli.Right, $cli.Bottom)
    width       = $vis.Right - $vis.Left
    height      = $vis.Bottom - $vis.Top
    minimized   = [bool][CUAct]::IsIconic($h)
    foreground  = ($h -eq [CUAct]::Foreground())
    tool_window = (([CUAct]::GetWindowLong($h, -20) -band 0x80) -ne 0)
  }
}

function Resolve-Window {
  param($hwnd, $pid_, $title)
  if ($null -ne $hwnd -and [int64]$hwnd -ne 0) { return [IntPtr][int64]$hwnd }
  if ($null -ne $pid_ -and [int]$pid_ -ne 0) {
    $best = $null; $bestArea = -1
    foreach ($h in [CUAct]::Handles()) {
      if ([int][CUAct]::PidOf($h) -ne [int]$pid_) { continue }
      if ([string]::IsNullOrWhiteSpace([CUAct]::Title($h))) { continue }
      $r = [CUAct]::VisibleRect($h)
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
    }
    return $best
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$title)) {
    $needle = ([string]$title).ToLower()
    foreach ($h in [CUAct]::Handles()) {
      if (-not [CUAct]::IsWindowVisible($h)) { continue }
      $t = [CUAct]::Title($h)
      if ($t -and $t.ToLower().Contains($needle)) { return $h }
    }
  }
  return $null
}

# ---------------------------------------------------------------------------
# UIA element enumeration
# ---------------------------------------------------------------------------
# Only types a caller can meaningfully act on become refs; adding Text would put
# a box around every label and bury the real controls in noise.
# A control type is NOT a reliable signal that something is actionable.
# Measured on a real WinForms window: a button (class WindowsForms10.BUTTON) is
# exposed by the MSAA bridge as ControlType.Pane and reports NO supported
# patterns at all. Filtering by ControlType therefore threw away exactly the
# controls that most Windows applications are built from. What works instead is a
# capability test - an accessible name, an action pattern, a value, or a class
# name that names a real control - applied to every descendant, with all the
# properties fetched in ONE cached pass.
$script:CLASS_HINT = '(?i)BUTTON|EDIT|COMBOBOX|LISTBOX|LISTVIEW|TREEVIEW|TOOLBAR|MSCTLS_|SYSTAB|RICHEDIT|SCINTILLA|SYSLINK|SPLITBUTTON|WEBBROWSER|CHROME_|MOZILLA|STATIC.*(LINK|BUTTON)'
$script:CACHE_PROPS = @(
  'NameProperty', 'ClassNameProperty', 'AutomationIdProperty', 'ControlTypeProperty',
  'BoundingRectangleProperty', 'IsOffscreenProperty', 'IsEnabledProperty',
  'HasKeyboardFocusProperty', 'ProcessIdProperty',
  'IsInvokePatternAvailableProperty', 'IsTogglePatternAvailableProperty',
  'IsSelectionItemPatternAvailableProperty', 'IsExpandCollapsePatternAvailableProperty',
  'IsValuePatternAvailableProperty', 'IsScrollItemPatternAvailableProperty'
)

# The AutomationElement property accessors are static readonly FIELDS, so
# GetProperty returns null for every one of them; fall back to the field lookup.
function Get-AEProp([string]$name) {
  $t = [System.Windows.Automation.AutomationElement]
  $m = $t.GetField($name)
  if ($null -eq $m) { $m = $t.GetProperty($name) }
  if ($null -eq $m) { return $null }
  return $m.GetValue($null)
}

function Get-RefList {
  param([IntPtr]$Root, [int]$MaxOut = 80, [int]$MaxScan = 2500, [switch]$IncludeStatic)
  try { Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase -ErrorAction Stop }
  catch { return @{ ok = $false; reason = 'UIAutomation assembly unavailable' } }
  $rootEl = $null
  try { $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($Root) } catch { }
  if ($null -eq $rootEl) { return @{ ok = $false; reason = 'window has no UI Automation element' } }
  $rootR = $rootEl.Current.BoundingRectangle
  $rootW = [int]$rootR.Width; $rootH = [int]$rootR.Height

  $cache = New-Object System.Windows.Automation.CacheRequest
  $added = 0
  foreach ($pn in $script:CACHE_PROPS) {
    $prop = Get-AEProp $pn
    if ($null -ne $prop) { $cache.Add($prop); $added++ }
  }
  if ($added -eq 0) { return @{ ok = $false; reason = 'no AutomationElement properties resolved' } }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $found = $null
  # CacheRequest has no Deactivate(): Activate() returns an IDisposable, and
  # disposing THAT is what leaves the cache scope.
  $scope = $cache.Activate()
  try { $found = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) }
  catch { return @{ ok = $false; reason = "FindAll failed: $($_.Exception.Message)" } }
  finally { if ($null -ne $scope) { $scope.Dispose() } }
  $fetchMs = $sw.ElapsedMilliseconds

  $rows = New-Object System.Collections.Generic.List[object]
  $scanned = 0
  foreach ($el in $found) {
    $scanned++
    if ($scanned -gt $MaxScan) { break }
    try {
      $ci = $el.Cached
      if ($ci.IsOffscreen) { continue }
      $r = $ci.BoundingRectangle
      if ($r.IsEmpty) { continue }
      $w = [int]$r.Width; $h = [int]$r.Height
      if ($w -lt 3 -or $h -lt 3) { continue }

      $pat = @()
      if ($ci.IsInvokePatternAvailable) { $pat += 'Invoke' }
      if ($ci.IsTogglePatternAvailable) { $pat += 'Toggle' }
      if ($ci.IsSelectionItemPatternAvailable) { $pat += 'SelectionItem' }
      if ($ci.IsExpandCollapsePatternAvailable) { $pat += 'ExpandCollapse' }
      if ($ci.IsValuePatternAvailable) { $pat += 'Value' }
      if ($ci.IsScrollItemPatternAvailable) { $pat += 'ScrollItem' }

      $nm = [string]$ci.Name
      $cls = [string]$ci.ClassName
      $ctName = ''
      $ct = $ci.ControlType
      if ($null -ne $ct) { $ctName = [string]$ct.ProgrammaticName; $ctName = $ctName -replace '^ControlType\.', '' }

      $actionable = ($pat.Count -gt 0)
      $hasName = -not [string]::IsNullOrWhiteSpace($nm)
      $hinted = ($cls -match $script:CLASS_HINT)
      if (-not $IncludeStatic) {
        if (-not ($hasName -or $actionable -or $hinted)) { continue }
      } else {
        if (-not ($hasName -or $actionable -or $hinted -or ($ctName -in @('Text', 'Image', 'Document')))) { continue }
      }
      # A nameless element covering the whole window is that window's content
      # container, not a target.
      if (-not $actionable -and $w -ge ($rootW - 2) -and $h -ge ($rootH - 2)) { continue }

      $rows.Add([pscustomobject]@{
        name         = $nm
        type         = $ctName
        automationId = [string]$ci.AutomationId
        className    = $cls
        pid          = [int]$ci.ProcessId
        rect         = @([int]$r.X, [int]$r.Y, [int]([int]$r.X + $w), [int]($r.Y + $h))
        # Integer midpoint. NOT [int]($x + $w/2): a PowerShell cast rounds half to
        # even, so for an odd width the reported centre could sit one pixel off the
        # midpoint of the rectangle the caller was shown.
        cx           = [int]$r.X + [int][Math]::Floor($w / 2.0)
        cy           = [int]$r.Y + [int][Math]::Floor($h / 2.0)
        enabled      = [bool]$ci.IsEnabled
        focused      = [bool]$ci.HasKeyboardFocus
        patterns     = $pat
        _el          = $el
      })
      if ($rows.Count -ge $MaxOut) { break }
    } catch { continue }
  }
  $sw.Stop()

  # Deterministic reading order (top-to-bottom, then left-to-right) so a ref is
  # reproducible, and so a human reading the annotated image sees a sane list.
  $sorted = @($rows | Sort-Object @{ Expression = { [int]($_.rect[1] / 10) } }, @{ Expression = { [int]$_.rect[0] } })
  return @{ ok = $true; rows = $sorted; scanned = $scanned; total = $found.Count; ms = $sw.ElapsedMilliseconds; fetch_ms = $fetchMs }
}

function Element-Brief($row, [int]$index) {
  $o = [ordered]@{ ref = "e$index" }
  if ($row.name) { $o.name = $row.name }
  $o.type = $row.type
  if ($row.automationId) { $o.automationId = $row.automationId }
  $o.rect = $row.rect
  $o.cx = $row.cx
  $o.cy = $row.cy
  if ($row.enabled -eq $false) { $o.enabled = $false }
  if ($row.focused) { $o.focused = $true }
  if ($row.patterns -and $row.patterns.Count -gt 0) { $o.patterns = $row.patterns }
  return $o
}

function Element-MatchKey($row) {
  # Identity for re-resolution across processes: prefer the stable automation id,
  # then the accessible name, and always keep the control type.
  $id = [string]$row.automationId
  $nm = [string]$row.name
  return @{ type = [string]$row.type; id = $id; name = $nm }
}

# ---------------------------------------------------------------------------
# the compound click
# ---------------------------------------------------------------------------
function Invoke-Element {
  param($el, [string]$method)
  # Prefer the UIA action patterns: they address the control directly, so they
  # work on an occluded window, need no coordinates at all, and cannot be
  # deflected by DPI scaling or a window that moved since the screenshot.
  $want = @()
  if ($method -eq 'auto') { $want = @('invoke', 'toggle', 'select', 'expand') }
  if ($method -eq 'select') { $want = @('select', 'invoke') }
  if ($method -eq 'toggle') { $want = @('toggle', 'invoke') }
  if ($method -eq 'expand') { $want = @('expand', 'invoke') }
  # Concrete pattern objects: AutomationPattern exposes its singletons as static
  # readonly FIELDS, so a name-based lookup has to go through the field too.
  $paths = @{
    invoke = [System.Windows.Automation.InvokePattern]::Pattern
    toggle = [System.Windows.Automation.TogglePattern]::Pattern
    select = [System.Windows.Automation.SelectionItemPattern]::Pattern
    expand = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  }
  foreach ($key in $want) {
    try {
      $pat = $el.GetCurrentPattern($paths[$key])
      if ($null -eq $pat) { continue }
      switch ($key) {
        'invoke' { $pat.Invoke(); return 'invoke' }
        'toggle' { $pat.Toggle(); return 'toggle' }
        'select' { $pat.Select(); return 'select' }
        'expand' {
          if ($pat.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $pat.Collapse() } else { $pat.Expand() }
          return 'expand'
        }
      }
    } catch { continue }
  }
  return $null
}

# ---------------------------------------------------------------------------
# target resolution: turn "the element I saw" into "the element that is there now"
# ---------------------------------------------------------------------------
function Resolve-Target {
  param($t)
  # $t carries what the caller saw: hwnd, type, automationId, name, rect.
  # The point of re-resolving instead of trusting the stored rectangle is that a
  # window can move, scroll or re-layout between the screenshot and the click.
  $attempts = New-Object System.Collections.Generic.List[object]
  $h1 = $null
  if ($null -ne $t.hwnd -and [int64]$t.hwnd -ne 0) { $h1 = [IntPtr][int64]$t.hwnd }
  if ($null -ne $h1 -and $h1 -ne [IntPtr]::Zero) { $attempts.Add($h1) }
  $fg = [CUAct]::Foreground()
  if ($fg -ne [IntPtr]::Zero -and ($null -eq $h1 -or $fg -ne $h1)) { $attempts.Add($fg) }

  $wantId = [string]$t.automationId
  $wantName = [string]$t.name
  $wantType = [string]$t.type
  $stored = $null
  if ($null -ne $t.rect -and @($t.rect).Count -ge 4) { $stored = @([int]$t.rect[0], [int]$t.rect[1], [int]$t.rect[2], [int]$t.rect[3]) }
  $scx = 0; $scy = 0
  if ($null -ne $stored) { $scx = [int](($stored[0] + $stored[2]) / 2); $scy = [int](($stored[1] + $stored[3]) / 2) }

  foreach ($h in $attempts) {
    $list = Get-RefList -Root $h -MaxOut 250
    if ($list.ok -ne $true) { continue }
    $rows = @($list.rows)
    if ($rows.Count -eq 0) { continue }
    $cand = @()
    if ($wantId) { $cand = @($rows | Where-Object { $_.automationId -eq $wantId }) }
    if ($cand.Count -eq 0 -and $wantName -and $wantType) { $cand = @($rows | Where-Object { $_.name -eq $wantName -and $_.type -eq $wantType }) }
    if ($cand.Count -eq 0 -and $wantName) { $cand = @($rows | Where-Object { $_.name -eq $wantName }) }
    if ($cand.Count -eq 0) { continue }
    $pick = $cand[0]
    if ($cand.Count -gt 1) {
      $bestD = [double]::MaxValue
      foreach ($c in $cand) {
        $d = [Math]::Sqrt([Math]::Pow($c.cx - $scx, 2) + [Math]::Pow($c.cy - $scy, 2))
        if ($d -lt $bestD) { $bestD = $d; $pick = $c }
      }
    }
    return @{ ok = $true; row = $pick; hwnd = $h; candidates = $cand.Count }
  }
  return @{ ok = $false; row = $null; candidates = 0 }
}

function Find-ByName {
  param([string]$needle, [IntPtr]$h)
  $list = Get-RefList -Root $h -MaxOut 250
  if ($list.ok -ne $true) { return @{ ok = $false; reason = [string]$list.reason } }
  $rows = @($list.rows)
  $n = $needle.Trim().ToLower()
  $exact = @($rows | Where-Object { ([string]$_.name).ToLower() -eq $n })
  if ($exact.Count -ge 1) { return @{ ok = $true; rows = $exact; all = $rows } }
  $sub = @($rows | Where-Object { ([string]$_.name).ToLower().Contains($n) })
  if ($sub.Count -ge 1) { return @{ ok = $true; rows = $sub; all = $rows } }
  return @{ ok = $false; rows = @(); all = $rows }
}

# ---------------------------------------------------------------------------
# the compound click
# ---------------------------------------------------------------------------
function Do-Click {
  param($expectWindow)
  $out = [ordered]@{}
  $before = [CUAct]::Foreground()
  if ($before -ne [IntPtr]::Zero) { $out.foreground_before = [CUAct]::Title($before) }

  # -- expect_window pre-flight, in the SAME process as the click. Running it as
  # a separate PowerShell call cost ~380 ms and opened a window in which focus
  # could change between the check and the action.
  if (-not [string]::IsNullOrWhiteSpace([string]$expectWindow)) {
    $title = if ($before -eq [IntPtr]::Zero) { '' } else { [CUAct]::Title($before) }
    if (-not $title.ToLower().Contains(([string]$expectWindow).ToLower())) {
      return @{
        ok = $true; refused = $true; expected_window = [string]$expectWindow
        focused_window = @{ title = $title; pid = [int][CUAct]::PidOf($before); hwnd = $before.ToInt64() }
        error_en = "refused: foreground window '$title' does not contain '$expectWindow'"
      }
    }
  }

  $method = 'mouse'
  $point = $null
  $info = [ordered]@{}

  if ($null -ne $cfg.target) {
    $r = Resolve-Target $cfg.target
    if ($r.ok -ne $true) {
      return @{ ok = $false; error = "target element not found on screen any more (it may have been closed or replaced); take a fresh computer_screenshot" }
    }
    $row = $r.row
    $info.name = $row.name
    $info.type = $row.type
    $info.rect = $row.rect
    $info.hwnd = $r.hwnd.ToInt64()
    if ($row.automationId) { $info.automationId = $row.automationId }
    if ($cfg.no_invoke -ne $true) {
      $used = Invoke-Element $row._el 'auto'
      if ($null -ne $used) {
        $method = $used
        $point = @($row.cx, $row.cy)
      }
    }
    if ($method -eq 'mouse') { $point = @($row.cx, $row.cy) }
  }
  elseif (-not [string]::IsNullOrWhiteSpace([string]$cfg.name)) {
    $h = if ($before -ne [IntPtr]::Zero) { $before } else { [CUAct]::Foreground() }
    $f = Find-ByName ([string]$cfg.name) $h
    if ($f.ok -ne $true) {
      $names = @($f.all | Where-Object { $_.name } | Select-Object -First 25 | ForEach-Object { $_.name })
      return @{
        ok = $false
        error = "no element named '$($cfg.name)' in the focused window"
        hint = 'Take a computer_screenshot with annotate and use a ref instead, or pass an exact coordinate.'
        visible_names = $names
      }
    }
    if (@($f.rows).Count -gt 1) {
      $alts = @($f.rows | Select-Object -First 12 | ForEach-Object { @{ name = $_.name; type = $_.type; rect = $_.rect } })
      return @{ ok = $true; ambiguous = $true; matches = $alts; hint = "$(@($f.rows).Count) elements match '$($cfg.name)'; click one by ref or coordinate" }
    }
    $row = @($f.rows)[0]
    $info.name = $row.name
    $info.type = $row.type
    $info.rect = $row.rect
    if ($cfg.no_invoke -ne $true) {
      $used = Invoke-Element $row._el 'auto'
      if ($null -ne $used) { $method = $used; $point = @($row.cx, $row.cy) }
    }
    if ($method -eq 'mouse') { $point = @($row.cx, $row.cy) }
  }
  else {
    $point = @([int]$cfg.coordinate[0], [int]$cfg.coordinate[1])
  }

  $btn = [string]$cfg.button
  if ([string]::IsNullOrWhiteSpace($btn)) { $btn = 'click' }

  if ($method -eq 'mouse') {
    if ($null -eq $point) { return @{ ok = $false; error = 'no target resolved' } }
    $x = [int]$point[0]; $y = [int]$point[1]
    $got = [CUAct]::MoveVerified($x, $y)
    Start-Sleep -Milliseconds 25
    if ($btn -eq 'right_click') { [CUAct]::Button([CUAct]::MOUSEEVENTF_RIGHTDOWN, [CUAct]::MOUSEEVENTF_RIGHTUP) }
    elseif ($btn -eq 'double_click') {
      [CUAct]::Button([CUAct]::MOUSEEVENTF_LEFTDOWN, [CUAct]::MOUSEEVENTF_LEFTUP)
      Start-Sleep -Milliseconds 40
      [CUAct]::Button([CUAct]::MOUSEEVENTF_LEFTDOWN, [CUAct]::MOUSEEVENTF_LEFTUP)
    }
    elseif ($btn -eq 'middle_click') { [CUAct]::Button([CUAct]::MOUSEEVENTF_MIDDLEDOWN, [CUAct]::MOUSEEVENTF_MIDDLEUP) }
    else { [CUAct]::Button([CUAct]::MOUSEEVENTF_LEFTDOWN, [CUAct]::MOUSEEVENTF_LEFTUP) }
    $out.moved_to = $got
    if ($got[0] -ne $x -or $got[1] -ne $y) {
      $out.pointer_clamped = $true
      $out.hint_en = "pointer requested [$x,$y] but landed at [$($got[0]),$($got[1])]"
    }
  }
  $out.method = $method
  $out.clicked = $point
  if ($info.Count -gt 0) { $out.target = $info }

  Start-Sleep -Milliseconds 120
  if ($cfg.probe -eq $false) { return $out }
  $after = [CUAct]::Foreground()
  if ($after -ne [IntPtr]::Zero) { $out.foreground_after = [CUAct]::Title($after) }

  # What actually sits under the click now? Only meaningful for a mouse click.
  if ($method -eq 'mouse' -and $null -ne $point) {
    try {
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase -ErrorAction Stop
      $pt = New-Object System.Windows.Point([int]$point[0], [int]$point[1])
      $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      if ($null -ne $el) {
        $r = $el.Current.BoundingRectangle
        $at = [ordered]@{ }
        if ($el.Current.Name) { $at.name = $el.Current.Name }
        $at.type = $el.Current.LocalizedControlType
        if ($el.Current.AutomationId) { $at.automationId = $el.Current.AutomationId }
        $at.pid = [int]$el.Current.ProcessId
        $at.rect = @([int]$r.X, [int]$r.Y, [int]([int]$r.X + [int]$r.Width), [int]($r.Y + [int]$r.Height))
        $out.at = $at
        $out.at.matches_target = ($null -ne $info.name -and $info.name -eq $el.Current.Name)
      }
    } catch { }
  }

  # A click that only raised a background window was consumed by activation.
  if ($method -eq 'mouse' -and $method -ne 'invoke' -and $null -ne $point) {
    if ($before -ne $after -and $after -ne [IntPtr]::Zero) {
      $vr = [CUAct]::VisibleRect($after)
      $inside = ($point[0] -ge $vr.Left -and $point[0] -le $vr.Right -and $point[1] -ge $vr.Top -and $point[1] -le $vr.Bottom)
      if ($inside) {
        $out.activated_only = $true
        $out.hint_en = 'the click most likely only raised the window; replay it once'
      }
    }
  }
  return $out
}

# ---------------------------------------------------------------------------
# dispatcher
# ---------------------------------------------------------------------------
$VK = @{
  'ctrl'=0x11; 'control'=0x11; 'shift'=0x10; 'alt'=0x12; 'super'=0x5B; 'meta'=0x5B; 'win'=0x5B; 'cmd'=0x5B;
  'enter'=0x0D; 'return'=0x0D; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'space'=0x20; 'backspace'=0x08;
  'delete'=0x2E; 'del'=0x2E; 'insert'=0x2D; 'home'=0x24; 'end'=0x23; 'pageup'=0x21; 'pagedown'=0x22;
  'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'clear'=0x0C;
  'pause'=0x13; 'prtsc'=0x2C; 'printscreen'=0x2C; 'scrolllock'=0x91; 'numlock'=0x90; 'capslock'=0x14;
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x6F + $i }
function Resolve-Key($name) {
  $n = ([string]$name).Trim().ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return @{ vk = [UInt16]$VK[$n] } }
  if ($n.Length -eq 1) {
    $c = $n[0]
    if ($c -ge 'a' -and $c -le 'z') { return @{ vk = [UInt16](0x41 + ([int]$c - 97)) } }
    if ($c -ge '0' -and $c -le '9') { return @{ vk = [UInt16](0x30 + ([int]$c - 48)) } }
    return @{ ch = [char]$c }
  }
  return $null
}

switch ($action) {

  'dpi' {
    Emit @{ ok = $true; awareness = [int][CUAct]::MakeDpiAware(); monitor_dpi = [int][CUAct]::MonitorDpi(10, 10) }
  }

  'getpos' {
    Emit @{ ok = $true; cursor = [CUAct]::Cursor() }
  }

  'foreground' {
    $h = [CUAct]::Foreground()
    Emit @{ ok = $true; window = $(if ($h -eq [IntPtr]::Zero) { $null } else { WindowRecord $h }) }
  }

  'windows' {
    $minW = if ($null -ne $cfg.minWidth) { [int]$cfg.minWidth } else { 1 }
    $minH = if ($null -ne $cfg.minHeight) { [int]$cfg.minHeight } else { 1 }
    $fg = [CUAct]::Foreground()
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($h in [CUAct]::Handles()) {
      if (-not [CUAct]::IsWindowVisible($h)) { continue }
      $rec = WindowRecord $h
      if ($rec.width -lt $minW -or $rec.height -lt $minH) { continue }
      if ($rec.tool_window -and $h -ne $fg) { continue }
      if ([string]::IsNullOrWhiteSpace($rec.title) -and $h -ne $fg) { continue }
      $out.Add($rec)
    }
    Emit @{ ok = $true; count = $out.Count; zOrderTopFirst = $true; windows = $out.ToArray() }
  }

  'elements' {
    $h = $null
    if ($null -ne $cfg.hwnd -and [int64]$cfg.hwnd -ne 0) { $h = [IntPtr][int64]$cfg.hwnd }
    else { $h = [CUAct]::Foreground() }
    if ($h -eq [IntPtr]::Zero) { Fail("no foreground window to enumerate") }
    $inc = ($cfg.include_static -eq $true)
    $maxOut = if ($null -ne $cfg.max) { [int]$cfg.max } else { 80 }
    $list = Get-RefList -Root $h -MaxOut $maxOut -IncludeStatic:$inc
    if ($list.ok -ne $true) { Emit @{ ok = $true; count = 0; available = $false; reason = [string]$list.reason; window = (WindowRecord $h) } }
    $briefs = New-Object System.Collections.Generic.List[object]
    $i = 0
    foreach ($row in @($list.rows)) { $i++; $briefs.Add((Element-Brief $row $i)) }
    Emit @{
      ok = $true; available = $true; count = $briefs.Count
      scanned = $list.scanned; ms = $list.ms
      window = (WindowRecord $h)
      elements = $briefs.ToArray()
    }
  }

  'resolve' {
    if ($null -ne $cfg.target) {
      $r = Resolve-Target $cfg.target
      if ($r.ok -ne $true) { Emit @{ ok = $true; found = $false } }
      Emit @{ ok = $true; found = $true; element = (Element-Brief $r.row 0); candidates = $r.candidates; hwnd = $r.hwnd.ToInt64() }
    }
    $h = [CUAct]::Foreground()
    $f = Find-ByName ([string]$cfg.name) $h
    if ($f.ok -ne $true) { Emit @{ ok = $true; found = $false } }
    $briefs = New-Object System.Collections.Generic.List[object]
    $i = 0
    foreach ($row in @($f.rows)) { $i++; $briefs.Add((Element-Brief $row $i)) }
    Emit @{ ok = $true; found = $true; matches = $briefs.ToArray() }
  }

  'click' {
    $res = Do-Click $cfg.expectWindow
    # Only default to success. Assigning unconditionally turned a legitimate
    # "target not found" refusal into a reported success. Index by key rather
    # than calling ContainsKey: [ordered]@{} is an OrderedDictionary, which has
    # Contains but NOT ContainsKey (that one belongs to Hashtable).
    if ($null -eq $res['ok']) { $res['ok'] = $true }
    Emit $res
  }

  'move' {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $got = [CUAct]::MoveVerified($x, $y)
    Emit @{ ok = $true; cursor = $got; requested = @($x, $y) }
  }

  'drag' {
    $sx = [int]$cfg.from[0]; $sy = [int]$cfg.from[1]
    $tx = [int]$cfg.to[0]; $ty = [int]$cfg.to[1]
    [void][CUAct]::MoveVerified($sx, $sy)
    Start-Sleep -Milliseconds 40
    if ($null -ne $cfg.holdKeys -and @($cfg.holdKeys).Count -gt 0) {
      foreach ($hk in @($cfg.holdKeys)) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey('vk')) { [CUAct]::KeyDown($r.vk) } }
      Start-Sleep -Milliseconds 40
    }
    [CUAct]::Down([CUAct]::MOUSEEVENTF_LEFTDOWN)
    $steps = 14
    for ($i = 1; $i -le $steps; $i++) {
      $px = [int]($sx + ($tx - $sx) * $i / $steps); $py = [int]($sy + ($ty - $sy) * $i / $steps)
      [void][CUAct]::MoveAbs($px, $py)
      Start-Sleep -Milliseconds 12
    }
    [void][CUAct]::MoveVerified($tx, $ty)
    Start-Sleep -Milliseconds 30
    [CUAct]::Up([CUAct]::MOUSEEVENTF_LEFTUP)
    if ($null -ne $cfg.holdKeys -and @($cfg.holdKeys).Count -gt 0) {
      Start-Sleep -Milliseconds 30
      $rev = @($cfg.holdKeys); [array]::Reverse($rev)
      foreach ($hk in $rev) { $r = Resolve-Key $hk; if ($null -ne $r -and $r.ContainsKey('vk')) { [CUAct]::KeyUp($r.vk) } }
    }
    Emit @{ ok = $true; from = @($sx, $sy); to = @($tx, $ty); cursor = [CUAct]::Cursor() }
  }

  'scroll' {
    $x = [int]$cfg.coordinate[0]; $y = [int]$cfg.coordinate[1]
    $dir = [string]$cfg.direction; if ([string]::IsNullOrWhiteSpace($dir)) { $dir = 'down' }
    $clicks = [int]$cfg.clicks; if ($clicks -le 0) { $clicks = 1 }
    [void][CUAct]::MoveVerified($x, $y)
    Start-Sleep -Milliseconds 20
    $notches = 120 * $clicks
    if ($dir -eq 'up') { [CUAct]::Wheel((To-U32 $notches)) }
    elseif ($dir -eq 'down') { [CUAct]::Wheel((To-U32 (-$notches))) }
    elseif ($dir -eq 'left') { [CUAct]::HWheel((To-U32 $notches)) }
    else { [CUAct]::HWheel((To-U32 (-$notches))) }
    Emit @{ ok = $true; cursor = @($x, $y); direction = $dir; clicks = $clicks }
  }

  'type' {
    $text = [string]$cfg.text
    $interval = [int]$cfg.typingIntervalMs; if ($interval -lt 0) { $interval = 0 }
    # Typing into a named field is the common case, and UIA can put the caret
    # there without spending a click and without depending on the field's
    # on-screen position.
    if ($null -ne $cfg.target) {
      $r = Resolve-Target $cfg.target
      if ($r.ok -eq $true) {
        try { $r.row._el.SetFocus(); Start-Sleep -Milliseconds 60 } catch { }
      }
    } elseif (-not [string]::IsNullOrWhiteSpace([string]$cfg.name)) {
      $h = [CUAct]::Foreground()
      $f = Find-ByName ([string]$cfg.name) $h
      if ($f.ok -eq $true -and @($f.rows).Count -ge 1) {
        try { @($f.rows)[0]._el.SetFocus(); Start-Sleep -Milliseconds 60 } catch { }
      }
    }
    $count = 0
    foreach ($ch in $text.ToCharArray()) {
      [CUAct]::CharDown($ch); Start-Sleep -Milliseconds 6; [CUAct]::CharUp($ch)
      $count++
      if ($interval -gt 0) { Start-Sleep -Milliseconds $interval }
    }
    if ($cfg.sendEnter) { [CUAct]::KeyDown(0x0D); Start-Sleep -Milliseconds 20; [CUAct]::KeyUp(0x0D) }
    $fg = [CUAct]::Foreground()
    Emit @{
      ok = $true; chars = $count; sendEnter = [bool]$cfg.sendEnter
      focused_window = $(if ($fg -eq [IntPtr]::Zero) { $null } else { [CUAct]::Title($fg) })
      focused_pid = [int][CUAct]::PidOf($fg)
    }
  }

  'keypress' {
    $keys = @($cfg.keys)
    if ($keys.Count -eq 0) { Fail("keypress requires at least one key") }
    $down = @()
    foreach ($k in $keys) { $r = Resolve-Key $k; if ($null -eq $r) { Fail("unknown key: $k") }; $down += ,$r }
    foreach ($r in $down) { if ($r.ContainsKey('vk')) { [CUAct]::KeyDown($r.vk) } else { [CUAct]::CharDown($r.ch) } }
    Start-Sleep -Milliseconds 50
    $up = @($down); [array]::Reverse($up)
    foreach ($r in $up) { if ($r.ContainsKey('vk')) { [CUAct]::KeyUp($r.vk) } else { [CUAct]::CharUp($r.ch) } }
    $fg = [CUAct]::Foreground()
    Emit @{ ok = $true; keys = ($keys -join '+'); focused_window = $(if ($fg -eq [IntPtr]::Zero) { $null } else { [CUAct]::Title($fg) }) }
  }

  'activate' {
    $target = Resolve-Window -hwnd $cfg.hwnd -pid_ $cfg.pid -title $cfg.title
    if ($null -eq $target -or $target -eq [IntPtr]::Zero) { Fail("no matching window (not found by hwnd/pid/title)") }
    [void][CUAct]::Activate($target)
    Start-Sleep -Milliseconds 220
    $fg = [CUAct]::Foreground()
    $succeeded = ($fg -eq $target)
    $out = [ordered]@{
      ok = $true
      activated = $succeeded
      requested = $target.ToInt64()
      foreground = (WindowRecord $fg)
    }
    if (-not $succeeded) {
      # Hiding a foreground window leaves Windows reporting it as foreground even
      # though nothing is on screen. Saying "a hidden window holds the foreground"
      # is a very different instruction from "the window never came forward".
      $fgVisible = ($fg -ne [IntPtr]::Zero) -and [CUAct]::IsWindowVisible($fg)
      $out.foreground_visible = $fgVisible
      if (-not $fgVisible) {
        $out.hint_en = "activation blocked by a HIDDEN window (hwnd $($fg.ToInt64()) '$([CUAct]::Title($fg))') that the system still reports as foreground; bring the target forward with an explicit click on its title bar, or Activate again"
      } else {
        $out.hint_en = "the requested window never became foreground (a UWP or privileged window may be holding it); retrying usually works"
      }
    }
    Emit $out
  }

  'screenshot' {
    try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop }
    catch { Fail("cannot load System.Windows.Forms/System.Drawing: $($_.Exception.Message)") }
    $outPath = [string]$cfg.outPath
    if ([string]::IsNullOrWhiteSpace($outPath)) { Fail("outPath is required") }
    try {
      $dir = [System.IO.Path]::GetDirectoryName($outPath)
      if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
    } catch { Fail("cannot create output dir: $($_.Exception.Message)") }
    $scale = 1.0
    if ($null -ne $cfg.scale) { $scale = [double]$cfg.scale; if ($scale -le 0 -or $scale -gt 1) { $scale = 1.0 } }

    # Enumerate BEFORE capturing: the caller needs the ref list to match the
    # picture, and one process means the two cannot disagree about the desktop.
    #
    # This runs on EVERY screenshot, not only when the labels are drawn. The ref
    # list is the primary way to address a control and it is what removes the need
    # to read coordinates off a downscaled image; gating it on `annotate` meant the
    # default call came back with no refs at all. `annotate` decides only whether
    # the refs are ALSO painted onto the image; annotateMax: 0 opts out entirely.
    $annotated = @()
    $annoWindow = $null
    $annoMax = if ($null -ne $cfg.annotateMax) { [int]$cfg.annotateMax } else { 60 }
    if ($annoMax -ne 0) {
      $h = $null
      if ($null -ne $cfg.hwnd -and [int64]$cfg.hwnd -ne 0) { $h = [IntPtr][int64]$cfg.hwnd } else { $h = [CUAct]::Foreground() }
      if ($h -ne [IntPtr]::Zero) {
        $list = Get-RefList -Root $h -MaxOut $annoMax
        if ($list.ok -eq $true) {
          $i = 0
          foreach ($row in @($list.rows)) {
            $i++
            $annotated += [ordered]@{ ref = "e$i"; row = $row; brief = (Element-Brief $row $i) }
          }
        }
        $annoWindow = WindowRecord $h
      }
    }

    $vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $vx = [int]$vb.X; $vy = [int]$vb.Y
    $vw = [int]$vb.Width; $vh = [int]$vb.Height
    $fullW = $vw; $fullH = $vh
    $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh))) } finally { $g.Dispose() }

    $dst = $bmp; $owned = $false
    try {
      if ($null -ne $cfg.region -and @($cfg.region).Count -eq 4) {
        $px0 = [int][Math]::Floor([double]$cfg.region[0] * $vw); $py0 = [int][Math]::Floor([double]$cfg.region[1] * $vh)
        $px1 = [int][Math]::Ceiling([double]$cfg.region[2] * $vw); $py1 = [int][Math]::Ceiling([double]$cfg.region[3] * $vh)
        if ($px1 -gt $px0 -and $py1 -gt $py0 -and $px0 -ge 0 -and $py0 -ge 0) {
          $pw = $px1 - $px0; $ph = $py1 - $py0
          $crop = New-Object System.Drawing.Bitmap($pw, $ph)
          $cg = [System.Drawing.Graphics]::FromImage($crop)
          try { $cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)), (New-Object System.Drawing.Rectangle($px0, $py0, $pw, $ph)), [System.Drawing.GraphicsUnit]::Pixel) }
          finally { $cg.Dispose(); $bmp.Dispose() }
          $dst = $crop; $owned = $true; $vw = $pw; $vh = $ph; $vx += $px0; $vy += $py0
        }
      }
      # Exact screen -> image factors. Using the REQUESTED scale here would be
      # subtly wrong (the bitmap size is rounded), and it was the wrong OPERATOR:
      # screen-to-image MULTIPLIES. Dividing put every annotated element outside
      # the image, so nothing was ever drawn while the result still reported
      # annotated:true.
      $capW = $vw; $capH = $vh
      if ($scale -lt 1.0) {
        $sw = [int][Math]::Round($vw * $scale); $sh = [int][Math]::Round($vh * $scale)
        if ($sw -gt 0 -and $sh -gt 0 -and $sw -ne $vw) {
          $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
          $sg = [System.Drawing.Graphics]::FromImage($scaled)
          try { $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $sg.DrawImage($dst, 0, 0, $sw, $sh) }
          finally { $sg.Dispose(); if ($owned) { $dst.Dispose() } }
          $dst = $scaled; $owned = $true; $vw = $sw; $vh = $sh
        }
      }
      $scaleX = $vw / [double]$capW
      $scaleY = $vh / [double]$capH

      $g2 = [System.Drawing.Graphics]::FromImage($dst)
      $font = $null; $gPen = $null; $gInk = $null
      $chip = $null; $aInk = $null; $aPen = $null; $aPen2 = $null; $aFont = $null
      $labeledCount = 0
      try {
        $grid = 0
        if ($null -ne $cfg.grid) { $grid = [int]$cfg.grid }
        if ($grid -ge 20) {
          $stepX = $grid * $scaleX
          if ($stepX -ge 6) {
            $font = New-Object System.Drawing.Font('Consolas', 11)
            $gInk = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 96, 96))
            $gShadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
            $gPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 255, 96, 96), 1)
            $stepY = $grid * $scaleY
            $i = 1
            while ($i * $stepX -lt $vw) {
              $xi = [int]($i * $stepX)
              $g2.DrawLine($gPen, $xi, 0, $xi, $vh)
              $lab = "$($vx + $i * $grid)"
              $g2.DrawString($lab, $font, $gShadow, [single]($xi + 4), 5)
              $g2.DrawString($lab, $font, $gInk, [single]($xi + 3), 4)
              $i++
            }
            if ($stepY -ge 6) {
              $j = 1
              while ($j * $stepY -lt $vh) {
                $yi = [int]($j * $stepY)
                $g2.DrawLine($gPen, 0, $yi, $vw, $yi)
                $lab = "$($vy + $j * $grid)"
                $g2.DrawString($lab, $font, $gShadow, 5, [single]($yi + 4))
                $g2.DrawString($lab, $font, $gInk, 4, [single]($yi + 3))
                $j++
              }
            }
            $gShadow.Dispose()
          }
        }

        # Draw the ref chips. The whole point is that a caller can read a label off
        # the picture instead of estimating a pixel position from it. Large and
        # opaque on purpose: an unreadable label invites a guess, which is worse
        # than no annotation at all.
        if (@($annotated).Count -gt 0) {
          $chip = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(246, 255, 214, 0))
          $aInk = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
          $aPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(235, 255, 40, 40), 2)
          $aPen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 0, 110, 255), 3)
          $aFont = New-Object System.Drawing.Font('Consolas', 15, [System.Drawing.FontStyle]::Bold)
          $drawn = New-Object System.Collections.Generic.List[object]
          foreach ($a in $annotated) {
            $r = $a.row.rect
            $l = [int](($r[0] - $vx) * $scaleX)
            $t = [int](($r[1] - $vy) * $scaleY)
            $rr = [int](($r[2] - $vx) * $scaleX)
            $bb = [int](($r[3] - $vy) * $scaleY)
            if ($rr -lt 0 -or $bb -lt 0 -or $l -gt $vw -or $t -gt $vh) { continue }
            $w = $rr - $l; $ht = $bb - $t
            if ($w -lt 3 -or $ht -lt 3) { continue }
            $usePen = if ($a.row.focused) { $aPen2 } else { $aPen }
            $g2.DrawRectangle($usePen, $l, $t, $w, $ht)
            $lab = [string]$a.ref
            $sz = $g2.MeasureString($lab, $aFont)
            $cw = [int]$sz.Width + 4; $chh = [int]$sz.Height + 2
            # Prefer to sit just above the control, drop inside when there is no
            # room. On a dense grid every chip collides, so a colliding label is
            # skipped and only the outline stays. A wall of overlapping labels is
            # unreadable and would be worse than no annotation; the textual element
            # list already covers that case.
            $lx = $l
            $ly = $t - $chh
            if ($ly -lt 0) { $ly = $t + 1 }
            # Parenthesise the sums: inside @(...) the COMMA binds tighter than
            # '+', so @($lx, $ly, $lx + $cw, $ly + $chh) silently flattens into a
            # six-element array and the overlap test never matches anything.
            $box = @($lx, $ly, ($lx + $cw), ($ly + $chh))
            $collide = $false
            foreach ($d in $drawn) {
              if (-not ($box[2] -lt $d[0] -or $box[0] -gt $d[2] -or $box[3] -lt $d[1] -or $box[1] -gt $d[3])) { $collide = $true; break }
            }
            if ($collide) { continue }
            $drawn.Add($box)
            $g2.FillRectangle($chip, $lx, $ly, $cw, $chh)
            $g2.DrawString($lab, $aFont, $aInk, [single]($lx + 2), [single]($ly + 1))
          }
          $labeledCount = $drawn.Count
        }
      } finally {
        if ($font) { $font.Dispose() }
        if ($gPen) { $gPen.Dispose() }
        if ($gInk) { $gInk.Dispose() }
        if ($chip) { $chip.Dispose() }
        if ($aInk) { $aInk.Dispose() }
        if ($aPen) { $aPen.Dispose() }
        if ($aPen2) { $aPen2.Dispose() }
        if ($aFont) { $aFont.Dispose() }
        $g2.Dispose()
      }

      $ext = [System.IO.Path]::GetExtension($outPath).ToLowerInvariant()
      if ($ext -eq '.jpg' -or $ext -eq '.jpeg') { $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Jpeg) }
      else { $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png) }
    } finally { if ($dst) { $dst.Dispose() } }

    $briefs = New-Object System.Collections.Generic.List[object]
    foreach ($a in $annotated) { $briefs.Add($a.brief) }
    Emit @{
      ok = $true; path = $outPath; width = $vw; height = $vh
      full_width = $fullW; full_height = $fullH
      virtual_offset = @($vx, $vy); scale = $scale
      # Exact screen pixels per image pixel. Recomputed by the caller from the
      # requested scale would be wrong after a region crop or a rounded resize.
      screen_per_image = @(($capW / [double]$vw), ($capH / [double]$vh))
      annotated = ($annotated.Count -gt 0)
      labeled = $labeledCount
      element_count = $briefs.Count
      elements = $briefs.ToArray()
      window = $annoWindow
      monitor_dpi = [int][CUAct]::MonitorDpi([int]($vx + $vw / 2), [int]($vy + $vh / 2))
    }
  }

  default { Fail("unknown action: $action") }
}
