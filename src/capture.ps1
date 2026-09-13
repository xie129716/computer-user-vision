# computer-user / capture.ps1 — full-virtual-screen (multi-monitor) screenshot.
# DPI-aware so pixel coordinates match the physical screen (no drift on scaled displays).
# Input:  -Json <base64(UTF8 JSON)>  { "outPath": string, "region": [x0,y0,x1,y1]|null (0..1), "scale": 0.1..1 }
# Output: stdout { ok, path, width, height, virtual_offset:[vx,vy], scale } | { ok:false, error }
param([string]$Json = "")
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Fail($msg) { Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $msg }); exit 2 }

try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing -ErrorAction Stop
} catch { Fail("cannot load System.Windows.Forms/System.Drawing: $($_.Exception.Message)") }

# DPI awareness (before reading screen bounds so coordinates match pixels).
try {
  Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class CUdpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }' -ErrorAction Stop
  [CUdpi]::SetProcessDPIAware() | Out-Null
} catch { /* non-fatal: falls back to virtualized coords */ }

if ([string]::IsNullOrWhiteSpace($Json)) { Fail("missing -Json parameter") }
$cfg = $null
try {
  $raw = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Json))
  $cfg = $raw | ConvertFrom-Json
} catch { Fail("bad -Json: $($_.Exception.Message)") }

$outPath = [string]$cfg.outPath
if ([string]::IsNullOrWhiteSpace($outPath)) { Fail("outPath is required") }
try {
  $dir = [System.IO.Path]::GetDirectoryName($outPath)
  if (-not [string]::IsNullOrWhiteSpace($dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
} catch { Fail("cannot create output dir: $($_.Exception.Message)") }

$scale = 1.0
if ($null -ne $cfg.scale) { $scale = [double]$cfg.scale; if ($scale -le 0 -or $scale -gt 1) { $scale = 1.0 } }

$vb = [System.Windows.Forms.SystemInformation]::VirtualScreen
$vx = [int]$vb.X; $vy = [int]$vb.Y
$vw = [int]$vb.Width; $vh = [int]$vb.Height

$bmp = $null
try {
  $bmp = New-Object System.Drawing.Bitmap($vw, $vh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
  } finally { $g.Dispose() }
} catch { if ($bmp) { $bmp.Dispose() }; Fail("CopyFromScreen failed: $($_.Exception.Message)") }

# Optional fractional region crop [x0, y0, x1, y1] (0..1) -> pixel box.
$dst = $bmp; $ownedDst = $false
try {
  if ($null -ne $cfg.region -and $cfg.region.Count -eq 4) {
    $rx0 = [double]$cfg.region[0]; $ry0 = [double]$cfg.region[1]
    $rx1 = [double]$cfg.region[2]; $ry1 = [double]$cfg.region[3]
    $px0 = [int][Math]::Floor($rx0 * $vw); $py0 = [int][Math]::Floor($ry0 * $vh)
    $px1 = [int][Math]::Ceiling($rx1 * $vw); $py1 = [int][Math]::Ceiling($ry1 * $vh)
    if ($px1 -gt $px0 -and $py1 -gt $py0 -and $px0 -ge 0 -and $py0 -ge 0) {
      $pw = $px1 - $px0; $ph = $py1 - $py0
      $crop = New-Object System.Drawing.Bitmap($pw, $ph)
      $cg = [System.Drawing.Graphics]::FromImage($crop)
      try { $cg.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)), (New-Object System.Drawing.Rectangle($px0, $py0, $pw, $ph)), [System.Drawing.GraphicsUnit]::Pixel) }
      finally { $cg.Dispose(); $bmp.Dispose() }
      $dst = $crop; $ownedDst = $true
      $vw = $pw; $vh = $ph
      $vx += $px0; $vy += $py0
    }
  }
  if ($scale -lt 1.0) {
    $sw = [int][Math]::Round($vw * $scale); $sh = [int][Math]::Round($vh * $scale)
    if ($sw -gt 0 -and $sh -gt 0 -and $sw -ne $vw) {
      $scaled = New-Object System.Drawing.Bitmap($sw, $sh)
      $sg = [System.Drawing.Graphics]::FromImage($scaled)
      try { $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; $sg.DrawImage($dst, 0, 0, $sw, $sh) }
      finally { $sg.Dispose(); if ($ownedDst) { $dst.Dispose() } }
      $dst = $scaled; $ownedDst = $true
      $vw = $sw; $vh = $sh
    }
  }
  # Optional coordinate grid, drawn every N VIRTUAL-SCREEN pixels and labelled
  # with the screen coordinate. A downscaled capture is the usual place a model
  # loses its place, because the preview no longer has 1:1 pixels to count
  # against; the labels remove the arithmetic entirely.
  $grid = 0
  if ($null -ne $cfg.grid) { $grid = [int]$cfg.grid }
  if ($grid -ge 20 -and $scale -gt 0) {
    $g2 = [System.Drawing.Graphics]::FromImage($dst)
    $labelFont = $null; $labelBrush = $null; $linePen = $null
    try {
      $labelFont = New-Object System.Drawing.Font("Consolas", 11)
      $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 96, 96))
      $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 0, 0, 0))
      $linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 255, 96, 96), 1)
      $step = [double]$grid * $scale        # screen px -> image px
      if ($step -ge 6) {
        $i = 0; $x = 0.0
        while ($x -lt $vw) {
          $g2.DrawLine($linePen, [int]$x, 0, [int]$x, $vh)
          $label = "$($vx + [int][Math]::Round($x / $scale))"
          $px = [single]([int]$x + 3)
          $g2.DrawString($label, $labelFont, $shadowBrush, $px + 1, 4)
          $g2.DrawString($label, $labelFont, $labelBrush, $px, 3)
          $i++; $x = $i * $step
        }
        $j = 0; $y = 0.0
        while ($y -lt $vh) {
          $g2.DrawLine($linePen, 0, [int]$y, $vw, [int]$y)
          $label = "$($vy + [int][Math]::Round($y / $scale))"
          $py = [single]([int]$y + 3)
          $g2.DrawString($label, $labelFont, $shadowBrush, 4, $py + 1)
          $g2.DrawString($label, $labelFont, $labelBrush, 3, $py)
          $j++; $y = $j * $step
        }
      }
    } finally {
      if ($labelFont) { $labelFont.Dispose() }
      if ($labelBrush) { $labelBrush.Dispose() }
      if ($shadowBrush) { $shadowBrush.Dispose() }
      if ($linePen) { $linePen.Dispose() }
      $g2.Dispose()
    }
  }
  $ext = [System.IO.Path]::GetExtension($outPath).ToLowerInvariant()
  if ($ext -eq ".jpg" -or $ext -eq ".jpeg") {
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  } else {
    $dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} catch { Fail("image save failed: $($_.Exception.Message)") }
finally { if ($dst) { $dst.Dispose() } }

$result = @{ ok = $true; path = $outPath; width = $vw; height = $vh; virtual_offset = @($vx, $vy); scale = $scale }
Write-Output ([System.Text.Encoding]::UTF8.GetString([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress $result))))
exit 0
