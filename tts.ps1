# Text-to-speech for the study-notes app, using the voices built into Windows.
# Called by serve.py:  tts.ps1 -In job.json -Out out.wav
#
# job.json: { "rate": -1, "items": [ {"k":"en","t":"apple"},
#                                    {"k":"pause","ms":2000},
#                                    {"k":"zh","t":"..."} ] }
# English uses an en-US voice (Zira preferred), Chinese a zh-TW voice (Hanhan).
# Everything goes into one PromptBuilder so the pauses are exact and the result
# is a single WAV; serve.py turns it into MP3 with ffmpeg.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'

function Fail($msg) {
  [Console]::Error.WriteLine('TTS_ERROR: ' + $msg)
  exit 1
}

try {
  Add-Type -AssemblyName System.Speech
} catch {
  Fail 'System.Speech not available'
}

try {
  $job = [IO.File]::ReadAllText($In, (New-Object Text.UTF8Encoding $false)) | ConvertFrom-Json
} catch {
  Fail 'cannot read job'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })

function Pick-Voice($culture, $prefer) {
  $same = @($voices | Where-Object { $_.Culture.Name -eq $culture })
  if ($same.Count -eq 0) {
    $base = $culture.Split('-')[0]
    $same = @($voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $base })
  }
  $hit = @($same | Where-Object { $_.Name -like "*$prefer*" })
  if ($hit.Count -gt 0) { return $hit[0] }
  if ($same.Count -gt 0) { return $same[0] }
  return $null
}

$en = Pick-Voice 'en-US' $(if ($job.enVoice) { $job.enVoice } else { 'Zira' })
$zh = Pick-Voice 'zh-TW' $(if ($job.zhVoice) { $job.zhVoice } else { 'Hanhan' })
if (-not $en) { Fail 'no English voice installed' }
if (-not $zh) { Fail 'no Chinese voice installed' }

$rate = 0
if ($job.rate -ne $null) { $rate = [Math]::Max(-10, [Math]::Min(10, [int]$job.rate)) }
$synth.Rate = $rate

$pb = New-Object System.Speech.Synthesis.PromptBuilder
$n = 0
foreach ($it in $job.items) {
  if ($it.k -eq 'pause') {
    $ms = [Math]::Max(0, [Math]::Min(20000, [int]$it.ms))
    $pb.AppendBreak([TimeSpan]::FromMilliseconds($ms))
    continue
  }
  $text = [string]$it.t
  if (-not $text.Trim()) { continue }
  if ($it.k -eq 'en') { $v = $en } else { $v = $zh }
  $pb.StartVoice($v)
  $pb.AppendText($text)
  $pb.EndVoice()
  $n++
}
if ($n -eq 0) { Fail 'nothing to read' }

try {
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak($pb)
} catch {
  Fail ('speech failed: ' + $_.Exception.Message)
} finally {
  $synth.SetOutputToNull()
  $synth.Dispose()
}
