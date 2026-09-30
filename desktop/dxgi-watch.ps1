# DXGI desktop-duplication pixel watcher -- freeze-detector sensor.
#
# The overlay can freeze at the compositor level: the renderer keeps producing
# frames (CDP/rAF all healthy) while the screen shows a stale frame. The page
# cannot see that; the only ground truth is the composed desktop itself. The
# page animates a tiny "liveness dot" on an OPAQUE pixel of the whale body
# (color phase flips every 700ms). On an opaque patch the composed pixels can
# only change when the overlay itself presents -- background apps animating
# behind the transparent parts cannot bleed in. So: healthy overlay => the
# watched 8x8 patch changes hash twice per second; frozen overlay => hash is
# constant even though the page reports the dot advancing.
#
# stdout protocol (one line per event, ASCII):
#   ready                       setup complete
#   pix <hash8> <HH:mm:ss.fff>  sampled the watched patch (every ~300ms a frame arrives)
#   tick                        heartbeat while bound but no samples flowing
#   blind <reason>              duplication unavailable (detection impossible)
#
# The watched rect is re-read from -RectFile (JSON {x,y,w,h}, physical desktop
# px) at most twice per second.
#
# COM calls go through raw vtable slots (Marshal.GetDelegateForFunctionPointer),
# NOT through [ComImport] RCWs: the RCW slot mapping for hand-declared DXGI
# inheritance chains proved unreliable on PS 5.1. Slots (counted mechanically
# from the d3d11/dxgi interface definitions): QI=0, factory.EnumAdapters=7,
# adapter.EnumOutputs=7, output.GetDesc=7, output1.DuplicateOutput=22,
# dup.AcquireNextFrame=8, dup.ReleaseFrame=14, dev.CreateTexture2D=5,
# dev.GetImmediateContext=40, ctx.Map=14, ctx.Unmap=15, ctx.CopyResource=47.
#
# DXGI_OUTPUT_DESC.DesktopCoordinates come back in the CALLING process's DPI
# virtualization space; the watcher receives physical px, so claim DPI
# awareness before touching DXGI.
param(
  [string]$RectFile = "",
  [int]$PumpMs = 200,
  [int]$SampleMs = 300
)

Add-Type -TypeDefinition @"
#pragma warning disable
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public struct DxRect { public int L, T, R, B; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DxgiOutputDesc {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
  public DxRect DesktopCoordinates;
  public int AttachedToDesktop;
  public int Rotation;
  public IntPtr Monitor;
}

[StructLayout(LayoutKind.Sequential)]
public struct DxgiFrameInfo {
  public uint LastPresentTime;
  public uint LastMouseUpdateTime;
  public uint AccumulatedFrames;
  public int RectsCoalesced;
  public uint ProtectedContentMaskedOut;
  public DxRect TotalDesktopSize;
}

[StructLayout(LayoutKind.Sequential)]
public struct D3D11Tex2DDesc {
  public uint Width, Height, MipLevels, ArraySize, Format;
  public uint SampleCount, SampleQuality;
  public uint Usage, BindFlags, CPUAccessFlags, MiscFlags;
}

[StructLayout(LayoutKind.Sequential)]
public struct D3D11MappedSubresource {
  public IntPtr pData;
  public uint RowPitch;
  public uint DepthPitch;
}

[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int QIFn(IntPtr self, ref Guid iid, out IntPtr outPtr);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int ReleaseFn(IntPtr self);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int EnumAdaptersFn(IntPtr self, uint adapter, out IntPtr ppAdapter);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int EnumOutputsFn(IntPtr self, uint output, out IntPtr ppOutput);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int GetDescFn(IntPtr self, ref DxgiOutputDesc pDesc);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int DuplicateOutputFn(IntPtr self, IntPtr device, out IntPtr ppDuplication);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int AcquireNextFrameFn(IntPtr self, uint timeoutMs, ref DxgiFrameInfo pInfo, out IntPtr ppDesktopResource);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int ReleaseFrameFn(IntPtr self);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int CreateDXGIFactory1Fn(ref Guid riid, out IntPtr ppFactory);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int D3D11CreateDeviceFn(IntPtr pAdapter, uint driverType, IntPtr software, uint flags, IntPtr featureLevels, uint featureLevelsCount, uint sdkVersion, out IntPtr ppDevice, out uint pFeatureLevel, out IntPtr ppContext);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate void GetCtxFn(IntPtr dev, out IntPtr ppContext);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int CreateTex2DFn(IntPtr dev, IntPtr pDesc, IntPtr pInitial, out IntPtr ppTex);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate void CopyResFn(IntPtr ctx, IntPtr dst, IntPtr src);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate int MapFn(IntPtr ctx, IntPtr res, uint subresource, uint mapType, uint mapFlags, out D3D11MappedSubresource mapped);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate void UnmapFn(IntPtr ctx, IntPtr res);
[UnmanagedFunctionPointer(CallingConvention.StdCall)]
delegate void DupDescFn(IntPtr self, IntPtr pDesc);

public static class DxgiWatch {
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr hModule, string name);
  [DllImport("kernel32.dll")] static extern IntPtr LoadLibraryA(string name);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  const int WAIT_TIMEOUT = unchecked((int)0x87A00027);
  const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;
  const uint D3D11_USAGE_STAGING = 3;
  const uint D3D11_CPU_ACCESS_READ = 0x20000;
  const uint D3D11_MAP_READ = 1;
  static Guid IID_IDXGIFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
  static Guid IID_IDXGIOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
  static Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

  static T Slot<T>(IntPtr comObj, int slot) {
    IntPtr vtbl = Marshal.ReadIntPtr(comObj);
    IntPtr fn = Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
  }
  static int QI(IntPtr comObj, ref Guid iid, out IntPtr outPtr) {
    QIFn f = Slot<QIFn>(comObj, 0);
    return f(comObj, ref iid, out outPtr);
  }
  static void Release(IntPtr comObj) {
    try { ReleaseFn f = Slot<ReleaseFn>(comObj, 2); f(comObj); } catch { }
  }

  static IntPtr dup;
  static IntPtr devPtr, ctxPtr, stagePtr;
  static int stageW, stageH;
  static int boundL, boundT, boundR, boundB;

  class WatchedRect { public int X, Y, W, H; public bool Valid; }
  static WatchedRect rect = new WatchedRect();
  static DateTime rectReadAt = DateTime.MinValue;

  static void Out(string s) { Console.WriteLine(s); }

  static void ReadRect(string rectFile) {
    if ((DateTime.Now - rectReadAt).TotalMilliseconds < 500) return;
    rectReadAt = DateTime.Now;
    try {
      string raw = File.ReadAllText(rectFile);
      string[] keys = { "x", "y", "w", "h" };
      int[] vals = new int[4];
      for (int i = 0; i < 4; i++) {
        int k = raw.IndexOf("\"" + keys[i] + "\"");
        if (k < 0) return;
        int colon = raw.IndexOf(':', k);
        int end = colon + 1;
        while (end < raw.Length && (char.IsDigit(raw[end]) || raw[end] == '-')) end++;
        if (!int.TryParse(raw.Substring(colon + 1, end - colon - 1), out vals[i])) return;
      }
      if (vals[2] > 0 && vals[3] > 0) { rect.X = vals[0]; rect.Y = vals[1]; rect.W = vals[2]; rect.H = vals[3]; rect.Valid = true; }
    } catch { }
  }

  static void TearDown() {
    if (dup != IntPtr.Zero) { Release(dup); dup = IntPtr.Zero; }
    if (stagePtr != IntPtr.Zero) { Release(stagePtr); stagePtr = IntPtr.Zero; }
    if (ctxPtr != IntPtr.Zero) { Release(ctxPtr); ctxPtr = IntPtr.Zero; }
    if (devPtr != IntPtr.Zero) { Release(devPtr); devPtr = IntPtr.Zero; }
  }

  static bool Bind(int cx, int cy) {
    TearDown();
    IntPtr dxgi = LoadLibraryA("dxgi.dll");
    IntPtr d3d11 = LoadLibraryA("d3d11.dll");
    if (dxgi == IntPtr.Zero || d3d11 == IntPtr.Zero) { Out("blind libs"); return false; }
    CreateDXGIFactory1Fn createFactory = (CreateDXGIFactory1Fn)(object)Marshal.GetDelegateForFunctionPointer(GetProcAddress(dxgi, "CreateDXGIFactory1"), typeof(CreateDXGIFactory1Fn));
    D3D11CreateDeviceFn createDevice = (D3D11CreateDeviceFn)(object)Marshal.GetDelegateForFunctionPointer(GetProcAddress(d3d11, "D3D11CreateDevice"), typeof(D3D11CreateDeviceFn));

    IntPtr facPtr;
    int hr = createFactory(ref IID_IDXGIFactory1, out facPtr);
    if (hr != 0 || facPtr == IntPtr.Zero) { Out("blind createfactory 0x" + hr.ToString("X8")); return false; }
    string detail = "";
    try {
      for (uint ai = 0; ; ai++) {
        EnumAdaptersFn enumAdapters = Slot<EnumAdaptersFn>(facPtr, 7);
        IntPtr adPtr;
        hr = enumAdapters(facPtr, ai, out adPtr);
        if (hr != 0) { detail = " enumAdapter" + ai + "=0x" + hr.ToString("X8"); break; }
        for (uint oi = 0; ; oi++) {
          EnumOutputsFn enumOutputs = Slot<EnumOutputsFn>(adPtr, 7);
          IntPtr outPtr;
          hr = enumOutputs(adPtr, oi, out outPtr);
          if (hr != 0) { detail += " enumOutput" + oi + "=0x" + hr.ToString("X8"); break; }
          GetDescFn getDesc = Slot<GetDescFn>(outPtr, 7);
          DxgiOutputDesc desc = new DxgiOutputDesc();
          int hrDesc = getDesc(outPtr, ref desc);
          if (hrDesc != 0) { detail += " getdesc=0x" + hrDesc.ToString("X8"); Release(outPtr); continue; }
          detail += " out=(" + desc.DesktopCoordinates.L + "," + desc.DesktopCoordinates.T + ")-(" + desc.DesktopCoordinates.R + "," + desc.DesktopCoordinates.B + ")";
          if (cx >= desc.DesktopCoordinates.L && cx < desc.DesktopCoordinates.R && cy >= desc.DesktopCoordinates.T && cy < desc.DesktopCoordinates.B) {
            // driverType 0 = D3D_DRIVER_TYPE_UNKNOWN (adapter is given); flags 0x20 = BGRA_SUPPORT
            uint fl;
            int hrD = createDevice(adPtr, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out devPtr, out fl, out ctxPtr);
            if (hrD != 0 || devPtr == IntPtr.Zero) { Out("blind d3ddevice 0x" + hrD.ToString("X8")); Release(outPtr); Release(adPtr); return false; }
            IntPtr out1Ptr;
            if (QI(outPtr, ref IID_IDXGIOutput1, out out1Ptr) != 0) { Out("blind output1-qi"); Release(outPtr); Release(adPtr); return false; }
            Release(outPtr);
            DuplicateOutputFn duplicate = Slot<DuplicateOutputFn>(out1Ptr, 22);
            IntPtr dupTmp;
            int hrDup = duplicate(out1Ptr, devPtr, out dupTmp);
            Release(out1Ptr);
            if (hrDup != 0 || dupTmp == IntPtr.Zero) { Out("blind duplicate 0x" + hrDup.ToString("X8") + detail); Release(adPtr); return false; }
            dup = dupTmp;
            // staging texture covering the whole output (CopyResource needs identical bounds).
            // format comes from the duplication description (offset 16 of DXGI_OUTDUPL_DESC)
            DupDescFn dupDesc = Slot<DupDescFn>(dup, 7);
            IntPtr descBuf = Marshal.AllocHGlobal(64);
            dupDesc(dup, descBuf);
            uint dupFormat = (uint)Marshal.ReadInt32(descBuf, 16);
            Marshal.FreeHGlobal(descBuf);
            GetCtxFn getCtx = Slot<GetCtxFn>(devPtr, 40);
            getCtx(devPtr, out ctxPtr);
            stageW = desc.DesktopCoordinates.R - desc.DesktopCoordinates.L;
            stageH = desc.DesktopCoordinates.B - desc.DesktopCoordinates.T;
            D3D11Tex2DDesc td = new D3D11Tex2DDesc();
            td.Width = (uint)stageW; td.Height = (uint)stageH;
            td.MipLevels = 1; td.ArraySize = 1;
            td.Format = (dupFormat == 0 || dupFormat > 200) ? DXGI_FORMAT_B8G8R8A8_UNORM : dupFormat;
            td.SampleCount = 1; td.SampleQuality = 0;
            td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0;
            td.CPUAccessFlags = D3D11_CPU_ACCESS_READ; td.MiscFlags = 0;
            IntPtr tdNative = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(D3D11Tex2DDesc)));
            try {
              Marshal.StructureToPtr(td, tdNative, false);
              CreateTex2DFn createTex = Slot<CreateTex2DFn>(devPtr, 5);
              int hrT = createTex(devPtr, tdNative, IntPtr.Zero, out stagePtr);
              if (hrT != 0 || stagePtr == IntPtr.Zero) { Out("blind staging 0x" + hrT.ToString("X8")); Release(adPtr); return false; }
            } finally { Marshal.FreeHGlobal(tdNative); }
            boundL = desc.DesktopCoordinates.L; boundT = desc.DesktopCoordinates.T;
            boundR = desc.DesktopCoordinates.R; boundB = desc.DesktopCoordinates.B;
            Out("pixfmt " + td.Format);
            Release(adPtr);
            return true;
          }
          Release(outPtr);
        }
        Release(adPtr);
      }
      Out("blind no-output" + detail + " point=" + cx + "," + cy);
    } finally { Release(facPtr); }
    return false;
  }

  static long lastSample = 0;
  static bool firstDebug = true;

  public static void Run(string rectFile, int pumpMs, int sampleMs) {
    SetProcessDPIAware();
    Out("ready");
    while (true) {
      try {
        ReadRect(rectFile);
        if (!rect.Valid) { Thread.Sleep(250); continue; }
        int cx = rect.X + rect.W / 2, cy = rect.Y + rect.H / 2;
        if (dup == IntPtr.Zero || cx < boundL || cx >= boundR || cy < boundT || cy >= boundB) {
          TearDown();
          if (!Bind(cx, cy)) { Thread.Sleep(1500); continue; }
        }
        AcquireNextFrameFn acquire = Slot<AcquireNextFrameFn>(dup, 8);
        DxgiFrameInfo info = new DxgiFrameInfo();
        IntPtr res;
        int hr = acquire(dup, (uint)pumpMs, ref info, out res);
        if (hr == WAIT_TIMEOUT) continue;
        if (hr != 0) {
          Out("blind acquire 0x" + hr.ToString("X8"));
          TearDown();
          Thread.Sleep(1500);
          continue;
        }
        long now = Environment.TickCount;
        if (stagePtr != IntPtr.Zero && now - lastSample >= sampleMs) {
          lastSample = now;
          // AcquireNextFrame hands out an IDXGIResource pointer; CopyResource
          // needs the ID3D11Resource view of the same object (official desktop
          // duplication sample does this QI to ID3D11Texture2D)
          IntPtr texPtr;
          if (QI(res, ref IID_ID3D11Texture2D, out texPtr) != 0) { Out("blind tex-qi"); }
          else {
            try {
              CopyResFn copyRes = Slot<CopyResFn>(ctxPtr, 47);
              copyRes(ctxPtr, stagePtr, texPtr);
              MapFn map = Slot<MapFn>(ctxPtr, 14);
              D3D11MappedSubresource mapped;
              int hrM = map(ctxPtr, stagePtr, 0, D3D11_MAP_READ, 0, out mapped);
              if (hrM == 0) {
                try {
                  if (firstDebug) {
                    firstDebug = false;
                    byte[] head = new byte[16];
                    Marshal.Copy(mapped.pData, head, 0, 16);
                    Out("pixhead " + BitConverter.ToString(head).Replace("-", ""));
                  }
                  int lx = rect.X + rect.W / 2 - 4 - boundL;
                  int ly = rect.Y + rect.H / 2 - 4 - boundT;
                  if (lx < 0) lx = 0; if (ly < 0) ly = 0;
                  if (lx > stageW - 8) lx = stageW - 8;
                  if (ly > stageH - 8) ly = stageH - 8;
                  uint h = 2166136261;
                  for (int y = 0; y < 8; y++) {
                    IntPtr row = new IntPtr(mapped.pData.ToInt64() + (long)(ly + y) * mapped.RowPitch + (long)lx * 4);
                    for (int x = 0; x < 8; x++) {
                      for (int b = 0; b < 3; b++) {
                        uint v = (uint)Marshal.ReadByte(row, x * 4 + b);
                        h = (h ^ v) * 16777619;
                      }
                    }
                  }
                  Out("pix " + h.ToString("X8") + " " + DateTime.Now.ToString("HH:mm:ss.fff"));
                } finally { UnmapFn unmap = Slot<UnmapFn>(ctxPtr, 15); unmap(ctxPtr, stagePtr); }
              } else {
                Out("blind map 0x" + hrM.ToString("X8"));
              }
            } finally { Release(texPtr); }
          }
        }
        ReleaseFrameFn releaseFrame = Slot<ReleaseFrameFn>(dup, 14);
        releaseFrame(dup);
      } catch (Exception e) {
        Out("blind " + e.Message);
        TearDown();
        Thread.Sleep(1500);
      }
    }
  }
}
"@

[DxgiWatch]::Run($RectFile, $PumpMs, $SampleMs)
