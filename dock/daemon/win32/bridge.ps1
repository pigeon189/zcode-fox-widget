param()
$ErrorActionPreference = 'Stop'

# Long-lived helper process: compiles a small C# helper and then reads commands
# from stdin, one JSON line per command. Kept alive so drag-time hit tests do
# not pay PowerShell startup + C# compile cost per sample.
#
# Protocol (one line in, one line JSON out):
#   snapshot                 -> {"ok":true,"windows":[...]}
#   hit <x> <y> [excludePid] -> {"ok":true,"hits":[...]}   (top 5, z-order)
#   rect <hwndHex>           -> {"ok":true,"rect":{...},"bg":bool}
#   focus <hwndHex>          -> {"ok":true,"method":"foreground|flash"}
#   cursor                   -> {"ok":true,"x":..,"y":..}
#   ping                     -> {"ok":true}
#   quit                     -> exits
#
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 reads BOM-less .ps1
# with the system ANSI code page; non-ASCII comments can break parsing).

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class FoxWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO info);

    [StructLayout(LayoutKind.Sequential)]
    public struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    const int SW_RESTORE = 9;
    const uint FLASHW_ALL = 3;
    const uint FLASHW_TIMERNOFG = 12;

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref int size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    const uint GW_HWNDNEXT = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    public class Win
    {
        public long Hwnd;
        public int Pid;
        public string Exe;
        public string Title;
        public string Cls;
        public long StartMs;
        public uint Dpi;
        public int X, Y, W, H;
        public int Z;
    }

    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\r': sb.Append("\\r"); break;
                case '\n': sb.Append("\\n"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append(' ');
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static string ExeOf(uint pid)
    {
        IntPtr p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (p == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int n = sb.Capacity;
            if (QueryFullProcessImageNameW(p, 0, sb, ref n)) return sb.ToString(0, n);
            return "";
        }
        finally { CloseHandle(p); }
    }

    static long StartMsOf(uint pid)
    {
        try
        {
            var p = Process.GetProcessById((int)pid);
            return new DateTimeOffset(p.StartTime).ToUnixTimeMilliseconds();
        }
        catch (Exception) { return 0; }
    }

    static List<Win> Walk(int stopAfterHits, int hx, int hy, int excludePid, bool hitMode)
    {
        var list = new List<Win>();
        IntPtr h = GetTopWindow(IntPtr.Zero);
        int z = 0;
        while (h != IntPtr.Zero)
        {
            z++;
            IntPtr next = GetWindow(h, GW_HWNDNEXT);
            if (IsWindowVisible(h) && !IsIconic(h))
            {
                RECT r;
                if (GetWindowRect(h, out r))
                {
                    int w = r.Right - r.Left;
                    int hh = r.Bottom - r.Top;
                    if (w > 0 && hh > 0)
                    {
                        uint pid;
                        GetWindowThreadProcessId(h, out pid);
                        bool skip = excludePid > 0 && (int)pid == excludePid;
                        bool contains = hitMode && hx >= r.Left && hx < r.Right && hy >= r.Top && hy < r.Bottom;
                        if (!skip && (!hitMode || contains))
                        {
                            var t = new StringBuilder(512);
                            GetWindowTextW(h, t, t.Capacity);
                            var c = new StringBuilder(256);
                            GetClassNameW(h, c, c.Capacity);
                            var wi = new Win();
                            wi.Hwnd = h.ToInt64();
                            wi.Pid = (int)pid;
                            wi.Exe = ExeOf(pid);
                            wi.Title = t.ToString();
                            wi.Cls = c.ToString();
                            wi.StartMs = StartMsOf(pid);
                            wi.Dpi = GetDpiForWindow(h);
                            wi.X = r.Left; wi.Y = r.Top; wi.W = w; wi.H = hh; wi.Z = z;
                            list.Add(wi);
                            if (hitMode && list.Count >= stopAfterHits) return list;
                        }
                    }
                }
            }
            h = next;
        }
        return list;
    }

    static string One(Win w)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"hwnd\":\"").Append(w.Hwnd.ToString("x")).Append("\",");
        sb.Append("\"pid\":").Append(w.Pid.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"exe\":\"").Append(Esc(w.Exe)).Append("\",");
        sb.Append("\"title\":\"").Append(Esc(w.Title)).Append("\",");
        sb.Append("\"cls\":\"").Append(Esc(w.Cls)).Append("\",");
        sb.Append("\"startMs\":").Append(w.StartMs.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"dpi\":").Append(w.Dpi.ToString(CultureInfo.InvariantCulture)).Append(',');
        sb.Append("\"rect\":{\"x\":").Append(w.X).Append(",\"y\":").Append(w.Y)
          .Append(",\"w\":").Append(w.W).Append(",\"h\":").Append(w.H).Append("},");
        sb.Append("\"z\":").Append(w.Z).Append('}');
        return sb.ToString();
    }

    static string ListJson(List<Win> list, string key)
    {
        var sb = new StringBuilder(1024);
        sb.Append("{\"ok\":true,\"").Append(key).Append("\":[");
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(One(list[i]));
        }
        sb.Append("]}");
        return sb.ToString();
    }

    public static string Snapshot()
    {
        return ListJson(Walk(0, 0, 0, 0, false), "windows");
    }

    public static string Hit(int x, int y, int excludePid)
    {
        // 12 layers: host + two product-line overlays + topmost tool windows can
        // sit above an agent window. Keep this comment ASCII (PS 5.1 reads
        // BOM-less scripts in the system ANSI code page).
        return ListJson(Walk(12, x, y, excludePid, true), "hits");
    }

    public static string Cursor()
    {
        POINT p;
        if (!GetCursorPos(out p)) return "{\"ok\":false}";
        return "{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}";
    }

    public static string Rect(string hwndHex)
    {
        long raw;
        if (!long.TryParse(hwndHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out raw))
            return "{\"ok\":false,\"error\":\"bad-hwnd\"}";
        IntPtr h = new IntPtr(raw);
        // 最小化的窗口没有可用的屏幕矩形：Windows 会给 (-32000,-32000)，
        // 直接拿去定位会把浮层放到屏幕外（真机踩过：狐狸消失）
        if (IsIconic(h)) return "{\"ok\":false,\"reason\":\"minimized\"}";
        RECT r;
        if (!GetWindowRect(h, out r)) return "{\"ok\":false,\"reason\":\"rect-failed\"}";
        int w = r.Right - r.Left;
        int hh = r.Bottom - r.Top;
        if (w <= 0 || hh <= 0 || r.Left <= -30000 || r.Top <= -30000)
            return "{\"ok\":false,\"reason\":\"offscreen\"}";
        // "bg": the window is alive but not in foreground (user switched away,
        // or it is fully covered by another window). A foreground window of the
        // SAME process (host settings dialog etc.) still counts as "in use".
        // Keep this comment ASCII (PS 5.1 reads BOM-less scripts in ANSI).
        IntPtr fg = GetForegroundWindow();
        uint hostPid;
        GetWindowThreadProcessId(h, out hostPid);
        uint fgPid;
        GetWindowThreadProcessId(fg, out fgPid);
        bool bg = fg != h && fgPid != hostPid;
        return "{\"ok\":true,\"bg\":" + (bg ? "true" : "false")
          + ",\"rect\":{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + w + ",\"h\":" + hh + "}}";
    }

    public static string Focus(string hwndHex)
    {
        long raw;
        if (!long.TryParse(hwndHex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out raw))
            return "{\"ok\":false,\"error\":\"bad-hwnd\"}";
        IntPtr h = new IntPtr(raw);
        if (!IsWindow(h)) return "{\"ok\":false,\"error\":\"window-not-found\"}";
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);

        IntPtr fg = GetForegroundWindow();
        uint fgPid;
        uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
        uint curTid = GetCurrentThreadId();
        bool attached = false;
        if (fgTid != 0 && fgTid != curTid)
        {
            attached = AttachThreadInput(curTid, fgTid, true);
        }
        bool ok = SetForegroundWindow(h);
        BringWindowToTop(h);
        if (attached) AttachThreadInput(curTid, fgTid, false);

        if (ok && GetForegroundWindow() == h)
            return "{\"ok\":true,\"method\":\"foreground\"}";

        // Foreground lock: fall back to flashing the taskbar button. Never
        // pretend the switch succeeded.
        var fi = new FLASHWINFO();
        fi.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        fi.hwnd = h;
        fi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
        fi.uCount = 4;
        fi.dwTimeout = 0;
        bool flashed = FlashWindowEx(ref fi);
        if (flashed) return "{\"ok\":true,\"method\":\"flash\"}";
        return "{\"ok\":false,\"error\":\"focus-failed\"}";
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp | Out-Null
[FoxWin32]::SetProcessDPIAware() | Out-Null

# Console output must be UTF-8: window titles are UTF-16 in C#, but the default
# console encoding here is the ANSI code page (GBK), which garbles CJK titles.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$out = [Console]::Out
$out.WriteLine('{"ok":true,"ready":true,"pid":' + $PID + '}')
$out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    try {
        if ($line -eq 'snapshot') {
            $out.WriteLine([FoxWin32]::Snapshot())
        }
        elseif ($line -eq 'cursor') {
            $out.WriteLine([FoxWin32]::Cursor())
        }
        elseif ($line -eq 'ping') {
            $out.WriteLine('{"ok":true}')
        }
        elseif ($line -eq 'quit') {
            break
        }
        elseif ($line -match '^hit\s+(-?\d+)\s+(-?\d+)(?:\s+(\d+))?$') {
            $x = [int]$Matches[1]
            $y = [int]$Matches[2]
            $ex = 0
            if ($Matches[3]) { $ex = [int]$Matches[3] }
            $out.WriteLine([FoxWin32]::Hit($x, $y, $ex))
        }
        elseif ($line -match '^rect\s+([0-9a-fA-F]+)$') {
            $out.WriteLine([FoxWin32]::Rect($Matches[1]))
        }
        elseif ($line -match '^focus\s+([0-9a-fA-F]+)$') {
            $out.WriteLine([FoxWin32]::Focus($Matches[1]))
        }
        else {
            $out.WriteLine('{"ok":false,"error":"unknown-command"}')
        }
    }
    catch {
        $msg = $_.Exception.Message -replace '\\', '/' -replace '"', "'"
        $out.WriteLine('{"ok":false,"error":"' + $msg + '"}')
    }
    $out.Flush()
}
