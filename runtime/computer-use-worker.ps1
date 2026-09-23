param([switch]$SelfTest)
# Prime Agent Studio: Windows Computer Use worker (hidden, persistent, dependency-free).
# Reads JSON-lines requests on stdin, writes JSON-lines responses on stdout.
# Request  { "id": 1, "method": "status|windows|observe|act|stop", "params": { } }
# Response { "id": 1, "result": { } } | { "id": 1, "error": { "code": "...", "message": "..." } }
# Notify   { "event": "ready|stopped", ... }  (no id; never carries image bytes)
# Diagnostics go to stderr. Stdout carries ONLY JSON lines.
# Coordinates are SCREEN PHYSICAL pixels. No frame transform happens here.
# Freshness: act accepts params.expectedFrame { windowId, bounds, desktopBounds,
# foregroundWindowId, requireForeground }. Geometry and screen layout are verified
# BEFORE any input is sent (STALE_FRAME / WINDOW_MINIMIZED), and the focus guard
# is re-checked before each keyboard action (FOCUS_CHANGED). No input is sent
# when the frame is stale.
# Generation binding: every request line may carry a numeric generation. stop
# advances the worker stop generation; older mutating commands (act input and
# windows focus) queued before the stop are rejected with STALE_GENERATION and
# never resume after a re-enable. Listing, status and observe stay read-only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:HotkeyText = 'Ctrl+Alt+Shift+F10'
$script:MaxActions = 20
$script:MaxTextLength = 2000
$script:MaxWaitMs = 5000
$script:MaxKeysPerPress = 8
$script:MaxPathPoints = 20
$script:MaxScrollDelta = 100
$script:DefaultMaxWidth = 1280
$script:StopRequested = $false
$script:StopReason = 'user'
$script:StopReported = $true
$script:SelfTestFailed = 0
$script:StopGeneration = 0
$script:StopIds = @()
$script:Deferred = New-Object System.Collections.ArrayList
$script:Eof = $false
$script:HeldVks = New-Object System.Collections.Generic.HashSet[int]
$script:HeldButtons = New-Object System.Collections.Generic.HashSet[string]
$script:OwnsMutex = $false
$script:Mutex = $null
$script:HotkeyRegistered = $false
$script:HotkeyError = 0
$script:DpiAware = $false

$pinvoke = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StudioComputerUseInput
{
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;
    public const int MOUSEEVENTF_MOVE = 0x0001;
    public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const int MOUSEEVENTF_LEFTUP = 0x0004;
    public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const int MOUSEEVENTF_RIGHTUP = 0x0010;
    public const int MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const int MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const int MOUSEEVENTF_XDOWN = 0x0080;
    public const int MOUSEEVENTF_XUP = 0x0100;
    public const int MOUSEEVENTF_WHEEL = 0x0800;
    public const int MOUSEEVENTF_HWHEEL = 0x1000;
    public const int KEYEVENTF_KEYUP = 0x0002;
    public const int KEYEVENTF_UNICODE = 0x0004;
    public const int XBUTTON1 = 0x0001;
    public const int XBUTTON2 = 0x0002;
    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx; public int dy; public int mouseData; public int dwFlags; public int time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public short wVk; public short wScan; public int dwFlags; public int time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public int uMsg; public short wParamL; public short wParamH;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public int type; public INPUTUNION u;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X; public int Y;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left; public int Top; public int Right; public int Bottom;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
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
        public uint time; public POINT pt; public uint lPrivate;
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

    public static uint SendMouse(int flags, int data)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dx = 0;
        inputs[0].u.mi.dy = 0;
        inputs[0].u.mi.mouseData = data;
        inputs[0].u.mi.dwFlags = flags;
        inputs[0].u.mi.time = 0;
        inputs[0].u.mi.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    public static uint SendVk(int vk, bool keyUp)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = (short)vk;
        inputs[0].u.ki.wScan = 0;
        inputs[0].u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        inputs[0].u.ki.time = 0;
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    public static uint SendUnicodeChar(char ch, bool keyUp)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = 0;
        inputs[0].u.ki.wScan = (short)ch;
        inputs[0].u.ki.dwFlags = keyUp ? (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) : KEYEVENTF_UNICODE;
        inputs[0].u.ki.time = 0;
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
        return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}

public static class StudioComputerUseHotkey
{
    private const int MOD_ALT = 0x0001;
    private const int MOD_CONTROL = 0x0002;
    private const int MOD_SHIFT = 0x0004;
    private const int VK_F10 = 0x79;
    private const int HOTKEY_ID = 0xC0DE;
    private const int WM_HOTKEY = 0x0312;
    private static Thread thread;
    private static ManualResetEvent ack;
    private static volatile bool pressed;
    private static volatile bool registered;
    private static volatile int errorCode;
    private static uint hotThreadId;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam;
        public uint time; public POINT pt;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint Msg, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static void MessageLoop()
    {
        hotThreadId = GetCurrentThreadId();
        uint mods = MOD_CONTROL | MOD_ALT | MOD_SHIFT;
        bool ok = RegisterHotKey(IntPtr.Zero, HOTKEY_ID, mods, VK_F10);
        if (!ok) { try { errorCode = Marshal.GetLastWin32Error(); } catch { errorCode = -1; } }
        registered = ok;
        try { ack.Set(); } catch { }
        if (!ok) { return; }
        try
        {
            MSG msg;
            int ret;
            while ((ret = GetMessage(out msg, IntPtr.Zero, 0, 0)) != 0)
            {
                if (ret == -1) { break; }
                if (msg.message == WM_HOTKEY && msg.wParam.ToUInt32() == HOTKEY_ID) { pressed = true; }
            }
        }
        finally
        {
            try { UnregisterHotKey(IntPtr.Zero, HOTKEY_ID); } catch { }
        }
    }
    public static bool Start()
    {
        try
        {
            ack = new ManualResetEvent(false);
            registered = false;
            errorCode = 0;
            pressed = false;
            hotThreadId = 0;
            thread = new Thread(new ThreadStart(MessageLoop));
            thread.IsBackground = true;
            thread.Start();
            try { ack.WaitOne(2000); } catch { }
            return registered;
        }
        catch { return false; }
    }
    public static int GetErrorCode()
    {
        return errorCode;
    }
    public static bool ConsumePress()
    {
        if (pressed) { pressed = false; return true; }
        return false;
    }
    public static void Stop()
    {
        try { if (hotThreadId != 0) { PostThreadMessage(hotThreadId, 0x0012, UIntPtr.Zero, IntPtr.Zero); } } catch { }
        try { if (thread != null) { thread.Join(2000); } } catch { }
    }
}
"@
Add-Type -TypeDefinition $pinvoke -ErrorAction Stop
$script:DpiAwareness = 'unaware'
try {
    # PerMonitorV2 (Windows 10 1703+): correct physical pixels on mixed-DPI desktops.
    if ([StudioComputerUseInput]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $script:DpiAwareness = 'permonitorv2' }
} catch { }
if ($script:DpiAwareness -eq 'unaware') {
    try {
        if ([StudioComputerUseInput]::SetProcessDpiAwareness(2) -eq 0) { $script:DpiAwareness = 'permonitor' }
    } catch { }
}
if ($script:DpiAwareness -eq 'unaware') {
    try { if ([StudioComputerUseInput]::SetProcessDPIAware()) { $script:DpiAwareness = 'system' } } catch { }
}
$script:DpiAware = ($script:DpiAwareness -ne 'unaware')


# ---------- JSON lines I/O (stdout ONLY; diagnostics to stderr) ----------
function Send-Line($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
function Send-Result($id, $result) { Send-Line @{ id = $id; result = $result } }
function Send-Error($id, $code, $message) { Send-Line @{ id = $id; error = @{ code = $code; message = $message } } }
function Send-Notify($eventName, $extra) {
    $obj = @{ event = $eventName }
    if ($null -ne $extra) { foreach ($k in $extra.Keys) { $obj[$k] = $extra[$k] } }
    Send-Line $obj
}
function Write-Diag($message) { [Console]::Error.WriteLine([string]$message) }

function Get-VirtualScreen {
    return @{
        x = [StudioComputerUseInput]::GetSystemMetrics(76)
        y = [StudioComputerUseInput]::GetSystemMetrics(77)
        width = [StudioComputerUseInput]::GetSystemMetrics(78)
        height = [StudioComputerUseInput]::GetSystemMetrics(79)
    }
}

# ---------- stop support: latched stop, hotkey flag + queued stdin lines ----------
# The stop latch stays set until fresh accepted work resets it at dispatch.
# Invoke-Act never resets it, so a stopped worker cannot be reopened by stale work.
function Set-LatchedStop($reason, $gen) {
    $script:StopRequested = $true
    $script:StopReason = $reason
    $script:StopReported = $false
    if ($null -ne $gen) {
        try { if ([long]$gen -gt $script:StopGeneration) { $script:StopGeneration = [long]$gen } } catch { }
    }
}

function Drain-QueuedLines {
    # Non-blocking, never calls Test-Stop (no recursion). Stop lines latch the
    # stop and advance the stop generation; anything else waits in Deferred for
    # dispatch, where the generation gate rejects pre-stop work with
    # STALE_GENERATION instead of resuming it.
    $line = $null
    while ($script:Queue.TryDequeue([ref]$line)) {
        if ($null -eq $line) { $script:Eof = $true; break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $msg = $null
        try { $msg = $line | ConvertFrom-Json } catch { continue }
        if ($null -eq $msg) { continue }
        if ($msg.method -eq 'stop') {
            $r = 'user'
            try { if (-not [string]::IsNullOrWhiteSpace($msg.params.reason)) { $r = [string]$msg.params.reason } } catch { }
            $g = $null
            try { if ($null -ne $msg.generation) { $g = [long]$msg.generation } else { $g = $script:StopGeneration + 1 } } catch { }
            Set-LatchedStop $r $g
            if ($null -ne $msg.id) { $script:StopIds += $msg.id }
        } else {
            [void]$script:Deferred.Add($msg)
        }
    }
}

function Test-Stop {
    # Every interrupt checkpoint funnels through here so an HTTP stop queued on
    # stdin preempts even mid-action (wait slices, typed text, scroll, drag).
    try {
        if ([StudioComputerUseHotkey]::ConsumePress()) {
            Set-LatchedStop 'hotkey' ($script:StopGeneration + 1)
        }
    } catch { }
    Drain-QueuedLines
    # EOF (driver closed stdin) cancels like a stop; held inputs are released
    # by the callers finally blocks and the main loop exits.
    return ($script:StopRequested -or $script:Eof)
}

function Test-StopRequested { return $script:StopRequested }

# ---------- held-input bookkeeping (only OUR OWN presses; never a broad key-up) ----------
function Release-HeldInputs {
    foreach ($vk in @($script:HeldVks)) {
        try { [void][StudioComputerUseInput]::SendVk([int]$vk, $true) } catch { }
    }
    $script:HeldVks.Clear()
    foreach ($button in @($script:HeldButtons)) {
        try {
            switch ($button) {
                'left' { [void][StudioComputerUseInput]::SendMouse(4, 0) }
                'right' { [void][StudioComputerUseInput]::SendMouse(16, 0) }
                'middle' { [void][StudioComputerUseInput]::SendMouse(64, 0) }
                'x1' { [void][StudioComputerUseInput]::SendMouse(256, 1) }
                'x2' { [void][StudioComputerUseInput]::SendMouse(256, 2) }
            }
        } catch { }
    }
    $script:HeldButtons.Clear()
}

$script:VkMap = @{
    'backspace' = 8; 'tab' = 9; 'enter' = 13; 'return' = 13; 'shift' = 16; 'ctrl' = 17; 'control' = 17
    'alt' = 18; 'pause' = 19; 'escape' = 27; 'esc' = 27; 'space' = 32; 'pageup' = 33; 'pagedown' = 34
    'end' = 35; 'home' = 36; 'left' = 37; 'up' = 38; 'right' = 39; 'down' = 40; 'insert' = 45; 'delete' = 46; 'del' = 46
    'win' = 91; 'meta' = 91; 'apps' = 93
}
for ($i = 0; $i -le 9; $i++) { $script:VkMap[[string]$i] = 48 + $i }
for ($i = 0; $i -lt 26; $i++) { $letter = [char](97 + $i); $script:VkMap[[string]$letter] = 65 + $i }
for ($i = 1; $i -le 24; $i++) { $script:VkMap[('f' + $i)] = 111 + $i }

function Resolve-Vk($name) {
    if ($null -eq $name) { return $null }
    $key = ([string]$name).Trim().ToLowerInvariant()
    if ($script:VkMap.ContainsKey($key)) { return [int]$script:VkMap[$key] }
    # Single punctuation characters are intentionally unsupported here; use the
    # type action (Unicode SendInput) for printable text instead.
    return $null
}

function Press-Vk($vk) {
    $n = [StudioComputerUseInput]::SendVk([int]$vk, $false)
    if ($n -eq 0) { throw 'SendInput inserted 0 events (key down).' }
    [void]$script:HeldVks.Add([int]$vk)
}
function Release-Vk($vk) {
    $n = [StudioComputerUseInput]::SendVk([int]$vk, $true)
    if ($n -eq 0) { throw 'SendInput inserted 0 events (key up).' }
    [void]$script:HeldVks.Remove([int]$vk)
}
# ---------- mouse + keyboard primitives (physical pixels) ----------
function Move-Pointer($x, $y) {
    if (-not [StudioComputerUseInput]::SetCursorPos([int]$x, [int]$y)) { throw 'SetCursorPos was refused by Windows.' }
    Start-Sleep -Milliseconds 20
}
function Mouse-ButtonDown($button) {
    switch ($button) {
        'left' { $n = [StudioComputerUseInput]::SendMouse(2, 0) }
        'right' { $n = [StudioComputerUseInput]::SendMouse(8, 0) }
        'middle' { $n = [StudioComputerUseInput]::SendMouse(32, 0) }
        default { throw ('Unsupported mouse button: ' + $button) }
    }
    if ($n -eq 0) { throw 'SendInput inserted 0 events (button down).' }
    [void]$script:HeldButtons.Add($button)
}
function Mouse-ButtonUp($button) {
    switch ($button) {
        'left' { $n = [StudioComputerUseInput]::SendMouse(4, 0) }
        'right' { $n = [StudioComputerUseInput]::SendMouse(16, 0) }
        'middle' { $n = [StudioComputerUseInput]::SendMouse(64, 0) }
        default { throw ('Unsupported mouse button: ' + $button) }
    }
    if ($n -eq 0) { throw 'SendInput inserted 0 events (button up).' }
    [void]$script:HeldButtons.Remove($button)
}
function Invoke-Click($x, $y, $button) {
    Move-Pointer $x $y
    Mouse-ButtonDown $button
    Start-Sleep -Milliseconds 40
    Mouse-ButtonUp $button
}
# Scroll contract (backend aligned): integer ticks within +-100. Positive
# deltaY scrolls DOWN, positive deltaX scrolls RIGHT. Windows WHEEL_DELTA is
# positive for up, so the vertical data is negated; HWHEEL is positive right.
function Invoke-ScrollTicks($deltaX, $deltaY) {
    foreach ($kind in @('x', 'y')) {
        $ticks = if ($kind -eq 'x') { [int]$deltaX } else { [int]$deltaY }
        if ($ticks -eq 0) { continue }
        $remaining = $ticks
        while ($remaining -ne 0) {
            if (Test-Stop) { throw 'STOPPED' }
            $one = [Math]::Max(-3, [Math]::Min(3, $remaining))
            if ($kind -eq 'x') { $n = [StudioComputerUseInput]::SendMouse(4096, $one * 120) }
            else { $n = [StudioComputerUseInput]::SendMouse(2048, (0 - $one * 120)) }
            if ($n -eq 0) { throw 'SendInput inserted 0 events (scroll).' }
            $remaining -= $one
            Start-Sleep -Milliseconds 15
        }
    }
}
function Invoke-KeyPress($keys) {
    $vks = @()
    foreach ($name in $keys) {
        $vk = Resolve-Vk $name
        if ($null -eq $vk) { throw ('Unknown key: ' + $name) }
        $vks += [int]$vk
    }
    $pressed = @()
    try {
        foreach ($vk in $vks) { Press-Vk $vk; $pressed += $vk; Start-Sleep -Milliseconds 15 }
    } finally {
        for ($i = $pressed.Count - 1; $i -ge 0; $i--) {
            try { Release-Vk $pressed[$i] } catch { }
        }
    }
    Start-Sleep -Milliseconds 20
}
function Invoke-TypeText($text) {
    $chars = ([string]$text).ToCharArray()
    $done = 0
    foreach ($ch in $chars) {
        if ($done % 32 -eq 0 -and $done -ne 0 -and (Test-Stop)) { throw 'STOPPED' }
        if ([StudioComputerUseInput]::SendUnicodeChar([char]$ch, $false) -eq 0) { throw 'SendInput inserted 0 events (type down).' }
        if ([StudioComputerUseInput]::SendUnicodeChar([char]$ch, $true) -eq 0) { throw 'SendInput inserted 0 events (type up).' }
        $done++
        if ($done % 16 -eq 0) { Start-Sleep -Milliseconds 5 }
    }
}
function Invoke-Wait($ms) {
    $left = [int]$ms
    while ($left -gt 0) {
        if (Test-Stop) { throw 'STOPPED' }
        $slice = [Math]::Min(50, $left)
        Start-Sleep -Milliseconds $slice
        $left -= $slice
    }
}

# ---------- single action dispatch ----------
function Invoke-SingleAction($action) {
    $type = $action.type
    switch ($type) {
        'click' {
            $button = $action.button; if ([string]::IsNullOrEmpty($button)) { $button = 'left' }
            Invoke-Click $action.x $action.y $button
        }
        'double_click' {
            $button = $action.button; if ([string]::IsNullOrEmpty($button)) { $button = 'left' }
            Invoke-Click $action.x $action.y $button
            Start-Sleep -Milliseconds 60
            Invoke-Click $action.x $action.y $button
        }
        'move' { Move-Pointer $action.x $action.y }
        'drag' {
            # Drag contract (backend aligned): press at x,y, move through each
            # path point in order, release at the final path point (or at x,y
            # when no path is given).
            $button = $action.button; if ([string]::IsNullOrEmpty($button)) { $button = 'left' }
            Move-Pointer $action.x $action.y
            Mouse-ButtonDown $button
            try {
                if ($null -ne $action.path) {
                    foreach ($pt in $action.path) {
                        if (Test-Stop) { throw 'STOPPED' }
                        Move-Pointer $pt.x $pt.y
                    }
                }
            } finally {
                try { Mouse-ButtonUp $button } catch { }
            }
        }
        'scroll' {
            if ($null -ne $action.x -and $null -ne $action.y) { Move-Pointer $action.x $action.y }
            $dx = 0; $dy = 0
            if ($null -ne $action.deltaX) { $dx = [int]$action.deltaX }
            if ($null -ne $action.deltaY) { $dy = [int]$action.deltaY }
            Invoke-ScrollTicks $dx $dy
        }
        'keypress' { Invoke-KeyPress $action.keys }
        'type' { Invoke-TypeText $action.text }
        'wait' { Invoke-Wait $action.ms }
        default { throw ('Unknown action type: ' + $type) }
    }
}

# ---------- expected-frame verification (no input is sent when stale) ----------
function Assert-ExpectedFrame($expected) {
    $guard = @{ foregroundWindowId = $null; active = $false }
    if ($null -eq $expected) { return $guard }
    if ($null -ne $expected.desktopBounds) {
        $vs = Get-VirtualScreen
        $db = $expected.desktopBounds
        if ([int]$vs.x -ne [int]$db.x -or [int]$vs.y -ne [int]$db.y -or [int]$vs.width -ne [int]$db.width -or [int]$vs.height -ne [int]$db.height) {
            throw 'STALE_FRAME:The screen layout changed since the frame was captured.'
        }
    }
    $windowId = $null
    try { if (-not [string]::IsNullOrWhiteSpace($expected.windowId)) { $windowId = [string]$expected.windowId } } catch { }
    if ($null -ne $windowId) {
        $idLong = 0
        if (-not [long]::TryParse($windowId, [ref]$idLong)) { throw 'INVALID:expectedFrame.windowId must be numeric.' }
        $hWnd = [IntPtr]$idLong
        $rect = New-Object StudioComputerUseInput+RECT
        if (-not [StudioComputerUseInput]::GetWindowRect($hWnd, [ref]$rect)) { throw 'STALE_FRAME:The target window no longer exists.' }
        if ([StudioComputerUseInput]::IsIconic($hWnd)) { throw 'WINDOW_MINIMIZED:The target window is minimized.' }
        if ($null -ne $expected.bounds) {
            $b = $expected.bounds
            $tol = 2
            if ([Math]::Abs($rect.Left - [int]$b.x) -gt $tol -or [Math]::Abs($rect.Top - [int]$b.y) -gt $tol -or [Math]::Abs(($rect.Right - $rect.Left) - [int]$b.width) -gt $tol -or [Math]::Abs(($rect.Bottom - $rect.Top) - [int]$b.height) -gt $tol) {
                throw 'STALE_FRAME:The target window moved or resized since the frame was captured.'
            }
        }
    }
    $fgNeed = $null
    try { if (-not [string]::IsNullOrWhiteSpace($expected.foregroundWindowId)) { $fgNeed = [string]$expected.foregroundWindowId } } catch { }
    $reqFg = $false
    try { if ($expected.requireForeground -eq $true) { $reqFg = $true } } catch { }
    if ($null -eq $fgNeed -and $reqFg -and $null -ne $windowId) { $fgNeed = $windowId }
    if ($null -ne $fgNeed) {
        $now = [StudioComputerUseInput]::GetForegroundWindow().ToInt64().ToString()
        if ($now -ne $fgNeed) { throw 'FOCUS_CHANGED:The foreground window changed since the frame was captured.' }
        $guard.foregroundWindowId = $fgNeed
        $guard.active = $true
    }
    return $guard
}
function Assert-FocusGuard($guard) {
    if ($null -eq $guard -or -not $guard.active) { return }
    $now = [StudioComputerUseInput]::GetForegroundWindow().ToInt64().ToString()
    if ($now -ne $guard.foregroundWindowId) { throw 'FOCUS_CHANGED:The foreground window changed during the batch.' }
}

# ---------- act batch (bounded, interruptible, cleans held inputs) ----------
function Invoke-Act($params) {
    if (-not $script:OwnsMutex) { throw 'CONTROLLER_BUSY:The desktop is already controlled by another Studio worker.' }
    $actions = $params.actions
    if ($null -eq $actions -or $actions.Count -lt 1 -or $actions.Count -gt $script:MaxActions) {
        throw 'INVALID:act.actions must list 1 to 20 actions.'
    }
    $guard = Assert-ExpectedFrame $params.expectedFrame
    # No latch reset here: a stopped worker stays stopped until fresh accepted
    # work clears the latch at dispatch. Stale batches refuse immediately.
    if (Test-Stop) { throw 'STOPPED' }
    $executed = 0
    try {
        foreach ($action in $actions) {
            if (Test-Stop) { throw 'STOPPED' }
            if ($action.type -eq 'keypress' -or $action.type -eq 'type') { Assert-FocusGuard $guard }
            Invoke-SingleAction $action
            $executed++
        }
    } catch {
        $err = [string]$_
        if ($err -match 'STOPPED' -or (Test-StopRequested)) { throw 'STOPPED' }
        throw
    } finally {
        Release-HeldInputs
    }
    if (Test-Stop) { throw 'STOPPED' }
    return @{ executed = $executed }
}
# ---------- windows: list / focus ----------
function Get-WindowList {
    $items = New-Object System.Collections.ArrayList
    $foreground = [StudioComputerUseInput]::GetForegroundWindow()
    $callback = {
        param($hWnd, $lParam)
        try {
            if (-not [StudioComputerUseInput]::IsWindowVisible($hWnd)) { return $true }
            $sb = New-Object System.Text.StringBuilder(512)
            [void][StudioComputerUseInput]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
            $title = $sb.ToString()
            if ([string]::IsNullOrWhiteSpace($title)) { return $true }
            $rect = New-Object StudioComputerUseInput+RECT
            if (-not [StudioComputerUseInput]::GetWindowRect($hWnd, [ref]$rect)) { return $true }
            $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
            if ($w -le 0 -or $h -le 0) { return $true }
            $pidOut = 0
            [void][StudioComputerUseInput]::GetWindowThreadProcessId($hWnd, [ref]$pidOut)
            $procName = ''
            try { $procName = (Get-Process -Id $pidOut -ErrorAction Stop).ProcessName } catch { }
            [void]$items.Add(@{
                id = $hWnd.ToInt64().ToString()
                title = $title
                processId = $pidOut
                processName = $procName
                bounds = @{ x = $rect.Left; y = $rect.Top; width = $w; height = $h }
                foreground = ($hWnd -eq $foreground)
            })
        } catch { }
        return $true
    }.GetNewClosure()
    $proc = [StudioComputerUseInput+EnumWindowsProc]$callback
    # Keep the delegate alive for the whole enumeration.
    $script:LastEnumCallback = $proc
    [void][StudioComputerUseInput]::EnumWindows($proc, [IntPtr]::Zero)
    return @{ windows = $items.ToArray(); foreground = $foreground.ToInt64().ToString() }
}
function Focus-Window($windowId) {
    # Focus steals input routing, so it needs the single-controller mutex
    # before any native call, like act. Checked first: not even parsing runs
    # without ownership.
    if (-not $script:OwnsMutex) { throw 'CONTROLLER_BUSY:The desktop is already controlled by another Studio worker.' }
    $idLong = 0
    if (-not [long]::TryParse([string]$windowId, [ref]$idLong)) { throw 'INVALID:windowId must be a numeric window handle string.' }
    $hWnd = [IntPtr]$idLong
    if (-not [StudioComputerUseInput]::IsWindowVisible($hWnd)) { throw 'WINDOW_NOT_FOUND:The window is not visible.' }
    if ([StudioComputerUseInput]::IsIconic($hWnd)) { [void][StudioComputerUseInput]::ShowWindowAsync($hWnd, 9) }
    Invoke-Wait 100
    [void][StudioComputerUseInput]::ActivateWindow($hWnd)
    Invoke-Wait 150
    $now = [StudioComputerUseInput]::GetForegroundWindow()
    if ($now.ToInt64() -ne $idLong) { throw 'FOCUS_REFUSED:Windows did not activate the requested window.' }
    return @{ focused = $true; windowId = $idLong.ToString(); foreground = $now.ToInt64().ToString() }
}

# ---------- observe: real physical pixels + transform metadata ----------
function Capture-Rect($x, $y, $w, $h, $maxWidth) {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
        } finally { $g.Dispose() }
        $outW = $w; $outH = $h
        if ($maxWidth -gt 0 -and $w -gt $maxWidth) {
            $outW = $maxWidth
            $outH = [int][Math]::Round($h * $maxWidth / $w)
            $scaled = New-Object System.Drawing.Bitmap($outW, $outH)
            try {
                $g2 = [System.Drawing.Graphics]::FromImage($scaled)
                try {
                    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $g2.DrawImage($bmp, 0, 0, $outW, $outH)
                } finally { $g2.Dispose() }
            } catch { $scaled.Dispose(); throw }
            $bmp.Dispose()
            $bmp = $scaled
        }
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        if ($null -eq $codec) { throw 'JPEG encoder unavailable.' }
        $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 75)
        $ms = New-Object System.IO.MemoryStream
        try {
            $bmp.Save($ms, $codec, $encParams)
            $bytes = $ms.ToArray()
        } finally { $ms.Dispose() }
        return @{ data = [Convert]::ToBase64String($bytes); mimeType = 'image/jpeg'; width = $outW; height = $outH }
    } finally { $bmp.Dispose() }
}
function Invoke-Observe($params) {
    $maxWidth = $script:DefaultMaxWidth
    if ($null -ne $params.maxWidth) { $maxWidth = [int]$params.maxWidth }
    if ($maxWidth -lt 16 -or $maxWidth -gt 4096) { throw 'INVALID:observe.maxWidth must be in [16, 4096].' }
    $windowId = $null
    $bounds = $null
    if ($null -ne $params.windowId -and -not [string]::IsNullOrWhiteSpace($params.windowId)) {
        $idLong = 0
        if (-not [long]::TryParse([string]$params.windowId, [ref]$idLong)) { throw 'INVALID:observe.windowId must be numeric.' }
        $hWnd = [IntPtr]$idLong
        $rect = New-Object StudioComputerUseInput+RECT
        if (-not [StudioComputerUseInput]::GetWindowRect($hWnd, [ref]$rect)) { throw 'WINDOW_NOT_FOUND:The window no longer exists.' }
        if ([StudioComputerUseInput]::IsIconic($hWnd)) { throw 'WINDOW_MINIMIZED:The window is minimized.' }
        $bw = $rect.Right - $rect.Left; $bh = $rect.Bottom - $rect.Top
        if ($bw -lt 1 -or $bh -lt 1) { throw 'WINDOW_NOT_FOUND:The window has no visible area.' }
        $bounds = @{ x = $rect.Left; y = $rect.Top; width = $bw; height = $bh }
        $windowId = $idLong.ToString()
    } elseif ($null -ne $params.region) {
        $r = $params.region
        $bw = [int]$r.width; $bh = [int]$r.height
        if ($bw -lt 1 -or $bw -gt 8192 -or $bh -lt 1 -or $bh -gt 8192) { throw 'INVALID:observe.region width/height must be in [1, 8192].' }
        $bounds = @{ x = [int]$r.x; y = [int]$r.y; width = $bw; height = $bh }
    } else {
        $vs = Get-VirtualScreen
        $bounds = @{ x = $vs.x; y = $vs.y; width = $vs.width; height = $vs.height }
    }
    $vsnap = Get-VirtualScreen
    $fgsnap = [StudioComputerUseInput]::GetForegroundWindow().ToInt64().ToString()
    $shot = Capture-Rect $bounds.x $bounds.y $bounds.width $bounds.height $maxWidth
    $frame = @{
        width = $shot.width; height = $shot.height
        bounds = $bounds
        capturedAt = ([DateTime]::UtcNow.ToString('o'))
        scaleX = [double]$shot.width / [double]$bounds.width
        scaleY = [double]$shot.height / [double]$bounds.height
    }
    if ($null -ne $windowId) { $frame['windowId'] = $windowId }
    return @{
        image = @{ data = $shot.data; mimeType = $shot.mimeType }
        frame = $frame
        dpiAware = $script:DpiAware
        dpiAwareness = $script:DpiAwareness
        virtualScreen = $vsnap
        desktopBounds = @{ x = $vsnap.x; y = $vsnap.y; width = $vsnap.width; height = $vsnap.height }
        foregroundWindowId = $fgsnap
    }
}

# ---------- status ----------
function Invoke-Status {
    $svs = Get-VirtualScreen
    $sfg = [StudioComputerUseInput]::GetForegroundWindow().ToInt64().ToString()
    return @{
        supported = $true
        platform = 'win32'
        hotkey = $script:HotkeyText
        hotkeyRegistered = $script:HotkeyRegistered
        hotkeyError = $script:HotkeyError
        mutex = $script:OwnsMutex
        pid = $PID
        worker = 'powershell-dotnet'
        dpiAware = $script:DpiAware
        dpiAwareness = $script:DpiAwareness
        virtualScreen = $svs
        desktopBounds = @{ x = $svs.x; y = $svs.y; width = $svs.width; height = $svs.height }
        foregroundWindowId = $sfg
        stopGeneration = $script:StopGeneration
        limits = @{
            maxActions = $script:MaxActions; maxTextLength = $script:MaxTextLength
            maxWaitMs = $script:MaxWaitMs; maxKeysPerPress = $script:MaxKeysPerPress
            maxPathPoints = $script:MaxPathPoints; maxScrollDelta = $script:MaxScrollDelta
            defaultMaxWidth = $script:DefaultMaxWidth
        }
    }
}

# ---------- request dispatch ----------
function Invoke-Request($msg) {
    $id = $msg.id
    $method = $msg.method
    $params = $msg.params
    if ($null -eq $params) { $params = @{} }
    $gen = 0; $hasGen = $false
    try { if ($null -ne $msg.generation) { $gen = [long]$msg.generation; $hasGen = $true } } catch { }
    # Focus changes input routing, so it is mutating like act. Listing,
    # status and observe stay read-only so polling survives stops.
    $isMutating = ($method -eq 'act')
    try { if ($method -eq 'windows' -and $params.action -eq 'focus') { $isMutating = $true } } catch { }
    if ($method -eq 'stop') {
        if ($hasGen) { if ($gen -gt $script:StopGeneration) { $script:StopGeneration = $gen } }
        else { $script:StopGeneration += 1 }
    } elseif ($isMutating -and (($hasGen -and $gen -lt $script:StopGeneration) -or (-not $hasGen -and $script:StopGeneration -gt 0))) {
        # A queued click/type/focus from before the stop must never resume
        # after it. Callers get STALE_GENERATION instead of silent replay.
        Send-Error $id 'STALE_GENERATION' 'This command was queued before the last stop and cannot resume.'
        return
    } else {
        # Fresh accepted work resets the latched stop. Stray stop ids that were
        # never answered are completed here so no caller hangs.
        foreach ($sid in @($script:StopIds)) { try { Send-Result $sid @{ stopped = $true; reason = $script:StopReason } } catch { } }
        $script:StopIds = @()
        $script:StopRequested = $false
        $script:StopReason = 'user'
        $script:StopReported = $true
    }
    try {
        switch ($method) {
            'status' { $result = Invoke-Status; Send-Result $id $result }
            'windows' {
                $action = $params.action; if ([string]::IsNullOrEmpty($action)) { $action = 'list' }
                if ($action -eq 'list') { $listed = Get-WindowList; Send-Result $id $listed }
                elseif ($action -eq 'focus') {
                    if ([string]::IsNullOrWhiteSpace($params.windowId)) { throw 'INVALID:windows focus needs windowId.' }
                    try { $focus = Focus-Window $params.windowId }
                    catch {
                        $ferr = [string]$_
                        if ($ferr -match 'STOPPED' -or (Test-StopRequested)) {
                            Send-Error $id 'STOPPED' ('Focus stopped (' + $script:StopReason + ').')
                            return
                        }
                        throw
                    }
                    $listed = Get-WindowList
                    $focus['windows'] = $listed.windows
                    Send-Result $id $focus
                }
                else { throw 'INVALID:windows.action must be list or focus.' }
            }
            'observe' { $result = Invoke-Observe $params; Send-Result $id $result }
            'act' {
                try { $result = Invoke-Act $params; Send-Result $id $result }
                catch {
                    $err = [string]$_
                    if ($err -match 'STOPPED' -or (Test-StopRequested)) {
                        Send-Error $id 'STOPPED' ('Batch stopped (' + $script:StopReason + ').')
                    } else { throw }
                }
            }
            'stop' {
                $reason = 'user'
                try { if (-not [string]::IsNullOrWhiteSpace($params.reason)) { $reason = [string]$params.reason } } catch { }
                Set-LatchedStop $reason $script:StopGeneration
                Release-HeldInputs
                Send-Result $id @{ stopped = $true; reason = $reason }
                Send-Notify 'stopped' @{ reason = $reason; source = 'request'; stopGeneration = $script:StopGeneration }
                $script:StopReported = $true
            }
            default { Send-Error $id 'UNKNOWN_METHOD' ('Unknown method: ' + $method) }
        }
    } catch {
        $err = [string]$_
        $code = 'WORKER_ERROR'; $message = $err
        if ($err -match '^(INVALID|CONTROLLER_BUSY|STALE_FRAME|STALE_GENERATION|FOCUS_CHANGED|WINDOW_[A-Z_]+|FOCUS_REFUSED):(.*)$') {
            $code = $Matches[1]
            if ($code -eq 'INVALID') { $code = 'INVALID_PARAMS' }
            $message = $Matches[2].Trim()
        }
        if ($code -eq 'CONTROLLER_BUSY') { $message = 'The desktop is already controlled by another Studio worker.' }
        Send-Error $id $code $message
    } finally {
        Release-HeldInputs
    }
}
# ---------- self-test: no input, no capture, no hotkey, no mutex ----------
# Run with: powershell -NoProfile -NonInteractive -File computer-use-worker.ps1 -SelfTest
# Exercises generation gating, the stop latch, frame guards (via read-only
# geometry APIs) and wait preemption. Never sends input or captures pixels.
function Run-SelfTest {
    $script:SelfTestFailed = 0
    # Simulate single-controller ownership: startup (and its real mutex) is
    # skipped in self-test, but act must still exercise the input path gates.
    $script:OwnsMutex = $true
    $script:Captured = New-Object System.Collections.ArrayList
    $script:Queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
    function Send-Result($id, $result) { [void]$script:Captured.Add(@{ kind = 'result'; id = $id; result = $result }) }
    function Send-Error($id, $code, $message) { [void]$script:Captured.Add(@{ kind = 'error'; id = $id; code = $code; message = $message }) }
    function Send-Notify($eventName, $extra) { [void]$script:Captured.Add(@{ kind = 'notify'; event = $eventName; extra = $extra }) }
    function Send-Line($obj) { [void]$script:Captured.Add(@{ kind = 'line'; obj = $obj }) }
    function Check($name, $cond) {
        if ($cond) { Write-Output ("TEST-PASS " + $name) }
        else { Write-Output ("TEST-FAIL " + $name); $script:SelfTestFailed++ }
    }
    Check 'pinvoke-types' (([StudioComputerUseInput] -ne $null) -and ([StudioComputerUseHotkey] -ne $null))
    # Hotkey ack path (static compile + wiring only; Start is never called here
    # so no real global hotkey is registered by the self-test).
    $startMethod = [StudioComputerUseHotkey].GetMethod('Start')
    $errMethod = [StudioComputerUseHotkey].GetMethod('GetErrorCode')
    Check 'hotkey-ack-api' (($startMethod -ne $null) -and ($errMethod -ne $null) -and ($startMethod.ReturnType -eq [bool]))
    Check 'hotkey-error-default' ([StudioComputerUseHotkey]::GetErrorCode() -eq 0)
    $st = Invoke-Status
    Check 'status-hotkey-truth' (($st.hotkeyRegistered -eq $false) -and ($st.ContainsKey('hotkeyError')) -and ($st.hotkey -eq $script:HotkeyText))
    Check 'status-default-hotkey' ($script:HotkeyText -eq 'Ctrl+Alt+Shift+F10')
    Check 'dpi-level' (@('unaware', 'system', 'permonitor', 'permonitorv2') -contains $script:DpiAwareness)
    $script:Captured.Clear(); $script:StopGeneration = 0
    Invoke-Request @{ id = 1; method = 'stop'; params = @{ reason = 'selftest' }; generation = 5 }
    $stopNote = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 1 })
    Check 'stop-result' (($stopNote.Count -eq 1) -and ($stopNote[0].result.stopped -eq $true))
    Check 'stop-generation' ($script:StopGeneration -eq 5)
    Check 'stop-latched' ($script:StopRequested -eq $true)
    $script:Captured.Clear()
    Invoke-Request @{ id = 2; method = 'act'; params = @{ actions = @(@{ type = 'wait'; ms = 1 }) }; generation = 3 }
    $stale = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 2 })
    Check 'stale-act-rejected' (($stale.Count -eq 1) -and ($stale[0].code -eq 'STALE_GENERATION'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 3; method = 'act'; params = @{ actions = @(@{ type = 'wait'; ms = 1 }) }; generation = 5 }
    $ok = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 3 })
    Check 'fresh-act-runs' (($ok.Count -eq 1) -and ($ok[0].result.executed -eq 1))
    Check 'latch-cleared' ($script:StopRequested -eq $false)
    Set-LatchedStop 'selftest' $script:StopGeneration
    $refused = $false
    try { Invoke-Act @{ actions = @(@{ type = 'wait'; ms = 1 }) } } catch { if ([string]$_ -match 'STOPPED') { $refused = $true } }
    Check 'latched-act-refused' $refused
    Check 'latch-kept' ($script:StopRequested -eq $true)
    $script:StopRequested = $false; $script:StopReason = 'user'; $script:StopReported = $true; $script:StopGeneration = 0
    $vs = Get-VirtualScreen
    $fg = [StudioComputerUseInput]::GetForegroundWindow().ToInt64().ToString()
    $frameBad = $false
    try { Assert-ExpectedFrame @{ desktopBounds = @{ x = $vs.x; y = $vs.y; width = $vs.width + 1; height = $vs.height } } } catch { if ([string]$_ -match 'STALE_FRAME') { $frameBad = $true } }
    Check 'stale-desktop' $frameBad
    $frameOk = Assert-ExpectedFrame @{ desktopBounds = @{ x = $vs.x; y = $vs.y; width = $vs.width; height = $vs.height }; foregroundWindowId = $fg }
    Check 'fresh-frame-guard' (($frameOk.active -eq $true) -and ($frameOk.foregroundWindowId -eq $fg))
    $focusBad = $false
    try { Assert-ExpectedFrame @{ foregroundWindowId = '999999999' } } catch { if ([string]$_ -match 'FOCUS_CHANGED') { $focusBad = $true } }
    Check 'focus-changed' $focusBad
    $haveWin = ($fg -ne '0')
    $rect = New-Object StudioComputerUseInput+RECT
    if ($haveWin) { $haveWin = [StudioComputerUseInput]::GetWindowRect([StudioComputerUseInput]::GetForegroundWindow(), [ref]$rect) }
    if ($haveWin) {
        # Re-snapshot per attempt: the live window may move between reads.
        $winOk = $false
        for ($attempt = 0; $attempt -lt 2 -and -not $winOk; $attempt++) {
            $r2 = New-Object StudioComputerUseInput+RECT
            if ([StudioComputerUseInput]::GetWindowRect([StudioComputerUseInput]::GetForegroundWindow(), [ref]$r2)) {
                try {
                    $compared = Assert-ExpectedFrame @{ windowId = $fg; bounds = @{ x = $r2.Left; y = $r2.Top; width = ($r2.Right - $r2.Left); height = ($r2.Bottom - $r2.Top) } }
                    if ($compared -ne $null) { $winOk = $true }
                } catch { }
            }
        }
        Check 'window-geometry' $winOk
        $winBad = $false
        try { Assert-ExpectedFrame @{ windowId = $fg; bounds = @{ x = $rect.Left + 100; y = $rect.Top; width = $bw; height = $bh } } } catch { if ([string]$_ -match 'STALE_FRAME') { $winBad = $true } }
        Check 'window-moved' $winBad
    } else {
        Check 'window-geometry' $true
        Check 'window-moved' $true
    }
    $script:Queue.Enqueue(('{"id":90,"method":"stop","params":{"reason":"selftest"},"generation":9}'))
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $waitStopped = $false
    try { Invoke-Wait 5000 } catch { if ([string]$_ -match 'STOPPED') { $waitStopped = $true } }
    $sw.Stop()
    Check 'wait-preempted' ($waitStopped -and ($sw.ElapsedMilliseconds -lt 2000))
    Check 'wait-latched' ($script:StopRequested -eq $true)
    $script:StopRequested = $false; $script:Eof = $false
    $script:Queue.Enqueue($null)
    Check 'eof-checkpoint' ((Test-Stop) -and $script:Eof)
    $script:Eof = $false; $script:StopRequested = $false; $script:StopReason = 'user'; $script:StopReported = $true
    $script:Captured.Clear()
    Invoke-Request @{ id = 4; method = 'dance'; params = @{}; generation = 9 }
    $unk = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 4 })
    Check 'unknown-method' (($unk.Count -eq 1) -and ($unk[0].code -eq 'UNKNOWN_METHOD'))
    # Focus is mutating: stale generations reject before any native call, and
    # focusing needs the singleton mutex. Probes use bogus handles only, so no
    # real window is ever focused here.
    $script:Captured.Clear()
    Invoke-Request @{ id = 21; method = 'stop'; params = @{ reason = 'selftest' }; generation = 20 }
    Invoke-Request @{ id = 22; method = 'windows'; params = @{ action = 'focus'; windowId = '999999999' }; generation = 19 }
    $staleFocus = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 22 })
    Check 'stale-focus-rejected' (($staleFocus.Count -eq 1) -and ($staleFocus[0].code -eq 'STALE_GENERATION'))
    $script:OwnsMutex = $false
    $noMutex = $false
    try { Focus-Window 'bogus' } catch { if ([string]$_ -match 'CONTROLLER_BUSY') { $noMutex = $true } }
    Check 'focus-needs-mutex' $noMutex
    $script:OwnsMutex = $true
    $notFound = $false
    try { Focus-Window '0' } catch { if ([string]$_ -match 'WINDOW_NOT_FOUND') { $notFound = $true } }
    Check 'focus-unknown-window' $notFound
    $script:Captured.Clear()
    Invoke-Request @{ id = 23; method = 'windows'; params = @{ action = 'focus'; windowId = '0' }; generation = 20 }
    $freshFocus = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 23 })
    Check 'fresh-focus-validates' (($freshFocus.Count -eq 1) -and ($freshFocus[0].code -eq 'WINDOW_NOT_FOUND'))
    # ActivateWindow wiring only (never invoked here, so no thread attach,
    # focus change or input can occur): signature drift would break Focus-Window.
    $actMethod = [StudioComputerUseInput].GetMethod('ActivateWindow')
    $actParams = @()
    if ($actMethod -ne $null) { $actParams = $actMethod.GetParameters() }
    Check 'activate-wiring' (($actMethod -ne $null) -and ($actMethod.ReturnType -eq [bool]) -and ($actParams.Count -eq 1) -and ($actParams[0].ParameterType -eq [IntPtr]))
    Write-Output ("TEST-DONE failed=" + $script:SelfTestFailed + " dpi=" + $script:DpiAwareness)
}

if ($SelfTest) { Run-SelfTest; exit ([int]($script:SelfTestFailed -gt 0)) }

# ---------- startup: singleton mutex + hotkey (skipped in self-test) ----------
try {
    $script:Mutex = New-Object System.Threading.Mutex($false, 'Local\PrimeAgentStudioComputerUseSingleton')
    $script:OwnsMutex = $script:Mutex.WaitOne(0)
} catch { $script:OwnsMutex = $false }
# Start reports the acknowledged RegisterHotKey result. F10 is the default
# because Win32 reserves F12 for debuggers. A failed registration is reported
# explicitly (hotkeyRegistered=false + hotkeyError) and never advertised.
try {
    $script:HotkeyRegistered = [StudioComputerUseHotkey]::Start()
    $script:HotkeyError = [StudioComputerUseHotkey]::GetErrorCode()
} catch { $script:HotkeyRegistered = $false; $script:HotkeyError = -1 }

# ---------- main loop: background stdin reader + preemptive dispatch ----------
$script:Queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
$readerRunspace = [runspacefactory]::CreateRunspace()
$readerRunspace.Open()
$readerPs = [powershell]::Create()
$readerPs.Runspace = $readerRunspace
[void]$readerPs.AddScript({
    param($q)
    try {
        while ($true) {
            $line = [Console]::In.ReadLine()
            $q.Enqueue($line)
            if ($null -eq $line) { break }
        }
    } catch { try { $q.Enqueue($null) } catch { } }
}).AddArgument($script:Queue)
$readerHandle = $readerPs.BeginInvoke()

function Take-NextMessage {
    while ($true) {
        if ($script:Deferred.Count -gt 0) {
            $m = $script:Deferred[0]
            $script:Deferred.RemoveAt(0)
            return $m
        }
        $line = $null
        if ($script:Queue.TryDequeue([ref]$line)) {
            if ($null -eq $line) { $script:Eof = $true; return $null }
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { return ($line | ConvertFrom-Json) } catch { Send-Error $null 'INVALID_PARAMS' 'Malformed JSON line.'; continue }
        }
        if (Test-Stop) {
            if ($script:Eof) { return $null }
            if (-not $script:StopReported) {
                $reason = $script:StopReason
                Release-HeldInputs
                foreach ($sid in @($script:StopIds)) { try { Send-Result $sid @{ stopped = $true; reason = $reason } } catch { } }
                $script:StopIds = @()
                # Latch stays set; the next accepted dispatch resets it.
                Send-Notify 'stopped' @{ reason = $reason; source = 'idle'; stopGeneration = $script:StopGeneration }
                $script:StopReported = $true
            }
            continue
        }
        Start-Sleep -Milliseconds 20
    }
}

try {
    Send-Notify 'ready' @{ pid = $PID; hotkey = $script:HotkeyText; hotkeyRegistered = $script:HotkeyRegistered; hotkeyError = $script:HotkeyError; mutex = $script:OwnsMutex; stopGeneration = $script:StopGeneration }
    while (-not $script:Eof) {
        $msg = Take-NextMessage
        if ($null -eq $msg -and $script:Eof) { break }
        if ($null -eq $msg) { continue }
        if ($null -eq $msg.id -and $msg.method -ne 'stop') {
            Send-Error $null 'INVALID_PARAMS' 'Request needs an id.'
            continue
        }
        Invoke-Request $msg
        if ($script:StopIds.Count -gt 0 -and -not $script:StopRequested) {
            # Stop arrived while a batch already aborted: answer it now.
            foreach ($sid in @($script:StopIds)) { try { Send-Result $sid @{ stopped = $true; reason = $script:StopReason } } catch { } }
            $script:StopIds = @()
        }
        if ($script:Eof) { break }
        if ($script:StopRequested -and -not $script:StopReported) {
            $reason = $script:StopReason
            Release-HeldInputs
            foreach ($sid in @($script:StopIds)) { try { Send-Result $sid @{ stopped = $true; reason = $reason } } catch { } }
            $script:StopIds = @()
            # Latch stays set; the next accepted dispatch resets it.
            Send-Notify 'stopped' @{ reason = $reason; source = 'batch'; stopGeneration = $script:StopGeneration }
            $script:StopReported = $true
        }
    }
} finally {
    try { Release-HeldInputs } catch { }
    try { [StudioComputerUseHotkey]::Stop() } catch { }
    try { if ($null -ne $script:Mutex) { if ($script:OwnsMutex) { $script:Mutex.ReleaseMutex() }; $script:Mutex.Dispose() } } catch { }
    try { $readerPs.Stop() } catch { }
    try { $readerPs.Dispose() } catch { }
    try { $readerRunspace.Close() } catch { }
}
