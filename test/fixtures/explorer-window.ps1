param([ValidateSet('inspect', 'hide', 'minimize', 'close')][string]$Mode = 'inspect')
$ErrorActionPreference = 'Stop'
$studioPath = [IO.Path]::GetFullPath($env:PRIME_STUDIO_TEST_FOLDER)
$studioRoot = [IO.Path]::GetDirectoryName($studioPath)
# Test mutations are restricted to the one newly created temporary fixture.
if (-not [IO.Path]::GetFileName($studioRoot).StartsWith('prime-studio-explorer-') -or
    [IO.Path]::GetDirectoryName($studioRoot).TrimEnd('\') -ine [IO.Path]::GetTempPath().TrimEnd('\')) {
    throw 'Not an owned Explorer test directory.'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioExplorerTest {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$studioShell = New-Object -ComObject Shell.Application
$studioMatches = @($studioShell.Windows()) | Where-Object {
    try { [IO.Path]::GetFullPath($_.Document.Folder.Self.Path).TrimEnd('\') -ieq $studioPath.TrimEnd('\') } catch { $false }
}
$studioResults = @($studioMatches | ForEach-Object {
    $studioHandle = [IntPtr]$_.HWND
    if ($Mode -eq 'hide') { [void][StudioExplorerTest]::ShowWindow($studioHandle, 0) }
    if ($Mode -eq 'minimize') { [void][StudioExplorerTest]::ShowWindow($studioHandle, 6) }
    $studioResult = @{ hwnd = $_.HWND; visible = [StudioExplorerTest]::IsWindowVisible($studioHandle); minimized = [StudioExplorerTest]::IsIconic($studioHandle); foreground = [StudioExplorerTest]::GetForegroundWindow() -eq $studioHandle }
    if ($Mode -eq 'close') { $_.Quit() }
    $studioResult
})
ConvertTo-Json -InputObject $studioResults -Compress
