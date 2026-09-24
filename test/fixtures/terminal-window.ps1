param([int]$HelperPid)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$HelperPid" | Where-Object { $_.Name -ieq 'powershell.exe' -and $_.CommandLine -match '\s-NoExit -Command' })
if ($children.Count -ne 1) { throw "Expected one owned PowerShell child, found $($children.Count)." }
$root = [IO.Path]::GetDirectoryName($env:PRIME_STUDIO_OPEN_TERMINAL)
if (-not [IO.Path]::GetFileName($root).StartsWith('prime-terminal-native-') -or
    [IO.Path]::GetDirectoryName($root).TrimEnd('\') -ine [IO.Path]::GetTempPath().TrimEnd('\')) {
    throw 'Not an owned terminal test directory.'
}
$terminalPid = [int]$children[0].ProcessId
try {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TerminalProbe {
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [StructLayout(LayoutKind.Sequential)] struct COORD { public short x, y; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr handle, StringBuilder text, uint length, COORD origin, out uint read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static string Read(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) throw new Exception("Cannot attach owned terminal");
    IntPtr handle=CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    try {
      if (!IsWindowVisible(GetConsoleWindow())) throw new Exception("Owned terminal is not visible");
      var text=new StringBuilder(32768); uint read;
      if (!ReadConsoleOutputCharacter(handle, text, 32768, new COORD(), out read)) throw new Exception("Cannot read terminal prompt");
      return text.ToString();
    } finally { CloseHandle(handle); FreeConsole(); }
  }
}
'@
$expected = ('PS ' + $env:PRIME_STUDIO_OPEN_TERMINAL + '>') -replace '\s',''
$deadline = [DateTime]::UtcNow.AddSeconds(5)
$matched = $false
$text = ''
do {
    try {
        $text = [TerminalProbe]::Read($terminalPid)
        $matched = ($text -replace '\s','').Contains($expected)
    } catch { $text = $_.Exception.Message }
    if (-not $matched) { Start-Sleep -Milliseconds 100 }
} while (-not $matched -and [DateTime]::UtcNow -lt $deadline)
if (-not $matched) { throw "PowerShell did not display the expected folder prompt: $($text.Trim())" }
@{ passed = $true; visible = $true; cwdVerified = $true; terminalPid = $terminalPid } | ConvertTo-Json -Compress
} finally {
  # Only the exact child spawned by our test helper is stopped.
  Stop-Process -Id $terminalPid -ErrorAction SilentlyContinue
}
