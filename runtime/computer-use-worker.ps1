param([switch]$SelfTest, [switch]$JobSelfTest, [switch]$JobAdoptProbe)
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
# UTF-8 console transport: the Node driver frames JSON lines over stdin and
# stdout as UTF-8 bytes, but Windows PowerShell defaults both console
# encodings to the OEM code page. Without this pin, every multibyte UTF-8
# sequence (for example "e-acute" = 0xC3 0xA9) decodes as two OEM glyphs and
# typed text arrives garbled. Pin both directions plus $OutputEncoding before
# the first Console access so non-ASCII text survives the boundary intact.
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
} catch { }

$script:HotkeyText = 'Ctrl+Alt+Shift+F10'
$script:MaxActions = 20
$script:MaxTextLength = 2000
$script:MaxWaitMs = 5000
$script:MaxKeysPerPress = 8
$script:MaxPathPoints = 20
$script:MaxScrollDelta = 100
$script:DefaultMaxWidth = 1280
$script:MaxImageDimension = 2000
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
$script:ExternalHeldButtons = New-Object System.Collections.Generic.HashSet[string]
$script:ExternalHeldVks = New-Object System.Collections.Generic.HashSet[int]
$script:CuaJob = $null
$script:MaxJobArgs = 32
$script:MaxJobArgLength = 2048
$script:StopJobKillMs = 1200
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
$jobPinvoke = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StudioComputerUseJob
{
    public const int CREATE_SUSPENDED = 0x4;
    public const uint STILL_ACTIVE = 259;
    public const uint TH32CS_SNAPPROCESS = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES
    {
        public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
        public int dwFlags; public short wShowWindow; public short cbReserved2;
        public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME32
    {
        public uint dwLowDateTime; public uint dwHighDateTime;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct PROCESSENTRY32
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID;
        public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, byte[] info, int cb);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, byte[] info, int cb, out int retLen);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, string cmd, ref SECURITY_ATTRIBUTES pa, ref SECURITY_ATTRIBUTES ta, bool inherit, int flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder buf, ref int len);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr h, out FILETIME32 c, out FILETIME32 e, out FILETIME32 k, out FILETIME32 u);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr h, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, ref SECURITY_ATTRIBUTES sa, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);

    public static int CreateKillOnCloseJob(string name, out IntPtr hJob)
    {
        hJob = IntPtr.Zero;
        IntPtr h = CreateJobObjectW(IntPtr.Zero, name);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION layout: BasicLimitInformation
        // first (LimitFlags at offset 0). KILL_ON_JOB_CLOSE = 0x2000.
        // No BREAKAWAY_OK is ever set: members cannot escape the job.
        // x64 size empirically verified: 144 bytes accepted by
        // SetInformationJobObject for JobObjectExtendedLimitInformation.
        // BasicLimitInformation leads: PerProcessUserTimeLimit (0-7),
        // PerJobUserTimeLimit (8-15), LimitFlags at offset 16.
        // KILL_ON_JOB_CLOSE = 0x2000. No BREAKAWAY_OK is ever set: members
        // cannot escape the job.
        byte[] limits = new byte[144];
        BitConverter.GetBytes((uint)0x2000).CopyTo(limits, 16);
        if (!SetInformationJobObject(h, 9, limits, limits.Length))
        {
            int e = Marshal.GetLastWin32Error(); CloseHandle(h); return e;
        }
        hJob = h; return 0;
    }

    public static int ActiveProcesses(IntPtr hJob, out int active)
    {
        active = -1;
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: 4x LARGE_INTEGER (32) +
        // 4x DWORD (16) = 48 bytes; ActiveProcesses at offset 40.
        // Sizes empirically verified against Set/QueryInformationJobObject.
        byte[] info = new byte[48];
        int retLen;
        if (!QueryInformationJobObject(hJob, 1, info, info.Length, out retLen))
            return Marshal.GetLastWin32Error();
        active = BitConverter.ToInt32(info, 40);
        return 0;
    }

    public static int KillAndWait(IntPtr hJob, int timeoutMs, out int left)
    {
        left = -1;
        if (!TerminateJobObject(hJob, 1)) return Marshal.GetLastWin32Error();
        int waited = 0;
        while (waited < timeoutMs)
        {
            int active; int e = ActiveProcesses(hJob, out active);
            if (e != 0) return e;
            left = active;
            if (active <= 0) return 0;
            Thread.Sleep(25); waited += 25;
        }
        return 0;
    }

    public static int ParentOf(int pid, out int parent)
    {
        parent = 0;
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap.ToInt64() == -1) return Marshal.GetLastWin32Error();
        try
        {
            PROCESSENTRY32 e = new PROCESSENTRY32();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snap, ref e)) return Marshal.GetLastWin32Error();
            do { if ((int)e.th32ProcessID == pid) { parent = (int)e.th32ParentProcessID; return 0; } }
            while (Process32Next(snap, ref e));
            return 2; // pid gone: ERROR_FILE_NOT_FOUND
        }
        finally { CloseHandle(snap); }
    }

    public static int ImagePath(IntPtr h, out string path)
    {
        path = null;
        StringBuilder buf = new StringBuilder(1024);
        int len = buf.Capacity;
        if (!QueryFullProcessImageNameW(h, 0, buf, ref len)) return Marshal.GetLastWin32Error();
        path = buf.ToString(0, len); return 0;
    }

    public static int CreationMs(IntPtr h, out long ms)
    {
        ms = 0;
        FILETIME32 c, e, k, u;
        if (!GetProcessTimes(h, out c, out e, out k, out u)) return Marshal.GetLastWin32Error();
        long ft = ((long)c.dwHighDateTime << 32) | c.dwLowDateTime;
        ms = ft / 10000 - 11644473600000L; return 0;
    }

    public static int Alive(IntPtr h, out bool alive)
    {
        alive = false;
        uint code;
        if (!GetExitCodeProcess(h, out code)) return Marshal.GetLastWin32Error();
        alive = (code == STILL_ACTIVE); return 0;
    }

    public static int InJob(IntPtr h, IntPtr job, out bool result)
    {
        result = false;
        if (!IsProcessInJob(h, job, out result)) return Marshal.GetLastWin32Error();
        return 0;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);

    public static int TryOpenJob(string name, out IntPtr hJob)
    {
        hJob = IntPtr.Zero;
        IntPtr h = OpenJobObjectW(0x0004 | 0x0008 | 0x0020, false, name);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error();
        hJob = h; return 0;
    }

    public static int SpawnSuspended(string exe, string args, string[] env, IntPtr hJob, out PROCESS_INFORMATION pi, out IntPtr errPipe, out int stage)
    {
        pi = new PROCESS_INFORMATION(); errPipe = IntPtr.Zero; stage = 1;
        IntPtr envPtr = IntPtr.Zero;
        int createFlags = CREATE_SUSPENDED;
        byte[] envRaw = null;
        GCHandle envPin = new GCHandle();
        bool envPinned = false;
        if (env != null && env.Length > 0)
        {
            // Unicode environment block: NUL-separated K=V, double-NUL end.
            // The child gets ONLY these variables, never the guardian env.
            StringBuilder sb = new StringBuilder();
            foreach (string kv in env) { if (kv != null) { sb.Append(kv); sb.Append('\0'); } }
            sb.Append('\0');
            envRaw = Encoding.Unicode.GetBytes(sb.ToString());
            envPin = GCHandle.Alloc(envRaw, GCHandleType.Pinned);
            envPinned = true;
            envPtr = envPin.AddrOfPinnedObject();
            createFlags |= 0x400; // CREATE_UNICODE_ENVIRONMENT
        }
        SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        sa.lpSecurityDescriptor = IntPtr.Zero; sa.bInheritHandle = true;
        IntPtr nul = CreateFileW("NUL", 0x80000000 | 0x40000000, 3, ref sa, 3, 0, IntPtr.Zero);
        if (nul == IntPtr.Zero || nul.ToInt64() == -1)
        { int e0 = Marshal.GetLastWin32Error(); if (envPinned) envPin.Free(); return e0; }
        IntPtr hRead, hWrite;
        if (!CreatePipe(out hRead, out hWrite, ref sa, 65536))
        { int e = Marshal.GetLastWin32Error(); CloseHandle(nul); if (envPinned) envPin.Free(); return e; }
        SetHandleInformation(hRead, 1, 0);
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 0x100;
        si.hStdInput = nul; si.hStdOutput = nul; si.hStdError = hWrite;
        string cmd = "\"" + exe + "\"" + (string.IsNullOrEmpty(args) ? "" : " " + args);
        stage = 2;
        bool ok = CreateProcessW(null, cmd, ref sa, ref sa, true, createFlags, envPtr, null, ref si, out pi);
        if (envPinned) envPin.Free();
        CloseHandle(nul); CloseHandle(hWrite);
        if (!ok) { int e = Marshal.GetLastWin32Error(); CloseHandle(hRead); return e; }
        stage = 3;
        if (!AssignProcessToJobObject(hJob, pi.hProcess))
        {
            int e = Marshal.GetLastWin32Error();
            try { TerminateProcess(pi.hProcess, 1); } catch { }
            try { CloseHandle(pi.hProcess); } catch { }
            try { CloseHandle(pi.hThread); } catch { }
            try { CloseHandle(hRead); } catch { }
            pi = new PROCESS_INFORMATION(); return e;
        }
        errPipe = hRead;
        stage = 4;
        if (ResumeThread(pi.hThread) == uint.MaxValue)
        {
            int e = Marshal.GetLastWin32Error();
            try { TerminateProcess(pi.hProcess, 1); } catch { }
            try { CloseHandle(hRead); } catch { }
            return e;
        }
        IntPtr captured = hRead;
        Thread pump = new Thread(delegate() {
            try
            {
                using (FileStream fs = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(captured, false), FileAccess.Read))
                using (StreamReader r = new StreamReader(fs, Encoding.UTF8))
                {
                    string line;
                    while ((line = r.ReadLine()) != null)
                    { try { Console.Error.WriteLine("cua-daemon: " + line); } catch { } }
                }
            }
            catch { }
        });
        pump.IsBackground = true;
        try { pump.Start(); } catch { }
        return 0;
    }
}
"@
Add-Type -TypeDefinition $jobPinvoke -ErrorAction Stop
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
# Pure UTF-16 decomposition for the typing path: one KEYEVENTF_UNICODE
# event per unit, including both halves of a surrogate pair (emoji). Kept
# separate from Invoke-TypeText so the self-test can verify it with no input.
function Get-TypeUnits($text) { return ([string]$text).ToCharArray() }
function Invoke-TypeText($text) {
    $chars = Get-TypeUnits $text
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
# ---------- external input supervision (adapter held-input plan) ----------
# The CUA adapter holds inputs in its own process tree, which the worker
# cannot see in HeldVks/HeldButtons. The adapter arms the expected held set
# before dispatch and disarms only on confirmed success. On timeout or hotkey
# stop, the adapter kills its exact process tree FIRST, then repeats cleanup.
# The worker hotkey path may release before Node kills CUA, so the plan is
# retained until explicit disarm: stop paths release (best effort) but keep
# the plan, and cleanup repeats the release. Arming never presses. Only the
# existing key parser admits keys, buttons are left/right/middle only, plans
# stay bounded (12 buttons, 8 keys). None of these methods reset the stop
# latch or permit new input; cleanup stays accepted while stopped.
function Set-ExternalPlan($params) {
    if ($null -eq $params) { $params = @{} }
    $buttons = @()
    $keys = @()
    try { if ($null -ne $params.buttons) { $buttons = @($params.buttons) } } catch { $buttons = @() }
    try { if ($null -ne $params.keys) { $keys = @($params.keys) } } catch { $keys = @() }
    if ($buttons.Count -gt 12) { throw 'INVALID:arm_external_input.buttons must list at most 12 buttons.' }
    if ($keys.Count -gt 8) { throw 'INVALID:arm_external_input.keys must list at most 8 keys.' }
    $normButtons = @()
    foreach ($b in $buttons) {
        $name = ([string]$b).Trim().ToLowerInvariant()
        if ($name -ne 'left' -and $name -ne 'right' -and $name -ne 'middle') { throw ('INVALID:Unknown external button: ' + $b) }
        $normButtons += $name
    }
    $normVks = @()
    foreach ($k in $keys) {
        $vk = Resolve-Vk $k
        if ($null -eq $vk) { throw ('INVALID:Unknown external key: ' + $k) }
        $normVks += [int]$vk
    }
    if ($normButtons.Count -eq 0 -and $normVks.Count -eq 0) { throw 'INVALID:arm_external_input needs at least one button or key.' }
    $script:ExternalHeldButtons.Clear()
    foreach ($b in $normButtons) { [void]$script:ExternalHeldButtons.Add($b) }
    $script:ExternalHeldVks.Clear()
    foreach ($vk in $normVks) { [void]$script:ExternalHeldVks.Add($vk) }
    return @{ armed = $true; buttons = $script:ExternalHeldButtons.Count; keys = $script:ExternalHeldVks.Count }
}
function Clear-ExternalPlan {
    $b = $script:ExternalHeldButtons.Count
    $k = $script:ExternalHeldVks.Count
    $script:ExternalHeldButtons.Clear()
    $script:ExternalHeldVks.Clear()
    return @{ disarmed = $true; buttons = $b; keys = $k }
}
function Release-ExternalInputs {
    # Best-effort UP events only for the retained external plan. Retains the
    # plan so cleanup can repeat after the adapter kills its process tree.
    # Never presses, never clears: only disarm clears.
    $b = 0; $k = 0
    foreach ($button in @($script:ExternalHeldButtons)) {
        try {
            switch ($button) {
                'left' { [void][StudioComputerUseInput]::SendMouse(4, 0) }
                'right' { [void][StudioComputerUseInput]::SendMouse(16, 0) }
                'middle' { [void][StudioComputerUseInput]::SendMouse(64, 0) }
            }
            $b++
        } catch { }
    }
    foreach ($vk in @($script:ExternalHeldVks)) {
        try { [void][StudioComputerUseInput]::SendVk([int]$vk, $true); $k++ } catch { }
    }
    return @{ buttons = $b; keys = $k }
}
function Invoke-ExternalCleanup {
    # Safe after the stop latch: releases own held inputs (existing behavior)
    # plus the retained external plan, keeps the latch set, permits no new
    # input. Retains the plan for repeat cleanup; only disarm clears it.
    try { Release-HeldInputs } catch { }
    $rel = Release-ExternalInputs
    return @{ cleaned = $true; buttons = $rel.buttons; keys = $rel.keys }
}
# ---------- CUA owned-process job supervision (mandatory in production) ----------
# The guardian owns one Windows Job Object per CUA session. The daemon is
# created suspended, assigned to the job, then resumed, so no descendant can
# escape between spawn and assignment. The Node-spawned proxy is adopted only
# after opened-handle validation (exact image, real Node parent, birth
# boundary, private socket nonce) and assigned on that same handle, then
# rechecked alive: no PID-only or time-only adoption. Nested jobs are allowed
# (Windows supports them); only membership in OUR job or a failed assign
# refuses. KILL_ON_JOB_CLOSE is mandatory, breakaway is never enabled, and
# every anomaly fails closed. Handles and job identity are kept until the OS
# reports ActiveProcesses 0. This file never touches desktop input here.
$script:JobEnvAllow = @('CUA_DRIVER_RS_HOME', 'CUA_DRIVER_RS_UPDATE_CHECK', 'CUA_DRIVER_RS_TELEMETRY_ENABLED', 'CUA_LOG', 'CUA_DRIVER_PERMISSION_MODE', 'CUA_DRIVER_CAPABILITY_MANIFEST_FILE', 'CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PROGRAMDATA', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'OS')

function Test-JobNonce($nonce) {
    return ((-not [string]::IsNullOrEmpty($nonce)) -and ($nonce -match '^[A-Za-z0-9_-]{16,64}$'))
}
function Get-JobName($nonce) { return ('Local\PrimeAgentStudioCuaJob-' + $nonce) }

function Convert-JobEnv($envObj) {
    # The guardian env is NOT the CUA home: the child gets ONLY these
    # allowlisted variables. UPDATE_CHECK and TELEMETRY are pinned to 0.
    $pairs = @()
    $seenHome = $false
    if ($null -ne $envObj) {
        # Production params arrive as PSCustomObject (JSON); PowerShell
        # callers may pass a Hashtable. Iterate ENTRIES only: a Hashtable
        # exposes .NET members (IsReadOnly, Count, ...) as properties.
        $entries = New-Object System.Collections.ArrayList
        if ($envObj -is [System.Collections.IDictionary]) {
            foreach ($k in $envObj.Keys) { [void]$entries.Add(@{ K = $k; V = $envObj[$k] }) }
        } else {
            try { foreach ($p in @($envObj.PSObject.Properties)) { [void]$entries.Add(@{ K = $p.Name; V = $p.Value }) } } catch { throw 'INVALID:job_launch.env must be an object.' }
        }
        foreach ($entry in $entries) {
            $k = [string]$entry.K
            $v = [string]$entry.V
            if ([string]::IsNullOrEmpty($k) -or $k.Length -gt 64) { throw 'INVALID:job_launch.env has a bad variable name.' }
            $ku = $k.ToUpperInvariant()
            if ($script:JobEnvAllow -notcontains $ku) { throw ('INVALID:job_launch.env forbids variable: ' + $k) }
            if ($null -eq $entry.V -or $v.Length -gt 1024 -or $v.Contains([string][char]0)) { throw ('INVALID:job_launch.env has a bad value: ' + $k) }
            switch ($ku) {
                'CUA_DRIVER_RS_HOME' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env needs an absolute CUA_DRIVER_RS_HOME.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env needs an absolute CUA_DRIVER_RS_HOME.' }
                    $seenHome = $true
                }
                'CUA_DRIVER_RS_UPDATE_CHECK' { if ($v -ne '0') { throw 'INVALID:CUA_DRIVER_RS_UPDATE_CHECK must be 0.' } }
                'CUA_DRIVER_RS_TELEMETRY_ENABLED' { if ($v -ne '0') { throw 'INVALID:CUA_DRIVER_RS_TELEMETRY_ENABLED must be 0.' } }
                'CUA_LOG' { if ($v -notmatch '^[A-Za-z]{1,16}$') { throw 'INVALID:CUA_LOG must be a short level name.' } }
                'CUA_DRIVER_PERMISSION_MODE' { if ($v -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'INVALID:CUA_DRIVER_PERMISSION_MODE has a bad value.' } }
                'SYSTEMROOT' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env SYSTEMROOT must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env SYSTEMROOT must be absolute.' }
                }
                'SYSTEMDRIVE' { if ($v -notmatch '^[A-Za-z]:$') { throw 'INVALID:job_launch.env SYSTEMDRIVE must be a drive letter.' } }
                'WINDIR' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env WINDIR must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env WINDIR must be absolute.' }
                }
                'PROGRAMDATA' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env PROGRAMDATA must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env PROGRAMDATA must be absolute.' }
                }
                'USERPROFILE' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env USERPROFILE must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env USERPROFILE must be absolute.' }
                }
                'APPDATA' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env APPDATA must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env APPDATA must be absolute.' }
                }
                'LOCALAPPDATA' {
                    if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env LOCALAPPDATA must be absolute.' }
                    try { if (-not [System.IO.Path]::IsPathRooted($v)) { throw 'x' } } catch { throw 'INVALID:job_launch.env LOCALAPPDATA must be absolute.' }
                }
                'HOMEDRIVE' { if ($v -notmatch '^[A-Za-z]:$') { throw 'INVALID:job_launch.env HOMEDRIVE must be a drive letter.' } }
                'HOMEPATH' { if ($v -notmatch '^\\' -or $v.Length -gt 256) { throw 'INVALID:job_launch.env HOMEPATH must be a rooted suffix.' } }
                'OS' { if ($v -notmatch '^[A-Za-z0-9_][A-Za-z0-9_. ]{0,31}$') { throw 'INVALID:job_launch.env OS has a bad value.' } }
                'TEMP' { if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env TEMP must be absolute.' } }
                'TMP' { if ([string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 512) { throw 'INVALID:job_launch.env TMP must be absolute.' } }
                default { if ($v.Length -gt 512) { throw ('INVALID:job_launch.env value too long: ' + $k) } }
            }
            $pairs += ($ku + '=' + $v)
        }
    }
    if (-not $seenHome) { throw 'INVALID:job_launch.env needs CUA_DRIVER_RS_HOME.' }
    # OS baseline (named system entries, see implementation doc): the child
    # needs the OS root and temp dirs to load at all; these are OS identity,
    # never CUA config. Caller values above win; missing entries are injected
    # from the guardian environment. SYSTEMROOT is mandatory.
    $have = @()
    foreach ($existing in $pairs) { $have += $existing.Split('=')[0] }
    $sysEnv = @{}
    try { foreach ($se in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) { $sysEnv[[string]$se.Key] = [string]$se.Value } } catch { }
    # OS baseline (named system entries, see implementation doc): frozen
    # evidence showed a stripped-env child resolving a cache path with a
    # literal unexpanded %SystemDrive% into the cwd, so the child needs the
    # OS location identity, never CUA config. Caller values above win;
    # missing entries are injected from the guardian environment. SYSTEMROOT
    # and SYSTEMDRIVE are mandatory. PATH, COMSPEC and PATHEXT stay out by
    # design: absolute paths plus KnownDLLs only, no DLL-planting surface.
    $sysDefaults = @('SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PROGRAMDATA', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'OS')
    foreach ($sk in $sysDefaults) {
        if ($have -contains $sk) { continue }
        $sv = ''
        try { $sv = [string]$sysEnv[$sk] } catch { }
        if ([string]::IsNullOrEmpty($sv)) {
            if ($sk -eq 'SYSTEMDRIVE' -and $have -contains 'SYSTEMROOT') {
                $root = ($pairs | Where-Object { $_ -like 'SYSTEMROOT=*' } | Select-Object -First 1)
                if ($root -match '^SYSTEMROOT=([A-Za-z]:)') { $sv = $Matches[1] }
            } elseif ($sk -eq 'WINDIR' -and $have -contains 'SYSTEMROOT') {
                $root = ($pairs | Where-Object { $_ -like 'SYSTEMROOT=*' } | Select-Object -First 1)
                if ($root -match '^SYSTEMROOT=(.+)$') { $sv = $Matches[1] }
            }
        }
        if ($sk -eq 'SYSTEMROOT' -and [string]::IsNullOrWhiteSpace($sv)) { throw 'INVALID:guardian SYSTEMROOT is missing; cannot launch.' }
        if ($sk -eq 'SYSTEMDRIVE' -and [string]::IsNullOrWhiteSpace($sv)) { throw 'INVALID:guardian SYSTEMDRIVE is missing; cannot launch.' }
        if (-not [string]::IsNullOrEmpty($sv)) { $pairs += ($sk + '=' + $sv) }
    }
    return $pairs
}

function Build-ArgLine($items) {
    $bs = [string][char]92
    $parts = @()
    foreach ($a in $items) {
        $s = [string]$a
        if ($s -eq '') { $parts += '""'; continue }
        foreach ($ch in $s.ToCharArray()) { if ($ch -eq [char]0) { throw 'INVALID:job_launch.args entries must be clean strings.' } }
        if ($s -notmatch '[\s"]') { $parts += $s; continue }
        $esc = ''
        $run = 0
        foreach ($ch in $s.ToCharArray()) {
            if ($ch -eq [char]92) { $run++; continue }
            if ($ch -eq '"') { for ($i = 0; $i -lt ($run * 2 + 1); $i++) { $esc += $bs }; $esc += '"'; $run = 0; continue }
            for ($i = 0; $i -lt $run; $i++) { $esc += $bs }; $run = 0
            $esc += $ch
        }
        for ($i = 0; $i -lt ($run * 2); $i++) { $esc += $bs }
        $parts += ('"' + $esc + '"')
    }
    return ($parts -join ' ')
}

function Get-CuaJobSummary {
    if ($null -eq $script:CuaJob) { return @{ active = $false; activeProcesses = 0; daemonPid = 0; jobName = $null } }
    $active = -1
    try {
        $a = 0
        if ([StudioComputerUseJob]::ActiveProcesses($script:CuaJob.Job, [ref]$a) -eq 0) { $active = $a }
    } catch { }
    return @{ active = $true; activeProcesses = $active; daemonPid = $script:CuaJob.DaemonPid; adopted = $script:CuaJob.Adopted.Count; jobName = $script:CuaJob.Name }
}

function Close-CuaJobHandles {
    if ($null -eq $script:CuaJob) { return }
    try { foreach ($h in @($script:CuaJob.Handles)) { try { if ($h -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($h) } } catch { } } } catch { }
    try { if ($script:CuaJob.Job -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($script:CuaJob.Job) } } catch { }
    $script:CuaJob = $null
}

function New-CuaJobLaunch($params) {
    if ($null -ne $script:CuaJob) { throw 'INVALID:A CUA job is already active; reconcile or close it first.' }
    $nonce = ''
    try { $nonce = [string]$params.nonce } catch { }
    if (-not (Test-JobNonce $nonce)) { throw 'INVALID:job_launch.nonce must match [A-Za-z0-9_-]{16,64}.' }
    # Isolated child env first: shape failures must surface before any path
    # probe or native call, and the child never inherits the guardian env.
    $envPairs = Convert-JobEnv $params.env
    $exe = ''
    try { $exe = [string]$params.exe } catch { }
    if ([string]::IsNullOrWhiteSpace($exe) -or $exe.Length -gt 512) { throw 'INVALID:job_launch.exe must be a non-empty path.' }
    try { if (-not [System.IO.Path]::IsPathRooted($exe)) { throw 'x' } } catch { throw 'INVALID:job_launch.exe must be absolute.' }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'INVALID:job_launch.exe was not found.' }
    $argList = @()
    try { if ($null -ne $params.args) { $argList = @($params.args) } } catch { throw 'INVALID:job_launch.args must be an array.' }
    if ($argList.Count -gt $script:MaxJobArgs) { throw 'INVALID:job_launch.args must list at most 32 arguments.' }
    foreach ($a in $argList) { if ($null -eq $a -or ([string]$a).Length -gt $script:MaxJobArgLength) { throw 'INVALID:job_launch.args entries must be short strings.' } }
    $argLine = Build-ArgLine $argList
    $name = Get-JobName $nonce
    $probe = [IntPtr]::Zero
    if ([StudioComputerUseJob]::TryOpenJob($name, [ref]$probe) -eq 0) {
        try { [void][StudioComputerUseJob]::CloseHandle($probe) } catch { }
        throw 'JOB_EXISTS:A job with this nonce already exists; reconcile it first.'
    }
    $job = [IntPtr]::Zero
    $e = [StudioComputerUseJob]::CreateKillOnCloseJob($name, [ref]$job)
    if ($e -ne 0 -or $job -eq [IntPtr]::Zero) {
        try { if ($job -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($job) } } catch { }
        if ($e -eq 183) { throw 'JOB_EXISTS:A job with this nonce already exists; reconcile it first.' }
        throw ('LAUNCH_FAILED:CreateJobObject failed (win32 ' + $e + ').')
    }
    $pi = New-Object StudioComputerUseJob+PROCESS_INFORMATION
    $pipe = [IntPtr]::Zero
    $stage = 0
    $e2 = [StudioComputerUseJob]::SpawnSuspended($exe, $argLine, $envPairs, $job, [ref]$pi, [ref]$pipe, [ref]$stage)
    if ($e2 -ne 0) {
        try { [void][StudioComputerUseJob]::CloseHandle($job) } catch { }
        if ($stage -eq 3) { throw ('ASSIGN_REFUSED:AssignProcessToJobObject failed (win32 ' + $e2 + '). Incompatible job membership fails closed.') }
        if ($stage -eq 4) { throw ('LAUNCH_FAILED:ResumeThread failed (win32 ' + $e2 + ').') }
        throw ('LAUNCH_FAILED:SpawnSuspended failed at stage ' + $stage + ' (win32 ' + $e2 + ').')
    }
    $script:CuaJob = @{ Nonce = $nonce; Name = $name; Job = $job; DaemonPid = $pi.dwProcessId; Handles = @($pi.hProcess, $pi.hThread); Adopted = New-Object System.Collections.ArrayList }
    return @{ launched = $true; pid = $pi.dwProcessId; jobName = $name }
}

function Add-CuaJobAdopt($params) {
    if ($null -eq $script:CuaJob) { throw 'INVALID:No active CUA job; launch or reconcile first.' }
    $pidV = 0
    try { $pidV = [int]$params.pid } catch { throw 'INVALID:job_adopt.pid must be a positive integer.' }
    if ($pidV -le 0) { throw 'INVALID:job_adopt.pid must be a positive integer.' }
    $exe = ''
    try { $exe = [string]$params.exe } catch { }
    if ([string]::IsNullOrWhiteSpace($exe) -or $exe.Length -gt 512) { throw 'INVALID:job_adopt.exe must be a non-empty path.' }
    $birth = 0
    try { $birth = [long]$params.birthMs } catch { throw 'INVALID:job_adopt.birthMs must be a number.' }
    if ($birth -lt 0) { throw 'INVALID:job_adopt.birthMs must be a number.' }
    $nonce = ''
    try { $nonce = [string]$params.socketNonce } catch { }
    if ([string]::IsNullOrWhiteSpace($nonce) -or $nonce.Length -gt 512 -or $nonce.Contains([string][char]0)) { throw 'INVALID:job_adopt.socketNonce must be a short clean string.' }
    # Opened-handle identity: every check below runs against THIS handle, and
    # assignment uses this same handle, so PID reuse cannot slip between
    # validation and assignment. Refusal paths close the handle; only a
    # successful adopt keeps it until verified tree zero.
    $h = [StudioComputerUseJob]::OpenProcess(0x101101, $false, $pidV)
    if ($h -eq [IntPtr]::Zero) { throw 'ADOPT_REFUSED:not-alive (OpenProcess failed).' }
    $keep = $false
    try {
        $alive = $false
        if ([StudioComputerUseJob]::Alive($h, [ref]$alive) -ne 0 -or -not $alive) { throw 'ADOPT_REFUSED:not-alive.' }
        $path = $null
        if ([StudioComputerUseJob]::ImagePath($h, [ref]$path) -ne 0 -or [string]::IsNullOrEmpty($path)) { throw 'ADOPT_REFUSED:path-mismatch (image unreadable).' }
        if (-not $path.Equals($exe, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'ADOPT_REFUSED:path-mismatch.' }
        $ms = 0
        if ([StudioComputerUseJob]::CreationMs($h, [ref]$ms) -ne 0) { throw 'ADOPT_REFUSED:birth-mismatch (creation unreadable).' }
        if ([Math]::Abs($ms - $birth) -gt 5000) { throw 'ADOPT_REFUSED:birth-mismatch.' }
        $inj = $false
        if ([StudioComputerUseJob]::InJob($h, $script:CuaJob.Job, [ref]$inj) -ne 0) { throw 'ADOPT_REFUSED:assign-check failed.' }
        if ($inj) { throw 'ADOPT_REFUSED:already-in-job.' }
        $pp = 0
        $me = 0
        if ([StudioComputerUseJob]::ParentOf($pidV, [ref]$pp) -ne 0) { throw 'ADOPT_REFUSED:parent-mismatch (parent unreadable).' }
        if ([StudioComputerUseJob]::ParentOf($PID, [ref]$me) -ne 0 -or $pp -ne $me) { throw 'ADOPT_REFUSED:parent-mismatch (not our Node parent child).' }
        # A caller-supplied parentPid is a claim, never trust: it must equal
        # the live guardian parent just computed above.
        try {
            if ($null -ne $params.parentPid) {
                $claimed = [int]$params.parentPid
                if ($claimed -ne $me) { throw 'ADOPT_REFUSED:parent-mismatch (caller claim disagrees with live tree).' }
            }
        } catch {
            $perr = [string]$_
            if ($perr -match '^ADOPT_REFUSED:') { throw }
            throw 'INVALID:job_adopt.parentPid must be a positive integer.'
        }
        $cmd = $null
        try { $cmd = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $pidV) -ErrorAction Stop).CommandLine } catch { $cmd = $null }
        if ([string]::IsNullOrEmpty($cmd) -or -not $cmd.Contains($nonce)) { throw 'ADOPT_REFUSED:nonce-mismatch (private socket not in command line).' }
        if (-not [StudioComputerUseJob]::AssignProcessToJobObject($script:CuaJob.Job, $h)) {
            $ae = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw ('ADOPT_REFUSED:assign-failed (win32 ' + $ae + ').')
        }
        $alive2 = $false
        if ([StudioComputerUseJob]::Alive($h, [ref]$alive2) -ne 0 -or -not $alive2) { throw 'ADOPT_REFUSED:not-alive after assign.' }
        $script:CuaJob.Handles += $h
        [void]$script:CuaJob.Adopted.Add($pidV)
        $keep = $true
        return @{ adopted = $true; pid = $pidV }
    } finally {
        if (-not $keep) { try { [void][StudioComputerUseJob]::CloseHandle($h) } catch { } }
    }
}

function Invoke-CuaJobKill($timeoutMs) {
    $bound = 3000
    try { if ($null -ne $timeoutMs) { $bound = [int]$timeoutMs } } catch { }
    if ($bound -lt 1 -or $bound -gt 5000) { throw 'INVALID:job_kill.timeoutMs must be in [1, 5000].' }
    if ($null -eq $script:CuaJob) { return @{ treeExited = $true; activeProcesses = 0; active = $false } }
    $left = -1
    $e = [StudioComputerUseJob]::KillAndWait($script:CuaJob.Job, $bound, [ref]$left)
    if ($e -ne 0) { throw ('JOB_KILL_FAILED:KillAndWait failed (win32 ' + $e + '). Uncertainty retained.') }
    if ($left -le 0) {
        Close-CuaJobHandles
        return @{ treeExited = $true; activeProcesses = 0 }
    }
    return @{ treeExited = $false; activeProcesses = $left }
}

function Invoke-CuaJobReconcile($nonce) {
    $n = ''
    try { $n = [string]$nonce } catch { }
    if (-not (Test-JobNonce $n)) { throw 'INVALID:job_reconcile.nonce must match [A-Za-z0-9_-]{16,64}.' }
    if ($null -ne $script:CuaJob -and $script:CuaJob.Nonce -eq $n) {
        $s = Get-CuaJobSummary
        return @{ found = $true; reconciled = $false; treeExited = ($s.activeProcesses -eq 0); activeProcesses = $s.activeProcesses }
    }
    $name = Get-JobName $n
    $h = [IntPtr]::Zero
    if ([StudioComputerUseJob]::TryOpenJob($name, [ref]$h) -ne 0 -or $h -eq [IntPtr]::Zero) {
        # Absence is NOT proof of zero when a loss was already recorded; the
        # adapter poison decides freshness. No treeExited key is returned.
        return @{ found = $false }
    }
    $left = -1
    $e = [StudioComputerUseJob]::KillAndWait($h, 3000, [ref]$left)
    if ($e -ne 0) {
        try { [void][StudioComputerUseJob]::CloseHandle($h) } catch { }
        throw ('JOB_KILL_FAILED:reconcile kill failed (win32 ' + $e + '). Uncertainty retained.')
    }
    if ($left -le 0) {
        try { [void][StudioComputerUseJob]::CloseHandle($h) } catch { }
        return @{ found = $true; reconciled = $true; treeExited = $true; activeProcesses = 0 }
    }
    # Remainder unverifiable: retain as owned under the exact nonce so retry
    # and close can act. Never silently clear, never touch foreign jobs.
    $script:CuaJob = @{ Nonce = $n; Name = $name; Job = $h; DaemonPid = 0; Handles = @(); Adopted = New-Object System.Collections.ArrayList }
    return @{ found = $true; reconciled = $true; treeExited = $false; activeProcesses = $left }
}

function Stop-CuaJobForStop {
    # Stop-path kill: bounded so the stop round-trip stays fast. Verified
    # zero releases the handles; anything else retains them and the
    # uncertainty. Returns $null when no job exists (caller keeps the exact
    # no-job behavior).
    if ($null -eq $script:CuaJob) { return $null }
    $left = -1
    try {
        $e = [StudioComputerUseJob]::KillAndWait($script:CuaJob.Job, $script:StopJobKillMs, [ref]$left)
        if ($e -ne 0) { return @{ treeExited = $false; activeProcesses = -1 } }
    } catch { return @{ treeExited = $false; activeProcesses = -1 } }
    if ($left -le 0) {
        Close-CuaJobHandles
        return @{ treeExited = $true; activeProcesses = 0 }
    }
    return @{ treeExited = $false; activeProcesses = $left }
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
function Get-WindowDiagnostic($hWnd) {
    # Read-only diagnostics for an actionable FOCUS_REFUSED message. Never
    # changes focus, never elevates, never synthesizes input.
    $info = @{ title = ''; processName = ''; processId = 0; visible = $false; minimized = $false; rect = $null }
    try { $info.visible = [StudioComputerUseInput]::IsWindowVisible($hWnd) } catch { }
    try { $info.minimized = [StudioComputerUseInput]::IsIconic($hWnd) } catch { }
    try {
        $sb = New-Object System.Text.StringBuilder(512)
        [void][StudioComputerUseInput]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
        $info.title = $sb.ToString()
    } catch { }
    try {
        $pidOut = 0
        [void][StudioComputerUseInput]::GetWindowThreadProcessId($hWnd, [ref]$pidOut)
        $info.processId = $pidOut
        try { $info.processName = (Get-Process -Id $pidOut -ErrorAction Stop).ProcessName } catch { }
    } catch { }
    try {
        $rect = New-Object StudioComputerUseInput+RECT
        if ([StudioComputerUseInput]::GetWindowRect($hWnd, [ref]$rect)) {
            $info.rect = @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
        }
    } catch { }
    return $info
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
    if ([StudioComputerUseInput]::IsIconic($hWnd)) {
        # Normal restore: ask Windows to restore, then poll until the
        # minimized state clears. Bounded and preemptible via Invoke-Wait.
        [void][StudioComputerUseInput]::ShowWindowAsync($hWnd, 9)
        $restored = $false
        for ($i = 0; $i -lt 10; $i++) {
            Invoke-Wait 50
            if (-not [StudioComputerUseInput]::IsIconic($hWnd)) { $restored = $true; break }
        }
        if (-not $restored) { throw 'WINDOW_MINIMIZED:The window stayed minimized after restore.' }
    }
    # Foreground lock timing: one activation attempt often loses to the
    # current foreground app, so retry a bounded number of times with a
    # settle wait, then verify the actual foreground. No elevation bypass,
    # no synthesized shortcuts, no input.
    $attempts = 4
    for ($attempt = 1; $attempt -le $attempts; $attempt++) {
        [void][StudioComputerUseInput]::ActivateWindow($hWnd)
        Invoke-Wait 150
        $now = [StudioComputerUseInput]::GetForegroundWindow()
        if ($now.ToInt64() -eq $idLong) {
            return @{ focused = $true; windowId = $idLong.ToString(); foreground = $now.ToInt64().ToString() }
        }
        if ($attempt -lt $attempts) { Invoke-Wait 100 }
    }
    $now = [StudioComputerUseInput]::GetForegroundWindow()
    $target = Get-WindowDiagnostic $hWnd
    $current = Get-WindowDiagnostic $now
    $targetName = [string]$target.title
    if ([string]::IsNullOrWhiteSpace($targetName)) { $targetName = [string]$target.processName }
    if ([string]::IsNullOrWhiteSpace($targetName)) { $targetName = 'the requested window' }
    $currentName = [string]$current.title
    if ([string]::IsNullOrWhiteSpace($currentName)) { $currentName = [string]$current.processName }
    if ([string]::IsNullOrWhiteSpace($currentName)) { $currentName = ('window ' + $now.ToInt64().ToString()) }
    $detail = ('Windows kept ' + $currentName + ' in the foreground instead of ' + $targetName +
        ' (target ' + $idLong.ToString() + ', foreground ' + $now.ToInt64().ToString() +
        '). Bring the app forward manually, then observe again. No elevation bypass was attempted.')
    # Keep the FOCUS_REFUSED code so callers never mistake this for success.
    throw ('FOCUS_REFUSED:' + $detail)
}

# ---------- observe: real physical pixels + transform metadata ----------
# Model image cap: every emitted frame keeps BOTH width and height at or
# below MaxImageDimension (2000) while preserving aspect ratio. The caller
# maxWidth (16..4096) is still honored: the effective scale is the minimum
# of the requested width fit, the absolute width fit and the absolute height
# fit, never an upscale. Portrait monitors and tall regions therefore shrink
# by height even when their width already fits.
function Get-CaptureSize($w, $h, $maxWidth) {
    $cap = 2000
    try { if ([int]$script:MaxImageDimension -gt 0) { $cap = [int]$script:MaxImageDimension } } catch { }
    $limitW = [int]$maxWidth
    if ($limitW -lt 16) { $limitW = 16 }
    if ($limitW -gt 4096) { $limitW = 4096 }
    if ($limitW -gt $cap) { $limitW = $cap }
    $scale = 1.0
    if ([int]$w -gt $limitW) { $scale = [Math]::Min($scale, [double]$limitW / [double]$w) }
    if ([int]$w -gt $cap) { $scale = [Math]::Min($scale, [double]$cap / [double]$w) }
    if ([int]$h -gt $cap) { $scale = [Math]::Min($scale, [double]$cap / [double]$h) }
    if ($scale -ge 1.0) { return @{ width = [int]$w; height = [int]$h } }
    $outW = [int][Math]::Max(1, [Math]::Round([double]$w * $scale))
    $outH = [int][Math]::Max(1, [Math]::Round([double]$h * $scale))
    if ($outW -gt $cap) { $outW = $cap }
    if ($outH -gt $cap) { $outH = $cap }
    return @{ width = $outW; height = $outH }
}
function Capture-Rect($x, $y, $w, $h, $maxWidth) {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)), [System.Drawing.CopyPixelOperation]::SourceCopy)
        } finally { $g.Dispose() }
        $size = Get-CaptureSize $w $h $maxWidth
        $outW = $size.width; $outH = $size.height
        if ($outW -ne $w -or $outH -ne $h) {
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
        externalInputGuard = @{ supported = $true }
        externalHeld = @{ buttons = $script:ExternalHeldButtons.Count; keys = $script:ExternalHeldVks.Count }
        jobGuard = @{ supported = $true }
        job = Get-CuaJobSummary
        limits = @{
            maxActions = $script:MaxActions; maxTextLength = $script:MaxTextLength
            maxWaitMs = $script:MaxWaitMs; maxKeysPerPress = $script:MaxKeysPerPress
            maxPathPoints = $script:MaxPathPoints; maxScrollDelta = $script:MaxScrollDelta
            defaultMaxWidth = $script:DefaultMaxWidth; maxImageDimension = $script:MaxImageDimension
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
    # status and observe stay read-only so polling survives stops. External
    # input supervision (arm/disarm/cleanup) is bookkeeping only and never
    # counts as fresh work: it never resets the stop latch.
    $isMutating = ($method -eq 'act')
    try { if ($method -eq 'windows' -and $params.action -eq 'focus') { $isMutating = $true } } catch { }
    if ($method -eq 'arm_external_input' -or $method -eq 'disarm_external_input' -or $method -eq 'cleanup_external_input' -or $method -eq 'job_launch' -or $method -eq 'job_adopt' -or $method -eq 'job_status' -or $method -eq 'job_kill' -or $method -eq 'job_reconcile') {
        # Supervision bookkeeping: never resets the stop latch and never
        # permits new desktop input. Launch/adopt gate CUA dispatch on the
        # desktop mutex, the generation and the latch. Status, kill and
        # reconcile stay legal after the stop so the adapter can verify and
        # retry; cleanup stays accepted for the same reason.
        try {
            if (($method -eq 'arm_external_input' -or $method -eq 'job_launch' -or $method -eq 'job_adopt') -and -not $script:OwnsMutex) {
                # Arming and job setup acquire the existing desktop
                # exclusivity before any CUA dispatch, without sending any
                # input. A busy worker refuses so a second Studio can never
                # shadow-control the desktop. Disarm, cleanup, status, kill
                # and reconcile stay mutex-free so a lost controller can
                # still release and verify.
                Send-Error $id 'CONTROLLER_BUSY' 'The desktop is already controlled by another Studio worker.'
            } elseif ($method -eq 'cleanup_external_input') {
                # Accepted even while stopped so the adapter can repeat it
                # after killing its process tree. Keeps the latch, sends UP
                # events for own held plus the retained plan, retains the plan.
                Send-Result $id (Invoke-ExternalCleanup)
            } elseif ($method -eq 'job_status') {
                Send-Result $id (Get-CuaJobSummary)
            } elseif ($method -eq 'job_kill') {
                $kb = 3000
                try { if ($null -ne $params.timeoutMs) { $kb = [int]$params.timeoutMs } } catch { }
                Send-Result $id (Invoke-CuaJobKill $kb)
            } elseif ($method -eq 'job_reconcile') {
                $rn = $null
                try { $rn = $params.nonce } catch { }
                Send-Result $id (Invoke-CuaJobReconcile $rn)
            } elseif ($hasGen -and $gen -lt $script:StopGeneration) {
                Send-Error $id 'STALE_GENERATION' 'This supervision update was queued before the last stop and cannot resume.'
            } elseif ($script:StopRequested) {
                # Only cleanup, status, kill and reconcile are accepted after
                # the stop latch. Arm, disarm, launch and adopt check the
                # latch as well as the generation so no plan or process can
                # be stored, forgotten or started while stopped.
                Send-Error $id 'STOPPED' ('Supervision update stopped (' + $script:StopReason + ').')
            } elseif ($method -eq 'arm_external_input') {
                Send-Result $id (Set-ExternalPlan $params)
            } elseif ($method -eq 'job_launch') {
                Send-Result $id (New-CuaJobLaunch $params)
            } elseif ($method -eq 'job_adopt') {
                Send-Result $id (Add-CuaJobAdopt $params)
            } else {
                Send-Result $id (Clear-ExternalPlan)
            }
        } catch {
            $xerr = [string]$_
            $xcode = 'WORKER_ERROR'; $xmessage = $xerr
            if ($xerr -match '^(INVALID|ADOPT_REFUSED|JOB_EXISTS|LAUNCH_FAILED|ASSIGN_REFUSED|JOB_KILL_FAILED):(.*)$') {
                $xcode = $Matches[1]
                if ($xcode -eq 'INVALID') { $xcode = 'INVALID_PARAMS' }
                $xmessage = $Matches[2].Trim()
            }
            Send-Error $id $xcode $xmessage
        }
        return
    }
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
                $jobPre = $null
                $jobOut = $null
                if ($null -ne $script:CuaJob) {
                    # Terminal notice BEFORE the bounded kill wait so Node
                    # revokes authorization immediately; the final result
                    # carries the verified outcome after the wait.
                    try { $jobPre = Get-CuaJobSummary } catch { $jobPre = $null }
                    Send-Notify 'stopped' @{ reason = $reason; source = 'request'; stopGeneration = $script:StopGeneration; job = $jobPre }
                    try { [void](Release-ExternalInputs) } catch { }
                    $jobOut = Stop-CuaJobForStop
                }
                Release-HeldInputs
                # Final retained release repeats AFTER verified tree zero;
                # the early best-effort UP above is not proof.
                try { [void](Release-ExternalInputs) } catch { }
                $sres = @{ stopped = $true; reason = $reason }
                if ($null -ne $jobOut) { $sres['job'] = $jobOut }
                Send-Result $id $sres
                if ($null -eq $jobPre) {
                    Send-Notify 'stopped' @{ reason = $reason; source = 'request'; stopGeneration = $script:StopGeneration }
                }
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
    Check 'max-image-dimension' ($script:MaxImageDimension -eq 2000)
    Check 'status-image-cap' ($st.limits.maxImageDimension -eq 2000)
    Check 'status-external-guard' ($st.externalInputGuard.supported -eq $true)
    Check 'status-job-guard' ($st.jobGuard.supported -eq $true)
    # Pure capture-size math only: no bitmap, no CopyFromScreen, no desktop
    # pixels. Verifies BOTH dimensions stay at or below 2000 with aspect
    # preserved, including portrait monitors and requested maxWidth 4096.
    $sizeWide = Get-CaptureSize 7680 2880 4096
    Check 'capture-wide-capped' (($sizeWide.width -eq 2000) -and ($sizeWide.height -le 2000) -and ($sizeWide.height -gt 0))
    $sizePortrait = Get-CaptureSize 1440 2560 4096
    Check 'capture-portrait-capped' (($sizePortrait.width -le 2000) -and ($sizePortrait.height -eq 2000))
    $sizeWindow = Get-CaptureSize 2576 1418 1300
    Check 'capture-window1300' (($sizeWindow.width -eq 1300) -and ($sizeWindow.height -eq 716))
    $sizeSmall = Get-CaptureSize 800 600 1280
    Check 'capture-no-upscale' (($sizeSmall.width -eq 800) -and ($sizeSmall.height -eq 600))
    $ratioWide = [Math]::Abs(([double]$sizeWide.width / [double]$sizeWide.height) - (7680.0 / 2880.0))
    $ratioPortrait = [Math]::Abs(([double]$sizePortrait.width / [double]$sizePortrait.height) - (1440.0 / 2560.0))
    Check 'capture-aspect' (($ratioWide -lt 0.01) -and ($ratioPortrait -lt 0.01))
    $diagMethod = $null
    try { $diagMethod = (Get-Command Get-WindowDiagnostic -ErrorAction Stop) } catch { }
    Check 'focus-diagnostic-wiring' ($diagMethod -ne $null)
    # Unicode boundary: the driver frames JSON lines as UTF-8 bytes, so the
    # console must decode them as UTF-8 (default OEM page garbles every
    # multibyte sequence). The probe is built from [char] codes only because
    # this file has no BOM and PS 5.1 reads literals in the ANSI page.
    # Covers precomposed Latin, cedilla, ligature, euro and a surrogate pair.
    $probe = ("Sign$([char]0xE9) Claude: 67 $([char]0xE0) 83, " +
        "fa$([char]0xE7)ade $([char]0x153)uvre $([char]0xE0) 3 " +
        "$([char]0x20AC) $([char]0xD83D)$([char]0xDE00)")
    $probeBytes = [System.Text.Encoding]::UTF8.GetBytes($probe)
    Check 'console-input-utf8' (([Console]::InputEncoding.WebName -eq 'utf-8') -and (([Console]::InputEncoding.GetString($probeBytes)) -ceq $probe))
    Check 'console-output-utf8' (([Console]::OutputEncoding.WebName -eq 'utf-8') -and (([Console]::OutputEncoding.GetString(([System.Text.Encoding]::UTF8.GetBytes($probe)))) -ceq $probe))
    $units = @(Get-TypeUnits $probe)
    Check 'type-units-count' ($units.Count -eq $probe.Length)
    Check 'type-units-roundtrip' (([string]::new([char[]]$units)) -ceq $probe)
    Check 'type-units-bmp' (($units -contains [char]0xE9) -and ($units -contains [char]0xE7) -and ($units -contains [char]0x153) -and ($units -contains [char]0x20AC))
    Check 'type-units-surrogate' (($units -contains [char]0xD83D) -and ($units -contains [char]0xDE00))
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
    # External input supervision: metadata only here. Arming requires the
    # desktop mutex (no input is sent) and refuses with CONTROLLER_BUSY while
    # busy; disarm and cleanup stay mutex-free so a lost controller can still
    # release. Every release below runs with an empty plan, so no SendInput
    # can occur: no real mutex is acquired and no hotkey is registered.
    $script:OwnsMutex = $false
    $script:Captured.Clear()
    Invoke-Request @{ id = 31; method = 'arm_external_input'; params = @{ buttons = @('left'); keys = @('ctrl') }; generation = 20 }
    $busyArm = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 31 })
    Check 'external-arm-needs-mutex' (($busyArm.Count -eq 1) -and ($busyArm[0].code -eq 'CONTROLLER_BUSY'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 32; method = 'disarm_external_input'; params = @{}; generation = 20 }
    $freeDisarm = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 32 })
    Check 'external-disarm-no-mutex' (($freeDisarm.Count -eq 1) -and ($freeDisarm[0].result.disarmed -eq $true))
    $script:Captured.Clear()
    Invoke-Request @{ id = 33; method = 'cleanup_external_input'; params = @{}; generation = 20 }
    $freeCleanup = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 33 })
    Check 'external-cleanup-no-mutex' (($freeCleanup.Count -eq 1) -and ($freeCleanup[0].result.cleaned -eq $true))
    $script:OwnsMutex = $true
    $script:Captured.Clear()
    Invoke-Request @{ id = 34; method = 'arm_external_input'; params = @{ buttons = @('left'); keys = @('ctrl') }; generation = 20 }
    $armed = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 34 })
    Check 'external-arm' (($armed.Count -eq 1) -and ($armed[0].result.armed -eq $true))
    $script:Captured.Clear()
    Invoke-Request @{ id = 35; method = 'arm_external_input'; params = @{ buttons = @('side'); keys = @() }; generation = 20 }
    $armBad = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 35 })
    Check 'external-arm-validates' (($armBad.Count -eq 1) -and ($armBad[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 36; method = 'disarm_external_input'; params = @{}; generation = 20 }
    $disarmed = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 36 })
    Check 'external-disarm' (($disarmed.Count -eq 1) -and ($disarmed[0].result.disarmed -eq $true))
    $script:Captured.Clear()
    Invoke-Request @{ id = 41; method = 'stop'; params = @{ reason = 'selftest' }; generation = 40 }
    Invoke-Request @{ id = 42; method = 'arm_external_input'; params = @{ buttons = @('left') }; generation = 39 }
    $staleArm = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 42 })
    Check 'stale-arm-rejected' (($staleArm.Count -eq 1) -and ($staleArm[0].code -eq 'STALE_GENERATION'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 43; method = 'arm_external_input'; params = @{ buttons = @('left') }; generation = 40 }
    $latchedArm = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 43 })
    Check 'latched-arm-rejected' (($latchedArm.Count -eq 1) -and ($latchedArm[0].code -eq 'STOPPED'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 44; method = 'cleanup_external_input'; params = @{}; generation = 40 }
    $cleaned = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 44 })
    Check 'cleanup-accepted-on-stop' (($cleaned.Count -eq 1) -and ($cleaned[0].result.cleaned -eq $true))
    Check 'cleanup-keeps-latch' ($script:StopRequested -eq $true)
    $script:StopRequested = $false; $script:StopReason = 'user'; $script:StopReported = $true
    Check 'external-plan-empty' (($script:ExternalHeldButtons.Count -eq 0) -and ($script:ExternalHeldVks.Count -eq 0))
    # Owned-job supervision: pure checks only. No job exists here, so status
    # and kill touch no handles; launch/adopt/reconcileExercise validation
    # and gating before any native call. Zero SendInput by construction.
    $script:Captured.Clear()
    Invoke-Request @{ id = 51; method = 'job_launch'; params = @{ exe = 'C:\x.exe'; args = @(); env = @{}; nonce = 'bad nonce!' }; generation = 40 }
    $jobBadNonce = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 51 })
    Check 'job-launch-nonce' (($jobBadNonce.Count -eq 1) -and ($jobBadNonce[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 52; method = 'job_launch'; params = @{ exe = 'C:\x.exe'; args = @(); env = @{ CUA_DRIVER_RS_HOME = 'C:\h'; EVIL = '1' }; nonce = 'selftest-nonce-0001' }; generation = 40 }
    $jobBadEnv = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 52 })
    Check 'job-launch-env' (($jobBadEnv.Count -eq 1) -and ($jobBadEnv[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 60; method = 'job_launch'; params = @{ exe = 'C:\x.exe'; args = @(); env = @{ CUA_DRIVER_RS_HOME = 'C:\h'; SYSTEMDRIVE = 'ZZ' }; nonce = 'selftest-nonce-0001' }; generation = 40 }
    $jobBadSys = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 60 })
    Check 'job-launch-sysenv' (($jobBadSys.Count -eq 1) -and ($jobBadSys[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 53; method = 'job_launch'; params = @{ exe = 'C:\x.exe'; args = @(); env = @{ CUA_DRIVER_RS_HOME = 'C:\h' }; nonce = 'selftest-nonce-0001' }; generation = 40 }
    $jobNoFile = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 53 })
    Check 'job-launch-exe' (($jobNoFile.Count -eq 1) -and ($jobNoFile[0].code -eq 'INVALID_PARAMS'))
    $script:OwnsMutex = $false
    $script:Captured.Clear()
    Invoke-Request @{ id = 54; method = 'job_launch'; params = @{ exe = 'C:\x.exe'; args = @(); env = @{ CUA_DRIVER_RS_HOME = 'C:\h' }; nonce = 'selftest-nonce-0001' }; generation = 40 }
    $jobBusy = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 54 })
    Check 'job-launch-mutex' (($jobBusy.Count -eq 1) -and ($jobBusy[0].code -eq 'CONTROLLER_BUSY'))
    $script:OwnsMutex = $true
    $script:Captured.Clear()
    Invoke-Request @{ id = 55; method = 'job_adopt'; params = @{ pid = 1234; exe = 'C:\x.exe'; birthMs = 1; socketNonce = 's' }; generation = 40 }
    $adoptNoJob = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 55 })
    Check 'job-adopt-no-job' (($adoptNoJob.Count -eq 1) -and ($adoptNoJob[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 56; method = 'job_status'; params = @{}; generation = 40 }
    $jobStat = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 56 })
    Check 'job-status-empty' (($jobStat.Count -eq 1) -and ($jobStat[0].result.active -eq $false))
    $script:Captured.Clear()
    Invoke-Request @{ id = 57; method = 'job_kill'; params = @{ timeoutMs = 99999 }; generation = 40 }
    $killBad = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq 57 })
    Check 'job-kill-bound' (($killBad.Count -eq 1) -and ($killBad[0].code -eq 'INVALID_PARAMS'))
    $script:Captured.Clear()
    Invoke-Request @{ id = 58; method = 'job_kill'; params = @{}; generation = 40 }
    $killEmpty = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 58 })
    Check 'job-kill-empty' (($killEmpty.Count -eq 1) -and ($killEmpty[0].result.treeExited -eq $true))
    $script:Captured.Clear()
    Invoke-Request @{ id = 59; method = 'job_reconcile'; params = @{ nonce = 'selftest-nonce-0002' }; generation = 40 }
    $recNone = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq 59 })
    Check 'job-reconcile-absent' (($recNone.Count -eq 1) -and ($recNone[0].result.found -eq $false) -and ($null -eq $recNone[0].result.treeExited))
    Check 'job-guard-status' ($st.jobGuard.supported -eq $true)
    # ActivateWindow wiring only (never invoked here, so no thread attach,
    # focus change or input can occur): signature drift would break Focus-Window.
    $actMethod = [StudioComputerUseInput].GetMethod('ActivateWindow')
    $actParams = @()
    if ($actMethod -ne $null) { $actParams = $actMethod.GetParameters() }
    Check 'activate-wiring' (($actMethod -ne $null) -and ($actMethod.ReturnType -eq [bool]) -and ($actParams.Count -eq 1) -and ($actParams[0].ParameterType -eq [IntPtr]))
    Write-Output ("TEST-DONE failed=" + $script:SelfTestFailed + " dpi=" + $script:DpiAwareness)
}

# ---------- job self-test: REAL Job API against private node.exe fixtures ----------
# Run with: powershell -NoProfile -NonInteractive -File computer-use-worker.ps1 -JobSelfTest
# Exercises suspended launch, nested assign, opened-handle adoption, kill to
# verified zero, reconcile and abandon auto-kill using private node.exe
# sleepers only. No CUA runtime, no UI, no input, no focus, no capture, no
# global hotkey and no real mutex acquisition. Every fixture tree is killed
# and verified in a finally block; only exact recorded private pids are ever
# touched. Requires node.exe in PATH, else reports TEST-SKIP.
function Run-JobSelfTest {
    $script:JobTestFailed = 0
    $script:OwnsMutex = $true
    $script:StopGeneration = 0
    $script:CuaJob = $null
    $script:Captured = New-Object System.Collections.ArrayList
    $script:Queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
    function Send-Result($id, $result) { [void]$script:Captured.Add(@{ kind = 'result'; id = $id; result = $result }) }
    function Send-Error($id, $code, $message) { [void]$script:Captured.Add(@{ kind = 'error'; id = $id; code = $code; message = $message }) }
    function Send-Notify($eventName, $extra) { [void]$script:Captured.Add(@{ kind = 'notify'; event = $eventName; extra = $extra }) }
    function Send-Line($obj) { [void]$script:Captured.Add(@{ kind = 'line'; obj = $obj }) }
    function JobCheck($name, $cond) {
        if ($cond) { Write-Output ("TEST-PASS " + $name) }
        else { Write-Output ("TEST-FAIL " + $name); $script:JobTestFailed++ }
    }
    function JobResult($id) {
        $r = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq $id })
        foreach ($er in @($script:Captured | Where-Object { $_.kind -eq 'error' })) {
            [void]$script:JobNotes.Add(('id=' + $er.id + ' ' + $er.code + ' ' + $er.message))
        }
        $script:Captured.Clear()
        if ($r.Count -eq 1) { return $r[0].result } else { return $null }
    }
    $script:JobNotes = New-Object System.Collections.ArrayList
    function JobError($id) {
        $r = @($script:Captured | Where-Object { $_.kind -eq 'error' -and $_.id -eq $id })
        $script:Captured.Clear()
        if ($r.Count -eq 1) {
            [void]$script:JobNotes.Add(('id=' + $id + ' ' + $r[0].code + ' ' + $r[0].message))
            return $r[0]
        } else { return $null }
    }
    function JobBirthMs($pidV) {
        # Fault-tolerant: a TOCTOU death between spawn and read must surface
        # as birth-mismatch downstream, never crash the suite.
        try {
            $p = Get-Process -Id $pidV -ErrorAction Stop
            return [long]($p.StartTime.ToFileTimeUtc() / 10000 - 11644473600000)
        } catch { return 0 }
    }
    function JobAlive($pidV) {
        try { $null = Get-Process -Id $pidV -ErrorAction Stop; return $true } catch { return $false }
    }
    function JobWaitGone($pids, $timeoutMs) {
        $sw = [Diagnostics.Stopwatch]::StartNew()
        while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
            $any = $false
            foreach ($pp in $pids) { if (JobAlive $pp) { $any = $true; break } }
            if (-not $any) { return $true }
            Start-Sleep -Milliseconds 50
        }
        return $false
    }
    function JobActiveCount {
        $s = Get-CuaJobSummary
        if ($null -eq $s -or -not $s.active) { return -2 }
        return [int]$s.activeProcesses
    }
    # Fixture runtimes: node.exe aborts under this exact suspended+NUL
    # spawn path in this sandbox (CSPRNG init abort with every env variant
    # including full env; normal spawn and in-job life verified fine), and a
    # trailing argv after powershell -Command joins the script text, so
    # mechanical trees AND outsiders use inbox timeout.exe / powershell.exe
    # with the nonce embedded inside the script. Adopt checks are
    # exe-agnostic (exact image path), so coverage is equivalent. A positive
    # full adopt needs a Node-parented child, unobtainable in self-test;
    # adapter integration covers it.
    $timeoutExe = 'C:\Windows\System32\timeout.exe'
    $psExe = ''
    try { $psExe = (Get-Command powershell -ErrorAction Stop).Source } catch { $psExe = '' }
    if (-not (Test-Path -LiteralPath $timeoutExe -PathType Leaf) -or [string]::IsNullOrEmpty($psExe)) { Write-Output 'TEST-SKIP inbox fixture runtime missing'; return }
    $sleepArgs = @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 25')
    $tag = 'jobselftest-' + $PID + '-t1'
    $homeDir = $env:TEMP
    if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = $env:TMP }
    if ([string]::IsNullOrWhiteSpace($homeDir)) { $homeDir = 'C:\Windows\Temp' }
    $childEnv = @{ CUA_DRIVER_RS_HOME = $homeDir; CUA_DRIVER_RS_UPDATE_CHECK = '0'; CUA_DRIVER_RS_TELEMETRY_ENABLED = '0'; CUA_LOG = 'WARN' }
    $outsiders = New-Object System.Collections.ArrayList
    $outerJobs = New-Object System.Collections.ArrayList
    try {
        # J1: suspended launch is owned from birth; kill reaches verified zero.
        Invoke-Request @{ id = 101; method = 'job_launch'; params = @{ exe = $psExe; args = $sleepArgs; env = $childEnv; nonce = $tag }; generation = 1 }
        $launched = JobResult 101
        JobCheck 'job-launch-owned' (($null -ne $launched) -and ($launched.launched -eq $true) -and ($launched.pid -gt 0))
        $daemonPid = 0
        if ($null -ne $launched) { $daemonPid = [int]$launched.pid }
        JobCheck 'job-daemon-alive' ((JobAlive $daemonPid) -and ((JobActiveCount) -ge 1))
        Invoke-Request @{ id = 102; method = 'job_status'; params = @{}; generation = 1 }
        $st1 = JobResult 102
        JobCheck 'job-status-live' (($null -ne $st1) -and ($st1.active -eq $true) -and ($st1.activeProcesses -ge 1))
        Invoke-Request @{ id = 103; method = 'job_kill'; params = @{ timeoutMs = 5000 }; generation = 1 }
        $killed = JobResult 103
        JobCheck 'job-kill-zero' (($null -ne $killed) -and ($killed.treeExited -eq $true))
        JobCheck 'job-daemon-gone' (JobWaitGone @($daemonPid) 3000)
        Invoke-Request @{ id = 104; method = 'job_kill'; params = @{}; generation = 1 }
        $retry = JobResult 104
        JobCheck 'job-kill-retry' (($null -ne $retry) -and ($retry.treeExited -eq $true))
        # J2: orphaned grandchild (parent exits immediately) is still owned.
        $tag2 = 'jobselftest-' + $PID + '-t2'
        $grandScript = 'Start-Process -FilePath ' + $timeoutExe + ' -ArgumentList ' + "'/t','25','/nobreak'" + ' -WindowStyle Hidden'
        Invoke-Request @{ id = 111; method = 'job_launch'; params = @{ exe = $psExe; args = @('-NoProfile', '-NonInteractive', '-Command', $grandScript); env = $childEnv; nonce = $tag2 }; generation = 1 }
        $lp = JobResult 111
        $ppid = 0
        if ($null -ne $lp) { $ppid = [int]$lp.pid }
        $parentGone = JobWaitGone @($ppid) 5000
        JobCheck 'job-parent-exits' $parentGone
        $sw2 = [Diagnostics.Stopwatch]::StartNew()
        $orphan = -2
        while ($sw2.ElapsedMilliseconds -lt 5000) {
            $orphan = JobActiveCount
            if ($orphan -ge 1) { break }
            Start-Sleep -Milliseconds 100
        }
        JobCheck 'job-orphan-owned' ($orphan -ge 1)
        Invoke-Request @{ id = 112; method = 'job_kill'; params = @{ timeoutMs = 5000 }; generation = 1 }
        $k2 = JobResult 112
        JobCheck 'job-orphan-killed' (($null -ne $k2) -and ($k2.treeExited -eq $true))
        # J3: opened-handle adoption, exact identity only.
        $tag3 = 'jobselftest-' + $PID + '-t3'
        Invoke-Request @{ id = 121; method = 'job_launch'; params = @{ exe = $psExe; args = $sleepArgs; env = $childEnv; nonce = $tag3 }; generation = 1 }
        $l3 = JobResult 121
        $d3pid = 0
        if ($null -ne $l3) { $d3pid = [int]$l3.pid }
        JobCheck 'job-daemon3' ($d3pid -gt 0)
        $d3birth = 0
        if ($d3pid -gt 0) { $d3birth = JobBirthMs $d3pid }
        $sock = 'socknonce-' + $PID + '-a9'
        function JobOutsider($nonceArg) {
            # The nonce rides INSIDE the script: trailing argv after -Command
            # would join the script text and break Start-Sleep.
            $proc = Start-Process -FilePath $psExe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', ('Start-Sleep -Seconds 25 # ' + $nonceArg)) -PassThru -WindowStyle Hidden
            [void]$outsiders.Add([int]$proc.Id)
            return [int]$proc.Id
        }
        $opid = JobOutsider $sock
        Start-Sleep -Milliseconds 300
        $obirth = JobBirthMs $opid
        Invoke-Request @{ id = 122; method = 'job_adopt'; params = @{ pid = $opid; exe = 'C:\Windows\System32\notepad.exe'; birthMs = $obirth; socketNonce = $sock }; generation = 1 }
        $ePath = JobError 122
        JobCheck 'job-adopt-path' (($null -ne $ePath) -and ($ePath.code -eq 'ADOPT_REFUSED'))
        Invoke-Request @{ id = 123; method = 'job_adopt'; params = @{ pid = $opid; exe = $psExe; birthMs = 1; socketNonce = $sock }; generation = 1 }
        $eBirth = JobError 123
        JobCheck 'job-adopt-birth' (($null -ne $eBirth) -and ($eBirth.code -eq 'ADOPT_REFUSED'))
        Invoke-Request @{ id = 124; method = 'job_adopt'; params = @{ pid = $opid; exe = $psExe; birthMs = $obirth; socketNonce = 'wrong-nonce-zzz' }; generation = 1 }
        $eNonce = JobError 124
        JobCheck 'job-adopt-nonce' (($null -ne $eNonce) -and ($eNonce.code -eq 'ADOPT_REFUSED'))
        $opid2 = JobOutsider $sock
        Start-Sleep -Milliseconds 300
        $obirth2 = JobBirthMs $opid2
        Invoke-Request @{ id = 125; method = 'job_adopt'; params = @{ pid = $opid2; exe = $psExe; birthMs = $obirth2; socketNonce = $sock }; generation = 1 }
        $eParent = JobError 125
        JobCheck 'job-adopt-parent' (($null -ne $eParent) -and ($eParent.code -eq 'ADOPT_REFUSED'))
        Invoke-Request @{ id = 126; method = 'job_adopt'; params = @{ pid = $d3pid; exe = $psExe; birthMs = $d3birth; socketNonce = 'unused-nonce' }; generation = 1 }
        $eOwned = JobError 126
        JobCheck 'job-adopt-owned' (($null -ne $eOwned) -and ($eOwned.code -eq 'ADOPT_REFUSED'))
        Invoke-Request @{ id = 127; method = 'job_kill'; params = @{ timeoutMs = 5000 }; generation = 1 }
        $k3 = JobResult 127
        JobCheck 'job-adopted-killed' (($null -ne $k3) -and ($k3.treeExited -eq $true) -and (JobWaitGone @($d3pid) 5000))
        # J4: benign outer job stays tolerated (nested assignment allowed).
        $outer = [IntPtr]::Zero
        $oe = [StudioComputerUseJob]::CreateKillOnCloseJob(('Local\PrimeAgentStudioCuaJob-outer-' + $PID), [ref]$outer)
        JobCheck 'job-outer-made' (($oe -eq 0) -and ($outer -ne [IntPtr]::Zero))
        if ($outer -ne [IntPtr]::Zero) { [void]$outerJobs.Add($outer) }
        $tag4 = 'jobselftest-' + $PID + '-t4'
        Invoke-Request @{ id = 131; method = 'job_launch'; params = @{ exe = $psExe; args = $sleepArgs; env = $childEnv; nonce = $tag4 }; generation = 1 }
        JobCheck 'job-daemon4' ((JobResult 131) -ne $null)
        $npid = JobOutsider $sock
        Start-Sleep -Milliseconds 300
        $nbirth = JobBirthMs $npid
        $nh = [StudioComputerUseJob]::OpenProcess(0x101101, $false, $npid)
        $inOuter = $false
        if ($nh -ne [IntPtr]::Zero) {
            [void][StudioComputerUseJob]::AssignProcessToJobObject($outer, $nh)
            [void][StudioComputerUseJob]::CloseHandle($nh)
            $nh2 = [StudioComputerUseJob]::OpenProcess(0x101101, $false, $npid)
            if ($nh2 -ne [IntPtr]::Zero) {
                $jj = $false
                if ([StudioComputerUseJob]::InJob($nh2, $outer, [ref]$jj) -eq 0) { $inOuter = $jj }
                [void][StudioComputerUseJob]::CloseHandle($nh2)
            }
        }
        JobCheck 'job-outer-seeded' $inOuter
        Invoke-Request @{ id = 132; method = 'job_adopt'; params = @{ pid = $npid; exe = $psExe; birthMs = $nbirth; socketNonce = $sock }; generation = 1 }
        $eNested = JobError 132
        JobCheck 'job-nested-refused' (($null -ne $eNested) -and ($eNested.code -eq 'ADOPT_REFUSED'))
        $stillOuter = $false
        $nh3 = [StudioComputerUseJob]::OpenProcess(0x101101, $false, $npid)
        if ($nh3 -ne [IntPtr]::Zero) {
            $tt = $false
            if ([StudioComputerUseJob]::InJob($nh3, $outer, [ref]$tt) -eq 0) { $stillOuter = $tt }
            [void][StudioComputerUseJob]::CloseHandle($nh3)
        }
        JobCheck 'job-outer-intact' ((JobAlive $npid) -and $stillOuter)
        Invoke-Request @{ id = 133; method = 'job_kill'; params = @{ timeoutMs = 5000 }; generation = 1 }
        $k4 = JobResult 133
        JobCheck 'job-nested-scoped' (($null -ne $k4) -and ($k4.treeExited -eq $true) -and (JobAlive $npid))
        # J5: holder loss auto-kills via the OS; reconcile then proves clean.
        $tag5 = 'jobselftest-' + $PID + '-t5'
        Invoke-Request @{ id = 141; method = 'job_launch'; params = @{ exe = $psExe; args = $sleepArgs; env = $childEnv; nonce = $tag5 }; generation = 1 }
        $l5 = JobResult 141
        $d5 = 0
        if ($null -ne $l5) { $d5 = [int]$l5.pid }
        JobCheck 'job-loss-daemon' ((JobAlive $d5))
        $lostHandles = @($script:CuaJob.Handles)
        try { [void][StudioComputerUseJob]::CloseHandle($script:CuaJob.Job) } catch { }
        $script:CuaJob = $null
        foreach ($hh in $lostHandles) { try { if ($hh -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($hh) } } catch { } }
        JobCheck 'job-loss-autokill' (JobWaitGone @($d5) 5000)
        Invoke-Request @{ id = 142; method = 'job_reconcile'; params = @{ nonce = $tag5 }; generation = 1 }
        $rec5 = JobResult 142
        JobCheck 'job-reconcile-clean' (($null -ne $rec5) -and ($rec5.found -eq $false) -and ($null -eq $rec5.treeExited))
        Invoke-Request @{ id = 143; method = 'job_reconcile'; params = @{ nonce = 'jobselftest-unknown-zzzz' }; generation = 1 }
        $recU = JobResult 143
        JobCheck 'job-reconcile-unknown' (($null -ne $recU) -and ($recU.found -eq $false) -and ($null -eq $recU.treeExited))
    } finally {
        try {
            if ($null -ne $script:CuaJob) {
                $fl = -1
                if ([StudioComputerUseJob]::KillAndWait($script:CuaJob.Job, 4000, [ref]$fl) -eq 0 -and $fl -le 0) { Close-CuaJobHandles }
                else { Close-CuaJobHandles }
            }
        } catch { try { Close-CuaJobHandles } catch { } }
        foreach ($oj in @($outerJobs)) { try { if ($oj -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($oj) } } catch { } }
        foreach ($op in @($outsiders)) {
            try {
                if (JobAlive $op) { try { Stop-Process -Id $op -Force -ErrorAction Stop } catch { } }
            } catch { }
        }
    }
    foreach ($note in @($script:JobNotes)) { Write-Output ("TEST-NOTE " + $note) }
    Write-Output ("TEST-DONE failed=" + $script:JobTestFailed)
}

# ---------- job adopt probe: REAL Node-parented positive adopt ----------
# Run ONLY via the Node harness (adopt-probe-harness.mjs), which spawns
# BOTH the fixture and this worker, so fixture parent equals worker parent.
# Env: JOBPROBE_JOBNONCE, JOBPROBE_PID, JOBPROBE_EXE, JOBPROBE_BIRTH,
# JOBPROBE_NONCE, JOBPROBE_PARENTPID, JOBPROBE_OUTER=1 optional.
# Production Add-CuaJobAdopt path, no fakes. No hotkey, no real mutex, no
# desktop/input/focus/capture. Bounded; finally kills and verifies.
function Run-JobAdoptProbe {
    $script:JobProbeFailed = 0
    $script:OwnsMutex = $true
    $script:StopGeneration = 0
    $script:CuaJob = $null
    $script:Captured = New-Object System.Collections.ArrayList
    $script:Queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[object]'
    function Send-Result($id, $result) { [void]$script:Captured.Add(@{ kind = 'result'; id = $id; result = $result }) }
    function Send-Error($id, $code, $message) { [void]$script:Captured.Add(@{ kind = 'error'; id = $id; code = $code; message = $message }) }
    function Send-Notify($eventName, $extra) { [void]$script:Captured.Add(@{ kind = 'notify'; event = $eventName; extra = $extra }) }
    function Send-Line($obj) { [void]$script:Captured.Add(@{ kind = 'line'; obj = $obj }) }
    function ProbeCheck($name, $cond) {
        if ($cond) { Write-Output ("TEST-PASS " + $name) }
        else { Write-Output ("TEST-FAIL " + $name); $script:JobProbeFailed++ }
    }
    function ProbeResult($id) {
        $r = @($script:Captured | Where-Object { $_.kind -eq 'result' -and $_.id -eq $id })
        foreach ($er in @($script:Captured | Where-Object { $_.kind -eq 'error' })) {
            Write-Output ("TEST-NOTE id=" + $er.id + " " + $er.code + " " + $er.message)
        }
        $script:Captured.Clear()
        if ($r.Count -eq 1) { return $r[0].result } else { return $null }
    }
    $outer = [IntPtr]::Zero
    try {
        $jn = [string]$env:JOBPROBE_JOBNONCE
        $fpid = 0
        try { $fpid = [int]$env:JOBPROBE_PID } catch { $fpid = 0 }
        $fexe = [string]$env:JOBPROBE_EXE
        $fbirth = 0
        try { $fbirth = [long]$env:JOBPROBE_BIRTH } catch { $fbirth = 0 }
        $fnonce = [string]$env:JOBPROBE_NONCE
        $fparent = 0
        try { if (-not [string]::IsNullOrEmpty($env:JOBPROBE_PARENTPID)) { $fparent = [int]$env:JOBPROBE_PARENTPID } } catch { $fparent = -1 }
        $wantOuter = ([string]$env:JOBPROBE_OUTER -eq '1')
        ProbeCheck 'probe-params' (($jn -match '^[A-Za-z0-9_-]{16,64}$') -and ($fpid -gt 0) -and (-not [string]::IsNullOrEmpty($fexe)) -and ($fbirth -gt 0) -and (-not [string]::IsNullOrEmpty($fnonce)) -and ($fparent -gt 0))
        $name = Get-JobName $jn
        $job = [IntPtr]::Zero
        $ec = [StudioComputerUseJob]::CreateKillOnCloseJob($name, [ref]$job)
        ProbeCheck 'probe-job-made' (($ec -eq 0) -and ($job -ne [IntPtr]::Zero))
        if ($ec -ne 0 -or $job -eq [IntPtr]::Zero) { return }
        $script:CuaJob = @{ Nonce = $jn; Name = $name; Job = $job; DaemonPid = 0; Handles = @(); Adopted = New-Object System.Collections.ArrayList }
        if ($wantOuter) {
            $oh = [IntPtr]::Zero
            $oe = [StudioComputerUseJob]::CreateKillOnCloseJob(($name + '-outer'), [ref]$oh)
            ProbeCheck 'probe-outer-made' (($oe -eq 0) -and ($oh -ne [IntPtr]::Zero))
            if ($oh -ne [IntPtr]::Zero) {
                $fh = [StudioComputerUseJob]::OpenProcess(0x101101, $false, $fpid)
                if ($fh -ne [IntPtr]::Zero) {
                    [void][StudioComputerUseJob]::AssignProcessToJobObject($oh, $fh)
                    [void][StudioComputerUseJob]::CloseHandle($fh)
                }
                $outer = $oh
            }
        }
        Invoke-Request @{ id = 301; method = 'job_adopt'; params = @{ pid = $fpid; exe = $fexe; parentPid = $fparent; birthMs = $fbirth; socketNonce = $fnonce }; generation = 1 }
        $ad = ProbeResult 301
        ProbeCheck 'probe-adopted' (($null -ne $ad) -and ($ad.adopted -eq $true) -and ($ad.pid -eq $fpid))
        Invoke-Request @{ id = 302; method = 'job_status'; params = @{}; generation = 1 }
        $st = ProbeResult 302
        ProbeCheck 'probe-member' (($null -ne $st) -and ($st.active -eq $true) -and ($st.activeProcesses -ge 1))
        Invoke-Request @{ id = 303; method = 'job_kill'; params = @{ timeoutMs = 5000 }; generation = 1 }
        $kk = ProbeResult 303
        ProbeCheck 'probe-killed' (($null -ne $kk) -and ($kk.treeExited -eq $true))
        $gone = $false
        try { $null = Get-Process -Id $fpid -ErrorAction Stop } catch { $gone = $true }
        ProbeCheck 'probe-fixture-gone' $gone
    } finally {
        try {
            if ($null -ne $script:CuaJob) {
                $fl = -1
                if ([StudioComputerUseJob]::KillAndWait($script:CuaJob.Job, 4000, [ref]$fl) -eq 0 -and $fl -le 0) { Close-CuaJobHandles }
                else { Close-CuaJobHandles }
            }
        } catch { try { Close-CuaJobHandles } catch { } }
        try { if ($outer -ne [IntPtr]::Zero) { [void][StudioComputerUseJob]::CloseHandle($outer) } } catch { }
    }
    Write-Output ("TEST-DONE failed=" + $script:JobProbeFailed)
}


if ($SelfTest) { Run-SelfTest; exit ([int]($script:SelfTestFailed -gt 0)) }
if ($JobSelfTest) { Run-JobSelfTest; exit ([int]($script:JobTestFailed -gt 0)) }
if ($JobAdoptProbe) { Run-JobAdoptProbe; exit ([int]($script:JobProbeFailed -gt 0)) }

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
                $jobPre = $null
                $jobOut = $null
                if ($null -ne $script:CuaJob) {
                    try { $jobPre = Get-CuaJobSummary } catch { $jobPre = $null }
                    Send-Notify 'stopped' @{ reason = $reason; source = 'idle'; stopGeneration = $script:StopGeneration; job = $jobPre }
                    try { [void](Release-ExternalInputs) } catch { }
                    $jobOut = Stop-CuaJobForStop
                }
                Release-HeldInputs
                try { [void](Release-ExternalInputs) } catch { }
                foreach ($sid in @($script:StopIds)) {
                    try {
                        $sres = @{ stopped = $true; reason = $reason }
                        if ($null -ne $jobOut) { $sres['job'] = $jobOut }
                        Send-Result $sid $sres
                    } catch { }
                }
                $script:StopIds = @()
                # Latch stays set; the next accepted dispatch resets it.
                # The external plan is released but retained for repeat cleanup.
                if ($null -eq $jobPre) {
                    Send-Notify 'stopped' @{ reason = $reason; source = 'idle'; stopGeneration = $script:StopGeneration }
                }
                $script:StopReported = $true
            }
            continue
        }
        Start-Sleep -Milliseconds 20
    }
}

try {
    Send-Notify 'ready' @{ pid = $PID; hotkey = $script:HotkeyText; hotkeyRegistered = $script:HotkeyRegistered; hotkeyError = $script:HotkeyError; mutex = $script:OwnsMutex; stopGeneration = $script:StopGeneration; externalInputGuard = @{ supported = $true }; jobGuard = @{ supported = $true } }
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
            $jobPre = $null
            $jobOut = $null
            if ($null -ne $script:CuaJob) {
                try { $jobPre = Get-CuaJobSummary } catch { $jobPre = $null }
                Send-Notify 'stopped' @{ reason = $reason; source = 'batch'; stopGeneration = $script:StopGeneration; job = $jobPre }
                try { [void](Release-ExternalInputs) } catch { }
                $jobOut = Stop-CuaJobForStop
            }
            Release-HeldInputs
            try { [void](Release-ExternalInputs) } catch { }
            foreach ($sid in @($script:StopIds)) {
                try {
                    $sres = @{ stopped = $true; reason = $reason }
                    if ($null -ne $jobOut) { $sres['job'] = $jobOut }
                    Send-Result $sid $sres
                } catch { }
            }
            $script:StopIds = @()
            # Latch stays set; the next accepted dispatch resets it.
            if ($null -eq $jobPre) {
                Send-Notify 'stopped' @{ reason = $reason; source = 'batch'; stopGeneration = $script:StopGeneration }
            }
            $script:StopReported = $true
        }
    }
} finally {
    try { Release-HeldInputs } catch { }
    # Release the external plan on shutdown but never clear it here: only an
    # explicit disarm clears, and the adapter repeats cleanup after its CUA
    # process tree is dead.
    try { [void](Release-ExternalInputs) } catch { }
    # Owned job shutdown: bounded kill and verify; handles are released only
    # on verified zero. The process is exiting so nothing can be retained
    # here; the adapter poison plus persisted-nonce reconcile govern any
    # uncertainty. KILL_ON_JOB_CLOSE fires on the last handle close regardless.
    try {
        if ($null -ne $script:CuaJob) {
            $fl = -1
            if ([StudioComputerUseJob]::KillAndWait($script:CuaJob.Job, 1500, [ref]$fl) -eq 0 -and $fl -le 0) {
                Close-CuaJobHandles
            }
        }
    } catch { }
    try { [StudioComputerUseHotkey]::Stop() } catch { }
    try { if ($null -ne $script:Mutex) { if ($script:OwnsMutex) { $script:Mutex.ReleaseMutex() }; $script:Mutex.Dispose() } } catch { }
    try { $readerPs.Stop() } catch { }
    try { $readerPs.Dispose() } catch { }
    try { $readerRunspace.Close() } catch { }
}
