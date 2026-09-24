# The folder is data, never interpolated into a PowerShell command or argument string.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    $studioPath = $env:PRIME_STUDIO_OPEN_DIRECTORY
    if ([string]::IsNullOrWhiteSpace($studioPath) -or -not (Test-Path -LiteralPath $studioPath -PathType Container)) {
        throw 'Folder is unavailable.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudioExplorerWindow {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)]
    private struct FOCUSMSG
    {
        public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam;
        public uint time; public int x; public int y; public uint lPrivate;
    }
    [DllImport("user32.dll")]
    private static extern bool PeekMessage(out FOCUSMSG message, IntPtr hWnd, uint min, uint max, uint remove);

    public static bool ActivateWindow(IntPtr hWnd)
    {
        if (GetForegroundWindow() == hWnd) return true;
        SetForegroundWindow(hWnd);
        if (GetForegroundWindow() == hWnd) return true;
        // Join input queues only for the duration of activation. This does
        // not elevate the process, change system policy or synthesize shortcuts.
        FOCUSMSG message;
        PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
        uint ignored;
        uint current = GetCurrentThreadId();
        uint target = GetWindowThreadProcessId(hWnd, out ignored);
        IntPtr foregroundWindow = GetForegroundWindow();
        uint foreground = foregroundWindow == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foregroundWindow, out ignored);
        bool joinedForeground = false;
        bool joinedTarget = false;
        try
        {
            if (foreground != 0 && foreground != current)
                joinedForeground = AttachThreadInput(current, foreground, true);
            if (target != 0 && target != current && target != foreground)
                joinedTarget = AttachThreadInput(current, target, true);
            BringWindowToTop(hWnd);
            SetForegroundWindow(hWnd);
            SetActiveWindow(hWnd);
            SetFocus(hWnd);
            return GetForegroundWindow() == hWnd;
        }
        finally
        {
            if (joinedTarget) AttachThreadInput(current, target, false);
            if (joinedForeground) AttachThreadInput(current, foreground, false);
        }
    }
}
'@
    $studioShell = New-Object -ComObject Shell.Application
    $studioFolder = $studioShell.NameSpace($studioPath)
    if ($null -eq $studioFolder) { throw 'Folder is unavailable to Explorer.' }
    $studioTarget = [IO.Path]::GetFullPath($studioFolder.Self.Path).TrimEnd('\')

    function Find-StudioFolderWindow {
        $studioMatches = @($studioShell.Windows()) | Where-Object {
            try {
                [IO.Path]::GetFileName($_.FullName) -ieq 'explorer.exe' -and
                    [string]::Equals([IO.Path]::GetFullPath($_.Document.Folder.Self.Path).TrimEnd('\'), $studioTarget, [StringComparison]::OrdinalIgnoreCase)
            } catch { $false }
        }
        # Reuse existing windows, including those hidden by older Studio versions.
        $studioMatches | Sort-Object { -[int][StudioExplorerWindow]::IsWindowVisible([IntPtr]$_.HWND) } | Select-Object -First 1
    }

    $studioWindow = Find-StudioFolderWindow
    if ($null -eq $studioWindow) {
        # SW_SHOWNORMAL is intentional: the user explicitly requested a visible folder.
        $studioShell.ShellExecute($studioPath, '', '', 'open', 1)
    }
    $studioDeadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        if ($null -eq $studioWindow) { $studioWindow = Find-StudioFolderWindow }
        if ($null -ne $studioWindow) {
            $studioHandle = [IntPtr]$studioWindow.HWND
            if (-not [StudioExplorerWindow]::IsWindowVisible($studioHandle) -or [StudioExplorerWindow]::IsIconic($studioHandle)) {
                [void][StudioExplorerWindow]::ShowWindowAsync($studioHandle, 9) # SW_RESTORE
            }
            $studioActivated = [StudioExplorerWindow]::ActivateWindow($studioHandle)
            if ($studioActivated -and [StudioExplorerWindow]::IsWindowVisible($studioHandle) -and -not [StudioExplorerWindow]::IsIconic($studioHandle)) {
                Write-Output '{"opened":true,"visible":true,"foreground":true}'
                exit 0
            }
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $studioDeadline)
    throw 'Explorer did not bring the folder to the foreground.'
} catch {
    [Console]::Error.WriteLine('Explorer did not confirm a foreground folder window.')
    exit 1
}
