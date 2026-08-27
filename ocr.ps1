# Windows built-in OCR (Windows.Media.Ocr) -- called by serve.py
#
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI,
# so non-ASCII characters here would break parsing.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 `
#              -Path in.png -Out out.txt -Lang zh-Hant-TW

param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Lang = 'zh-Hant-TW'
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

# WinRT async calls need to be bridged to .NET tasks before we can wait on them
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]             | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]          | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]    | Out-Null

# Everything below reports failures as a single clean ASCII line on stderr.
# PowerShell's own error formatting would include this script's path, which
# contains Chinese and comes back to serve.py as mojibake.
function Fail($msg) {
  [Console]::Error.WriteLine('OCR_ERROR: ' + $msg)
  exit 1
}

$language = New-Object Windows.Globalization.Language $Lang
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if (-not $engine) {
  $have = ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages |
    ForEach-Object { $_.LanguageTag }) -join ', '
  Fail "language pack not installed: $Lang (available: $have)"
}

try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync(0)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}
catch {
  Fail 'cannot read image'
}

try {
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
}
catch {
  Fail 'recognition failed'
}

# --- Emit text plus geometry ----------------------------------------------
# OcrResult.Lines is NOT in visual order, and a wide gap (the long underline of
# a fill-in-the-blank worksheet) splits one printed line into two OcrLines that
# can come back far apart in the list. So don't assemble anything here: just
# hand every line's bounding box to the caller, which reassembles the page.
$lines = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  $x1 = [double]::PositiveInfinity; $y1 = [double]::PositiveInfinity
  $x2 = [double]::NegativeInfinity; $y2 = [double]::NegativeInfinity
  $n = 0
  foreach ($wd in $line.Words) {
    $r = $wd.BoundingRect
    if ($r.X -lt $x1) { $x1 = $r.X }
    if ($r.Y -lt $y1) { $y1 = $r.Y }
    if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
    $n++
  }
  if ($n -eq 0) { continue }
  [void]$lines.Add([pscustomobject]@{
      t = $line.Text
      x = [Math]::Round($x1, 1)
      y = [Math]::Round($y1, 1)
      w = [Math]::Round($x2 - $x1, 1)
      h = [Math]::Round($y2 - $y1, 1)
    })
}

# Write the file ourselves as UTF-8 without BOM -- going through the console
# would re-encode into the OEM code page and mangle Chinese.
try {
  $json = ConvertTo-Json -InputObject @{ lines = @($lines) } -Depth 4 -Compress
  [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))
}
catch {
  Fail 'cannot write result file'
}
