# Keeps the whale overlay glued to the ZCode main window.
#
# Started as a resident child process by desktop/main.cjs, with the overlay's own
# HWND as argument. It reports two things the main process then applies:
#   1. The ZCode window rectangle (on every change) -> the overlay positions the
#      whale inside that rect, so the whale follows ZCode when it is moved or
#      resized.
#   2. Whether the overlay should be visible at all: hidden while ZCode is
#      minimized and while ZCode is covered by another app. Clicks on the overlay
#      itself do not count as "switched away".
#
# Why the polling loop is compiled C# instead of plain PowerShell:
#   This process runs continuously, so its per-tick cost is what decides whether
#   the interval can be short. An interpreted PowerShell loop costs ~3% of a core
#   at 40ms just in interpreter overhead (object construction, function calls,
#   string building). The same loop compiled costs a few microseconds per tick,
#   which makes even a 16ms interval essentially free and keeps the follow feel
#   tight. The expensive part - Process.GetProcessesByName to locate the ZCode
#   window and pid lists - stays on a separate time budget (-ProcessCacheMs).
#
# Output protocol (one JSON object per line):
#   {"x":..,"y":..,"w":..,"h":..,"show":bool}   ZCode rect (physical px) + overlay visibility
#   {"hide":true}                               ZCode window not found (e.g. restarting)
#   {"gone":true}                               ZCode exited; the overlay should quit
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less .ps1
# files using the system ANSI code page, so non-ASCII comments can be decoded
# into bytes that break parsing.
param(
  [Parameter(Mandatory = $true)][string]$OverlayHwnd,
  # How often to re-read the ZCode window rectangle. Lower = snappier follow.
  [int]$IntervalMs = 40,
  # How often to refresh the expensive process/window-handle lookup.
  [int]$ProcessCacheMs = 3000,
  # Pid of the Electron main process that owns the overlay window. Matching the
  # foreground window against this pid is how "the user clicked the whale" is
  # recognised. Pass 0 to fall back to matching every process named "electron".
  # The fallback is wrong in the other direction: any *other* Electron app in
  # front would then look like the overlay, keeping the whale visible while
  # ZCode is covered (v1.3.0 review S4), so a real pid is always preferable.
  [int]$OverlayPid = 0
)

$ErrorActionPreference = 'SilentlyContinue'

# Clamp the interval: below ~16ms there is no visible gain, above 2s the whale
# would feel disconnected from the window.
if ($IntervalMs -lt 16) { $IntervalMs = 16 }
if ($IntervalMs -gt 2000) { $IntervalMs = 2000 }
if ($ProcessCacheMs -lt 500) { $ProcessCacheMs = 500 }

$targetProcess = if ($env:WHALE_TARGET_PROCESS) { $env:WHALE_TARGET_PROCESS } else { 'ZCode' }

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class WhaleFollow
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    static IntPtr _overlayHwnd = IntPtr.Zero;

    static HashSet<int> _targetPids = new HashSet<int>();
    static HashSet<int> _electronPids = new HashSet<int>();
    static IntPtr _targetHwnd = IntPtr.Zero;
    static int _lastReplayTick = 0;

    // Resident command channel from the Electron main process (stdin, one
    // command per line):
    //   replay-click  Re-inject a left click at the current cursor position.
    //     Used when a click that dismissed the popup UI was swallowed by the
    //     overlay (the window must take over the whole screen while a menu /
    //     editor is open so it can see the outside click, but the click then
    //     never reaches ZCode). The main process switches back to
    //     click-through first and asks us to replay, so the user's single
    //     click both dismisses the popup AND lands in ZCode.
    //   handback      Give the OS foreground back to the ZCode window. Called
    //     when the overlay releases keyboard focus while it is still the
    //     foreground window (blur() alone hands foreground to the shell).
    //     This process is a child of the overlay, which is the foreground
    //     process at that moment, so SetForegroundWindow is permitted.
    static void CommandReader()
    {
        try
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "replay-click") ReplayClick();
                else if (line == "handback") HandForegroundBack();
                else if (line == "toolwindow") EnsureToolWindow();
            }
        }
        catch (Exception) { }
    }

    static void ReplayClick()
    {
        int now = Environment.TickCount;
        // Re-entrancy / double-fire guard: one replay per pointer event.
        if (now - _lastReplayTick < 300) return;
        _lastReplayTick = now;
        try
        {
            Thread.Sleep(50); // let the click-through switch land first
            mouse_event(0x02, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
            Thread.Sleep(30);
            mouse_event(0x04, 0, 0, 0, UIntPtr.Zero); // LEFTUP
        }
        catch (Exception) { }
    }

    static void HandForegroundBack()
    {
        try
        {
            if (_targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd)) SetForegroundWindow(_targetHwnd);
        }
        catch (Exception) { }
    }

    // Re-assert WS_EX_TOOLWINDOW on the overlay window. skipTaskbar:true makes
    // Electron set this bit at creation, but setFocusable(true) (the keyboard
    // focus path) rewrites the extended style and wipes it - measured live: a
    // taskbar button appears for the overlay on every text-field focus (seven
    // stale "whale" taskbar items accumulated in one afternoon). Re-applying
    // the bit via Electron's setSkipTaskbar() did not restore it (this Electron
    // drives skipTaskbar through ITaskbarList, not the style bit), so the main
    // process asks us to write the style directly; we already hold the overlay
    // HWND. TOOLWINDOW windows never get a taskbar/alt-tab button.
    static void EnsureToolWindow()
    {
        try
        {
            if (_overlayHwnd == IntPtr.Zero || !IsWindow(_overlayHwnd)) return;
            const int GWL_EXSTYLE = -20;
            const int WS_EX_TOOLWINDOW = 0x80;
            int ex = GetWindowLong(_overlayHwnd, GWL_EXSTYLE);
            if ((ex & WS_EX_TOOLWINDOW) == 0)
                SetWindowLong(_overlayHwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW);
        }
        catch (Exception) { }
    }

    // Expensive: enumerates processes. Only called on the cache budget.
    static void UpdateCache(string targetName, int overlayPid)
    {
        IntPtr hwnd = IntPtr.Zero;
        HashSet<int> tids = new HashSet<int>();
        try
        {
            Process[] procs = Process.GetProcessesByName(targetName);
            foreach (Process p in procs)
            {
                tids.Add(p.Id);
                if (hwnd == IntPtr.Zero && p.MainWindowHandle != IntPtr.Zero) hwnd = p.MainWindowHandle;
                p.Dispose();
            }
        }
        catch (Exception) { }
        _targetHwnd = hwnd;
        _targetPids = tids;

        HashSet<int> eids = new HashSet<int>();
        if (overlayPid > 0)
        {
            // Known owner of the overlay window: no enumeration needed, and no
            // risk of matching unrelated Electron apps. GetWindowThreadProcessId
            // reports the toplevel window's process, which is the Electron main
            // process for both the frame and the renderer's content.
            eids.Add(overlayPid);
        }
        else
        {
            try
            {
                Process[] procs = Process.GetProcessesByName("electron");
                foreach (Process p in procs) { eids.Add(p.Id); p.Dispose(); }
            }
            catch (Exception) { }
        }
        _electronPids = eids;
    }

    public static void Run(IntPtr overlay, int intervalMs, int cacheMs, string targetName, int overlayPid)
    {
        // GetWindowRect coordinates depend on this process's DPI awareness: a
        // DPI-unaware process receives virtualized ("logical") rects, e.g. a
        // 2560px physical window reports 2048 at 125% scaling. The Electron
        // main process always treats our output as physical pixels and converts
        // it to DIP itself, so without opting in here the whale's viewport gets
        // scaled down a second time on scaled displays and it can never reach
        // the bottom-right corner of the ZCode window.
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2; on older Windows the
            // export is missing and we fall back to system-level awareness.
            if (SetProcessDpiAwarenessContext((IntPtr)(-4)) == IntPtr.Zero) SetProcessDPIAware();
        }
        catch { SetProcessDPIAware(); }
        _overlayHwnd = overlay;
        Console.Error.WriteLine(
            "follow-start overlay=" + overlay.ToInt64() + " valid=" + IsWindow(overlay) +
            " interval=" + intervalMs + " cache=" + cacheMs + " target=" + targetName +
            " overlay-pid=" + overlayPid);
        UpdateCache(targetName, overlayPid);
        // Resident stdin command listener (see CommandReader above). Background
        // thread: ReadLine blocks until the main process sends a command or
        // closes the pipe.
        try
        {
            Thread reader = new Thread(CommandReader);
            reader.IsBackground = true;
            reader.Start();
        }
        catch (Exception) { }
        // TickCount is an int millisecond counter (wraps every ~49 days). Plain
        // int subtraction stays correct across the wrap, and TickCount64 does not
        // exist on the .NET Framework that Windows PowerShell 5.1 compiles against.
        int lastCache = Environment.TickCount;
        int missSince = 0;
        bool haveSig = false;
        int lastL = 0, lastT = 0, lastW = 0, lastH = 0;
        bool lastShow = false;

        while (true)
        {
            if (!IsWindow(overlay)) return;

            int now = Environment.TickCount;
            if (now - lastCache >= cacheMs) { UpdateCache(targetName, overlayPid); lastCache = now; }

            // Cheap path: reuse the cached handle while it is still valid.
            IntPtr z = (_targetHwnd != IntPtr.Zero && IsWindow(_targetHwnd)) ? _targetHwnd : IntPtr.Zero;
            if (z == IntPtr.Zero)
            {
                if (missSince == 0)
                {
                    missSince = now;
                    Console.Out.WriteLine("{\"hide\":true}");
                    Console.Out.Flush();
                }
                // "gone" must require the process itself to be absent, not just the
                // window: right after ZCode starts, its main window can stay
                // unfindable for a while (launcher hand-off / updater restarts the
                // window), and quitting the overlay here leaves the launch page
                // whale dead until the next hook fires (measured 2026-10-01:
                // overlay gone 5s after start, dead for a minute on the home page).
                else if (now - missSince >= 5000 && _targetPids.Count == 0)
                {
                    Console.Out.WriteLine("{\"gone\":true}");
                    Console.Out.Flush();
                    return;
                }
                Thread.Sleep(intervalMs);
                continue;
            }
            missSince = 0;

            RECT r;
            if (GetWindowRect(z, out r))
            {
                bool minimized = IsIconic(z);
                uint fgPid = 0;
                IntPtr fg = GetForegroundWindow();
                if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);
                bool fgIsTarget = _targetPids.Contains((int)fgPid);
                bool fgIsOverlay = _electronPids.Contains((int)fgPid);
                bool show = !minimized && (fgIsTarget || fgIsOverlay);

                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (!haveSig || r.Left != lastL || r.Top != lastT || w != lastW || h != lastH || show != lastShow)
                {
                    haveSig = true;
                    lastL = r.Left; lastT = r.Top; lastW = w; lastH = h; lastShow = show;

                    // Decision inputs go to stderr; the main process records them
                    // only when the debug log is enabled.
                    Console.Error.WriteLine(
                        "state show=" + (show ? "true" : "false") +
                        " minimized=" + (minimized ? "true" : "false") +
                        " fgPid=" + fgPid +
                        " fgIsZCode=" + (fgIsTarget ? "true" : "false") +
                        " fgIsOverlay=" + (fgIsOverlay ? "true" : "false"));

                    Console.Out.WriteLine(
                        "{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + w + ",\"h\":" + h +
                        ",\"show\":" + (show ? "true" : "false") + "}");
                    Console.Out.Flush();
                }
            }

            Thread.Sleep(intervalMs);
        }
    }
}
'@

# A compile failure must be visible: SilentlyContinue would swallow Add-Type's
# error and show up as "script exits immediately, overlay quits with it", which
# is a nasty thing to debug.
try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('csharp-compile-failed: ' + $_.Exception.Message)
  exit 1
}

try {
  [WhaleFollow]::Run([IntPtr][long]$OverlayHwnd, $IntervalMs, $ProcessCacheMs, $targetProcess, $OverlayPid)
} catch {
  [Console]::Error.WriteLine('follow-loop-error: ' + $_.Exception.Message)
  exit 1
}
