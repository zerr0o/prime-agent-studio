# Self-test for runtime/computer-use-overlay.cs — PURE checks only.
# Compiles the class (PowerShell 5 CodeDom = C# 5 syntax gate) and asserts the
# validated pixel math + initial/stopped status. NEVER calls Start(), so no
# window is created, shown, captured, or touched. Exit code 0 = pass.
$ErrorActionPreference = 'Stop'
$fail = 0
function Assert($cond, $name, $detail) {
  if ($cond) { Write-Host "PASS $name" }
  else { Write-Host "FAIL $name ($detail)"; $script:fail++ }
}
Add-Type -Path (Join-Path $PSScriptRoot 'computer-use-overlay.cs') `
  -ReferencedAssemblies System.Windows.Forms,System.Drawing
# Alpha curve: 240 on outer 2 px, quadratic fade, 0 from 24 px.
Assert ([StudioComputerUseOverlay]::BorderAlpha(0) -eq 240) 'alpha d=0' 'want 240'
Assert ([StudioComputerUseOverlay]::BorderAlpha(1) -eq 240) 'alpha d=1' 'want 240'
Assert ([StudioComputerUseOverlay]::BorderAlpha(2) -eq 240) 'alpha d=2' 'want 240'
Assert ([StudioComputerUseOverlay]::BorderAlpha(13) -eq 60) 'alpha d=13' 'want 60 (t=0.5)'
Assert ([StudioComputerUseOverlay]::BorderAlpha(3) -eq 219) 'alpha d=3' 'want 219'
Assert ([StudioComputerUseOverlay]::BorderAlpha(8) -eq 127) 'alpha d=8' 'want 127'
Assert ([StudioComputerUseOverlay]::BorderAlpha(23) -eq 0) 'alpha d=23' 'want 0'
Assert ([StudioComputerUseOverlay]::BorderAlpha(24) -eq 0) 'alpha d=24' 'want 0'
Assert ([StudioComputerUseOverlay]::BorderAlpha(100) -eq 0) 'alpha d=100' 'want 0'
# Premultiplied #FF8A24: d=0 -> a=240 r=240 g=129 b=33 ; d=13 -> a=60 r=60 g=32 b=8
$p0 = [StudioComputerUseOverlay]::BorderPixel(0)
Assert ((($p0 -shr 24) -band 255) -eq 240) 'pixel d=0 alpha' $p0
Assert ((($p0 -shr 16) -band 255) -eq 240) 'pixel d=0 red' $p0
Assert ((($p0 -shr 8) -band 255) -eq 129) 'pixel d=0 green' $p0
Assert (($p0 -band 255) -eq 33) 'pixel d=0 blue' $p0
$p13 = [StudioComputerUseOverlay]::BorderPixel(13)
Assert ((($p13 -shr 24) -band 255) -eq 60) 'pixel d=13 alpha' $p13
Assert ((($p13 -shr 16) -band 255) -eq 60) 'pixel d=13 red' $p13
Assert ((($p13 -shr 8) -band 255) -eq 32) 'pixel d=13 green' $p13
Assert (($p13 -band 255) -eq 8) 'pixel d=13 blue' $p13
Assert ([StudioComputerUseOverlay]::BorderPixel(24) -eq 0) 'pixel d=24 transparent' 'want 0'
# Status without Start: nothing visible, nothing excluded, no error.
$s = [StudioComputerUseOverlay]::GetStatus()
Assert ($s.Visible -eq $false) 'initial Visible=false' $s.Visible
Assert ($s.CaptureExcluded -eq $false) 'initial CaptureExcluded=false' $s.CaptureExcluded
Assert ($s.WindowCount -eq 0) 'initial WindowCount=0' $s.WindowCount
Assert ($s.MonitorCount -eq 0) 'initial MonitorCount=0' $s.MonitorCount
Assert ($null -eq $s.Error) 'initial Error=null' $s.Error
# Stop() with nothing running is idempotent and reports cleanup done.
Assert ([StudioComputerUseOverlay]::Stop() -eq $true) 'Stop idempotent' 'want true'
if ($fail -gt 0) { Write-Host "$fail FAILURE(S)"; exit 1 }
Write-Host 'ALL PASS (no windows created)'
