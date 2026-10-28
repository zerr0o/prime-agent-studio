// runtime/computer-use-overlay.cs
// Click-through, capture-excluded orange border overlay for Computer Use.
//
// Hookup (root-owned, in-process, no Tauri window / IPC / new process):
//   Add-Type -Path "$PSScriptRoot/computer-use-overlay.cs" `
//     -ReferencedAssemblies System.Windows.Forms,System.Drawing
//   [StudioComputerUseOverlay]::Start()  # $true only when every visible
//                                         # window reads back affinity 0x11
//   [StudioComputerUseOverlay]::Stop()   # bounded + idempotent
//   [StudioComputerUseOverlay]::GetStatus()
//
// Guarantees: no window is ever shown until SetWindowDisplayAffinity(0x11)
// succeeds AND GetWindowDisplayAffinity reads back 0x11 for it; any setup
// failure closes every window, keeps everything hidden and reports Error
// (no unprotected fallback). Windows are click-through / no-activate /
// toolwindow / topmost and never take focus. Display/DPI changes rebuild via
// native events (SystemEvents + WM_DPICHANGED), never polling. No timers, no
// logging, no shared cross-process state. PowerShell 5 (C# 5) syntax only.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

// Small immutable snapshot returned by StudioComputerUseOverlay.GetStatus().
public sealed class OverlayStatus
{
    public bool Visible { get; private set; }
    public bool CaptureExcluded { get; private set; }
    public int MonitorCount { get; private set; }
    public int WindowCount { get; private set; }
    public string Error { get; private set; }

    public OverlayStatus(bool visible, bool excluded, int monitors, int windows, string error)
    {
        Visible = visible;
        CaptureExcluded = excluded;
        MonitorCount = monitors;
        WindowCount = windows;
        Error = error;
    }
}

public static class StudioComputerUseOverlay
{
    // Validated look: #FF8A24, alpha 240 on the outer 2 physical px,
    // quadratic fade to alpha 0 at 24 px inward. No animation.
    private const int BorderR = 255;
    private const int BorderG = 138;
    private const int BorderB = 36;
    private const int AlphaMax = 240;
    private const int FadePx = 24;
    private const uint ExcludeAffinity = 0x11; // WDA_EXCLUDEFROMCAPTURE
    private const int StartupTimeoutMs = 5000;
    private const int StopJoinMs = 5000;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; public POINT(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int W; public int H; public SIZE(int w, int h) { W = w; H = h; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct BLEND { public byte Op; public byte Flags; public byte Alpha; public byte Format; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint affinity);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr dstDc, ref POINT pos, ref SIZE size,
        IntPtr srcDc, ref POINT srcPos, int colorKey, ref BLEND blend, int flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDc);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hDc);
    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hDc, IntPtr obj);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hDc);

    // One thin layered strip window. Four per monitor (top/bottom full-width,
    // sides excluding corners), so per-screen buffers stay ~1 MB, not ~28 MB.
    private sealed class StripForm : Form
    {
        private const int WmDpichanged = 0x02E0;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams p = base.CreateParams;
                // NOACTIVATE | TOOLWINDOW | TRANSPARENT(click-through) | LAYERED
                p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020 | 0x00080000;
                return p;
            }
        }
        public StripForm(Rectangle bounds)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            TopMost = true;
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmDpichanged) RequestRebuild();
            base.WndProc(ref m);
        }
    }

    private struct StripSpec
    {
        public Rectangle Bounds; // screen coords (physical px, may be negative)
        public int MonW; public int MonH; // owning monitor size
        public int OffX; public int OffY; // strip origin in monitor coords
    }

    private static readonly object _sync = new object();
    private static Thread _thread;
    private static ManualResetEvent _ready;
    private static StripForm[] _windows = new StripForm[0];
    private static volatile bool _cancel;
    private static bool _rebuildQueued;
    private static bool _visible;
    private static bool _excluded;
    private static int _monitors;
    private static string _error;

    // Pure pixel math (also the self-test hook; no handles, no windows).
    // distancePx = min distance to any monitor edge, in physical px.
    public static int BorderAlpha(int distancePx)
    {
        if (distancePx >= FadePx) return 0;
        if (distancePx < 2) return AlphaMax;
        double t = (double)(FadePx - distancePx) / (double)(FadePx - 2);
        return (int)Math.Round((double)AlphaMax * t * t);
    }

    // Premultiplied ARGB pixel for the border (0 = fully transparent).
    public static int BorderPixel(int distancePx)
    {
        if (distancePx >= FadePx) return 0;
        int a = BorderAlpha(distancePx);
        int r = BorderR * a / 255;
        int g = BorderG * a / 255;
        int b = BorderB * a / 255;
        return (a << 24) | (r << 16) | (g << 8) | b;
    }

    // True only once every visible window has capture exclusion VERIFIED.
    // Startup is bounded: on timeout nothing is left visible late.
    public static bool Start()
    {
        lock (_sync)
        {
            if (_thread != null && _thread.IsAlive) return _error == null && _excluded;
            try { if (_ready != null) _ready.Close(); } catch { }
            _ready = new ManualResetEvent(false);
            _error = null;
            _excluded = false;
            _visible = false;
            _windows = new StripForm[0];
            _monitors = 0;
            _cancel = false;
            _rebuildQueued = false;
            _thread = new Thread(PumpProc);
            _thread.IsBackground = true; // process lifetime guarantees OS cleanup
            _thread.SetApartmentState(ApartmentState.STA);
            try { _thread.Start(); }
            catch (Exception ex) { _thread = null; _error = "overlay thread failed: " + ex.Message; return false; }
        }
        bool signalled = false;
        try { signalled = _ready.WaitOne(StartupTimeoutMs); } catch { }
        lock (_sync)
        {
            if (signalled && _error == null && _excluded && _thread != null && _thread.IsAlive) return true;
            if (_error == null) _error = signalled ? "startup aborted" : "startup timeout";
            _cancel = true;
        }
        TeardownAfterFailedStart();
        return false;
    }

    // Non-blocking: signals cancellation and posts close to the overlay
    // thread, then returns. Safe anytime (also before Start / twice).
    // Lets the caller release held keys/buttons first; Stop() joins after.
    public static void RequestStop()
    {
        StripForm[] wins;
        lock (_sync)
        {
            _cancel = true;
            wins = _windows;
        }
        foreach (StripForm f in wins)
        {
            try { if (f.IsHandleCreated) f.BeginInvoke(new MethodInvoker(ShutdownOnUi)); } catch { }
        }
    }

    // Bounded + idempotent. True when no overlay window survives.
    public static bool Stop()
    {
        Thread t;
        lock (_sync) { t = _thread; }
        if (t == null) return true;
        try { RequestStop(); } catch { }
        bool joined = false;
        try { joined = t.Join(StopJoinMs); } catch { }
        lock (_sync)
        {
            // Clear only once the thread is provably dead; otherwise retain
            // handles/status (plus an error) so a later RequestStop/Stop retry works.
            bool dead = false;
            try { dead = joined && !t.IsAlive; } catch { dead = false; }
            if (!dead)
            {
                if (_error == null) _error = "stop join timeout, overlay thread still alive";
                return false;
            }
            try { SystemEvents.DisplaySettingsChanged -= OnDisplayChanged; } catch { }
            _windows = new StripForm[0];
            _visible = false;
            _excluded = false;
            _thread = null;
        }
        return true;
    }

    public static OverlayStatus GetStatus()
    {
        lock (_sync)
        {
            return new OverlayStatus(_visible, _excluded, _monitors, _windows.Length, _error);
        }
    }

    private static void SetErrorIfEmpty(string message)
    {
        lock (_sync) { if (_error == null) _error = message; }
    }

    private static void TeardownAfterFailedStart()
    {
        Thread t;
        lock (_sync) { t = _thread; }
        if (t != null)
        {
            try { RequestStop(); } catch { }
            try { t.Join(StopJoinMs); } catch { }
        }
        lock (_sync)
        {
            // Retain handles/_thread while the thread is still alive so a later
            // Stop() can rejoin it. It can never show a window late: the builder
            // checks _cancel before every Show and again atomically at publish.
            bool dead = true;
            try { dead = (t == null) || !t.IsAlive; } catch { dead = true; }
            if (!dead)
            {
                if (_error == null) _error = "startup teardown join timeout, overlay thread still alive";
                return;
            }
            try { SystemEvents.DisplaySettingsChanged -= OnDisplayChanged; } catch { }
            _windows = new StripForm[0];
            _visible = false;
            _excluded = false;
            _thread = null;
        }
    }

    private static void PumpProc()
    {
        bool built = false;
        try
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } // PerMonitorV2: physical px
            built = BuildAndShow();
            if (built)
            {
                try { SystemEvents.DisplaySettingsChanged += OnDisplayChanged; } catch { }
            }
        }
        catch (Exception ex)
        {
            SetErrorIfEmpty("overlay startup failed: " + ex.Message);
            CloseAllOnUiThread();
        }
        finally { try { _ready.Set(); } catch { } }
        if (!built) return; // thread ends; Start reports _error. No stray pump.
        try { Application.Run(); } catch { }
        try { SystemEvents.DisplaySettingsChanged -= OnDisplayChanged; } catch { }
        CloseAllOnUiThread();
        lock (_sync) { _visible = false; _excluded = false; }
    }

    // Runs on the overlay UI thread. Creates hidden windows, verifies capture
    // exclusion on ALL of them, renders, then shows. False = nothing visible.
    private static bool BuildAndShow()
    {
        Screen[] screens;
        try { screens = Screen.AllScreens; }
        catch (Exception ex) { SetErrorIfEmpty("Screen.AllScreens failed: " + ex.Message); return false; }
        List<StripSpec> specs = new List<StripSpec>();
        foreach (Screen s in screens)
        {
            Rectangle b = s.Bounds;
            if (b.Width >= 2 * FadePx && b.Height >= 2 * FadePx)
            {
                AddSpec(specs, b, b.X, b.Y, b.Width, FadePx, 0, 0);
                AddSpec(specs, b, b.X, b.Y + b.Height - FadePx, b.Width, FadePx, 0, b.Height - FadePx);
                AddSpec(specs, b, b.X, b.Y + FadePx, FadePx, b.Height - 2 * FadePx, 0, FadePx);
                AddSpec(specs, b, b.X + b.Width - FadePx, b.Y + FadePx, FadePx, b.Height - 2 * FadePx,
                    b.Width - FadePx, FadePx);
            }
            else if (b.Width > 0 && b.Height > 0)
            {
                AddSpec(specs, b, b.X, b.Y, b.Width, b.Height, 0, 0); // ponytail: tiny screen, one exact strip
            }
        }
        List<StripForm> forms = new List<StripForm>();
        try
        {
            foreach (StripSpec spec in specs)
            {
                StripForm f = new StripForm(spec.Bounds);
                forms.Add(f);
                IntPtr h = f.Handle; // create handle while still hidden
                string why;
                if (!CheckAffinity(h, out why)) // gate: show NOTHING until verified
                {
                    SetErrorIfEmpty(why);
                    return false;
                }
            }
            for (int i = 0; i < forms.Count; i++)
            {
                string renderError;
                if (!RenderStrip(forms[i], specs[i], out renderError))
                {
                    SetErrorIfEmpty(renderError);
                    return false;
                }
            }
            if (_cancel) return false; // timed-out / stopped Start must show nothing late
            foreach (StripForm f in forms)
            {
                if (_cancel) return false;
                f.Show(); // ShowWithoutActivation + NOACTIVATE: focus untouched
            }
            foreach (StripForm f in forms) // re-verify after Show
            {
                string why;
                if (!CheckAffinity(f.Handle, out why))
                {
                    SetErrorIfEmpty(why);
                    return false;
                }
            }
        }
        catch (Exception ex)
        {
            SetErrorIfEmpty("overlay build failed: " + ex.Message);
            return false;
        }
        finally
        {
            if (_cancel || _error != null) CloseForms(forms);
        }
        // Re-check cancellation atomically with publishing: a RequestStop
        // landing here must not leave a running pump behind with no record.
        bool publish = false;
        lock (_sync)
        {
            publish = !_cancel && _error == null && forms.Count > 0;
            if (publish)
            {
                _windows = forms.ToArray();
                _monitors = screens.Length;
                _visible = true;
                _excluded = true;
            }
        }
        if (!publish) CloseForms(forms);
        return publish;
    }

    private static void AddSpec(List<StripSpec> specs, Rectangle mon, int x, int y, int w, int h, int ox, int oy)
    {
        if (w <= 0 || h <= 0) return;
        StripSpec spec = new StripSpec();
        spec.Bounds = new Rectangle(x, y, w, h);
        spec.MonW = mon.Width;
        spec.MonH = mon.Height;
        spec.OffX = ox;
        spec.OffY = oy;
        specs.Add(spec);
    }

    // True only if exclusion is active right now. Reads last-error solely when
    // a native call itself reports failure (never stale codes on success).
    private static bool CheckAffinity(IntPtr h, out string why)
    {
        why = null;
        uint affinity;
        if (!SetWindowDisplayAffinity(h, ExcludeAffinity))
        {
            why = "SetWindowDisplayAffinity failed (0x" + Marshal.GetLastWin32Error().ToString("X") + ")";
            return false;
        }
        if (!GetWindowDisplayAffinity(h, out affinity))
        {
            why = "GetWindowDisplayAffinity failed (0x" + Marshal.GetLastWin32Error().ToString("X") + ")";
            return false;
        }
        if (affinity != ExcludeAffinity)
        {
            why = "capture exclusion not verified (affinity=0x" + affinity.ToString("X") + ")";
            return false;
        }
        return true;
    }

    private static bool RenderStrip(StripForm f, StripSpec spec, out string error)
    {
        error = null;
        int w = spec.Bounds.Width;
        int h = spec.Bounds.Height;
        Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb);
        try
        {
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly,
                PixelFormat.Format32bppPArgb);
            try
            {
                int[] pixels = new int[w * h];
                for (int y = 0; y < h; y++)
                {
                    int my = spec.OffY + y;
                    int edgeY = spec.MonH - 1 - my;
                    for (int x = 0; x < w; x++)
                    {
                        int mx = spec.OffX + x;
                        int d = mx;
                        int edge = spec.MonW - 1 - mx;
                        if (edge < d) d = edge;
                        if (my < d) d = my;
                        if (edgeY < d) d = edgeY;
                        pixels[y * w + x] = BorderPixel(d);
                    }
                }
                Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            }
            finally { bmp.UnlockBits(data); }
            IntPtr screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) { error = "GetDC failed"; return false; }
            try
            {
                IntPtr memDc = CreateCompatibleDC(screenDc);
                if (memDc == IntPtr.Zero) { error = "CreateCompatibleDC failed"; return false; }
                try
                {
                    IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0));
                    try
                    {
                        IntPtr old = SelectObject(memDc, hbmp);
                        try
                        {
                            POINT pos = new POINT(f.Left, f.Top);
                            SIZE size = new SIZE(w, h);
                            POINT src = new POINT(0, 0);
                            BLEND blend = new BLEND();
                            blend.Op = 0;
                            blend.Flags = 0;
                            blend.Alpha = 255;
                            blend.Format = 1; // AC_SRC_ALPHA, premultiplied PArgb
                            if (!UpdateLayeredWindow(f.Handle, screenDc, ref pos, ref size, memDc,
                                ref src, 0, ref blend, 2))
                            {
                                error = "UpdateLayeredWindow failed (0x" +
                                    Marshal.GetLastWin32Error().ToString("X") + ")";
                                return false;
                            }
                            return true;
                        }
                        finally { SelectObject(memDc, old); }
                    }
                    finally { DeleteObject(hbmp); }
                }
                finally { DeleteDC(memDc); }
            }
            finally { ReleaseDC(IntPtr.Zero, screenDc); }
        }
        finally { bmp.Dispose(); }
    }

    private static void OnDisplayChanged(object sender, EventArgs e) { RequestRebuild(); }

    private static void RequestRebuild()
    {
        StripForm target = null;
        lock (_sync)
        {
            if (_cancel || _rebuildQueued || _thread == null || !_thread.IsAlive) return;
            if (_windows.Length == 0) return;
            _rebuildQueued = true;
            target = _windows[0];
        }
        try
        {
            if (target.IsHandleCreated) target.BeginInvoke(new MethodInvoker(RebuildProc));
            else lock (_sync) { _rebuildQueued = false; }
        }
        catch { lock (_sync) { _rebuildQueued = false; } }
    }

    // Runs on the overlay UI thread. A failed rebuild hides/closes everything
    // and reports Error (never an unprotected fallback).
    private static void RebuildProc()
    {
        lock (_sync) { _rebuildQueued = false; if (_cancel) return; }
        CloseAllOnUiThread();
        lock (_sync) { _visible = false; _excluded = false; }
        BuildAndShow();
    }

    private static void CloseAllOnUiThread()
    {
        // Retain the array while CloseForms runs so GetStatus never reports
        // WindowCount 0 alongside Visible true; clear atomically after disposal.
        // Never wipes a newer array a rebuild may have published meanwhile.
        StripForm[] wins;
        lock (_sync) { wins = _windows; }
        CloseForms(new List<StripForm>(wins));
        lock (_sync)
        {
            if (ReferenceEquals(_windows, wins))
            {
                _windows = new StripForm[0];
                _visible = false;
                _excluded = false;
                _monitors = 0;
            }
        }
    }

    private static void CloseForms(List<StripForm> forms)
    {
        foreach (StripForm f in forms)
        {
            try { if (!f.IsDisposed) f.Close(); } catch { }
            try { f.Dispose(); } catch { }
        }
    }

    private static void ShutdownOnUi()
    {
        try { CloseAllOnUiThread(); } catch { }
        try { Application.ExitThread(); } catch { }
    }
}
