# The folder is data, never interpolated into a PowerShell command or argument string.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $terminalPath = $env:PRIME_STUDIO_OPEN_TERMINAL
    if ([string]::IsNullOrWhiteSpace($terminalPath) -or -not (Test-Path -LiteralPath $terminalPath -PathType Container)) {
        throw 'Folder is unavailable.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioTerminalShell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr ShellExecuteW(IntPtr hwnd, string operation, string file, string parameters, string directory, int show);
}
'@
    $terminalRoot = [IO.Path]::GetFullPath($terminalPath)
    $terminalExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # SW_SHOWNORMAL is intentional: the user explicitly requested a visible terminal,
    # so only the helper stays hidden even when the Studio inherited SW_HIDE.
    # Windows PowerShell can reset the ShellExecute working directory on startup.
    # Set its location after profiles load, using inherited data, never interpolated code.
    $terminalArgs = '-NoExit -Command "Set-Location -LiteralPath $env:PRIME_STUDIO_OPEN_TERMINAL"'
    $terminalResult = [StudioTerminalShell]::ShellExecuteW([IntPtr]::Zero, 'open', $terminalExe, $terminalArgs, $terminalRoot, 1)
    if ($terminalResult.ToInt64() -le 32) { throw 'Shell did not accept the terminal.' }
    Write-Output '{"opened":true}'
    exit 0
} catch {
    [Console]::Error.WriteLine('PowerShell did not open at the requested folder.')
    exit 1
}
