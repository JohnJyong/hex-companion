# Windows PowerShell 5.1 helper. JSON lines in, JSON lines out.
# Captures only the explicitly selected window's visible client rectangle.
# Images exist only in memory. There is no file output or network access.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$script:BootstrapError = $null

function Fail([string]$Code, [string]$Message, $WindowState = $null) {
    $exception = New-Object System.Exception($Message)
    $exception.Data['code'] = $Code
    if ($null -ne $WindowState) { $exception.Data['windowState'] = $WindowState }
    throw $exception
}

try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Security.Cryptography;

public static class HexCaptureNative {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    public static void EnsureThreadDpiAwareness() {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
    }

    public sealed class Bounds { public int x, y, width, height; }
    public sealed class WindowState {
        public string windowId;
        public bool valid, foreground, minimized, visible;
        public Bounds bounds;
    }
    static IntPtr Root(IntPtr handle, uint flag) {
        IntPtr root = GetAncestor(handle, flag);
        return root == IntPtr.Zero ? handle : root;
    }
    public static bool IsSelectedForeground(IntPtr target) {
        IntPtr active = GetForegroundWindow();
        if (active == IntPtr.Zero || !IsWindow(target)) return false;
        if (Root(active, 2) == Root(target, 2)) return true;
        uint activePid, targetPid;
        GetWindowThreadProcessId(active, out activePid);
        GetWindowThreadProcessId(target, out targetPid);
        // Only an owned foreground popup from the same application counts.
        // A different application or unrelated same-process window never does.
        return activePid == targetPid && Root(active, 3) == Root(target, 3);
    }
    public static WindowState InspectWindow(IntPtr handle) {
        EnsureThreadDpiAwareness();
        var state = new WindowState { windowId=handle.ToInt64().ToString(), valid=IsWindow(handle) };
        if (!state.valid) return state;
        state.visible=IsWindowVisible(handle); state.minimized=IsIconic(handle);
        state.foreground=state.visible && !state.minimized && IsSelectedForeground(handle);
        RECT rect; POINT point = new POINT();
        if (GetClientRect(handle, out rect) && ClientToScreen(handle, ref point))
            state.bounds=new Bounds { x=point.X, y=point.Y, width=rect.Right-rect.Left, height=rect.Bottom-rect.Top };
        return state;
    }
    public static WindowState ForegroundLeagueClient() {
        IntPtr active = GetForegroundWindow();
        if (active == IntPtr.Zero) return null;
        IntPtr handle = Root(active, 3);
        uint pid;
        GetWindowThreadProcessId(handle, out pid);
        try {
            using (var process = Process.GetProcessById((int)pid)) {
                if (!String.Equals(process.ProcessName, "LeagueClientUx", StringComparison.OrdinalIgnoreCase)) return null;
            }
        } catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (System.ComponentModel.Win32Exception) { return null; }
        var state = InspectWindow(handle);
        return state.foreground && state.bounds != null ? state : null;
    }
    public sealed class PixelAnalysis { public string fingerprint; public bool visible; }
    // The helper serializes requests. Thread-local scratch also keeps this method
    // safe when exercised from parallel callers, without a frame-sized LOH array.
    [ThreadStatic] static byte[] analysisBuffer;
    static readonly byte[] emptyBytes = new byte[0];
    static void HashChunk(HashAlgorithm hash, byte[] pixels, int count, ref bool visible) {
        // Stop checking brightness once any RGB pixel proves this is not an
        // empty frame. Alpha normalization still visits every captured pixel.
        if (!visible) {
            for (int i=0; i<count; i+=4) {
                if (pixels[i]>14 || pixels[i+1]>14 || pixels[i+2]>14) { visible=true; break; }
            }
        }
        for (int i=3; i<count; i+=4) pixels[i]=0;
        // Same input/output buffer avoids an additional copy in .NET Framework.
        hash.TransformBlock(pixels, 0, count, pixels, 0);
    }
    static PixelAnalysis AnalyzePixels(IntPtr scan0, int stride, int width, int height) {
        byte[] pixels = analysisBuffer ?? (analysisBuffer = new byte[65536]);
        int rowBytes = checked(width * 4);
        bool visible = false;
        try {
            using (var hash=SHA256.Create()) {
                if (stride == rowBytes) {
                    int total = checked(rowBytes * height);
                    for (int offset=0; offset<total; offset+=pixels.Length) {
                        int count = Math.Min(pixels.Length, total-offset);
                        Marshal.Copy(IntPtr.Add(scan0, offset), pixels, 0, count);
                        HashChunk(hash, pixels, count, ref visible);
                    }
                } else {
                    // Preserve logical row order, including negative stride;
                    // row padding is not image evidence and must not be hashed.
                    for (int row=0; row<height; row++) {
                        for (int offset=0; offset<rowBytes; offset+=pixels.Length) {
                            int count = Math.Min(pixels.Length, rowBytes-offset);
                            Marshal.Copy(IntPtr.Add(scan0, checked(row*stride+offset)), pixels, 0, count);
                            HashChunk(hash, pixels, count, ref visible);
                        }
                    }
                }
                hash.TransformFinalBlock(emptyBytes, 0, 0);
                return new PixelAnalysis { visible=visible,
                    fingerprint=width+"x"+height+":"+BitConverter.ToString(hash.Hash).Replace("-", "") };
            }
        } finally {
            // Reuse the allocation, but do not retain pixels between requests.
            Array.Clear(pixels, 0, pixels.Length);
        }
    }
    public static PixelAnalysis Analyze(Bitmap bitmap) {
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        BitmapData bits = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
        try { return AnalyzePixels(bits.Scan0, bits.Stride, bitmap.Width, bitmap.Height); }
        finally { bitmap.UnlockBits(bits); }
    }
    static bool[] previousKeys = new bool[4];
    static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    public static string[] PollHotkeys(bool enabled) {
        bool modified=Down(0x11) && Down(0x12);
        bool[] current={ (modified && Down(0x48)) || Down(0x77), modified && Down(0x31), modified && Down(0x32), modified && Down(0x33) };
        string[] actions={ "toggle", "slot-0", "slot-1", "slot-2" };
        var pressed=new List<string>();
        for (int i=0; i<current.Length; i++) {
            if (enabled && current[i] && !previousKeys[i]) pressed.Add(actions[i]);
            previousKeys[i]=current[i];
        }
        return pressed.ToArray();
    }

    public sealed class WindowEntry {
        public string id, title, processName;
        public int width, height;
        public bool minimized, isGame;
    }
    public static WindowEntry[] ListWindows() {
        EnsureThreadDpiAwareness();
        var windows = new List<WindowEntry>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr extra) {
            if (!IsWindowVisible(hwnd)) return true;
            var text = new StringBuilder(1024);
            GetWindowText(hwnd, text, text.Capacity);
            var title = text.ToString();
            if (String.IsNullOrWhiteSpace(title)) return true;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string name;
            try { name = Process.GetProcessById((int)pid).ProcessName; }
            catch { return true; }
            if (name.Equals("HexCompanion", StringComparison.OrdinalIgnoreCase) ||
                name.Equals("Electron", StringComparison.OrdinalIgnoreCase) ||
                title.Contains("海克斯参谋") || name.Equals("powershell", StringComparison.OrdinalIgnoreCase)) return true;
            RECT rect;
            if (!GetClientRect(hwnd, out rect)) return true;
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width < 200 || height < 150) return true;
            bool game = name.Equals("League of Legends", StringComparison.OrdinalIgnoreCase);
            windows.Add(new WindowEntry { id=hwnd.ToInt64().ToString(), title=title, processName=name,
                width=width, height=height, minimized=IsIconic(hwnd), isGame=game });
            return true;
        }, IntPtr.Zero);
        windows.Sort((a,b) => { int game = b.isGame.CompareTo(a.isGame); return game != 0 ? game : String.Compare(a.title,b.title,StringComparison.OrdinalIgnoreCase); });
        return windows.ToArray();
    }
}
'@ -ReferencedAssemblies System.Drawing
    try { if (-not [HexCaptureNative]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $null = [HexCaptureNative]::SetProcessDPIAware() } }
    catch { $null = [HexCaptureNative]::SetProcessDPIAware() }
} catch {
    $script:BootstrapError = $_.Exception.Message
}

function Get-CaptureCapabilities {
    if ($null -ne $script:BootstrapError) {
        return @{ available=$false; platform='win32'; engine='GDI'; code='WINDOWS_COMPONENT_MISSING';
            message='Windows 截图组件初始化失败，请确认系统为 Windows 10 / 11 且 PowerShell 与 .NET 可用。' }
    }
    return @{ available=$true; platform='win32'; engine='GDI';
        message='本地截图已就绪。请使用窗口或无边框模式，将游戏置于前台；被遮挡的区域无法可靠识别。' }
}

function Read-WindowState($Request) {
    if ($null -ne $script:BootstrapError) { Fail 'WINDOWS_COMPONENT_MISSING' 'Windows 截图组件无法初始化，请确认 PowerShell 与 .NET 组件正常' }
    $handleText = [string]$Request.windowId
    if ($handleText -notmatch '^[1-9][0-9]{0,18}$') { Fail 'INVALID_WINDOW' '请选择有效的游戏窗口' }
    return [HexCaptureNative]::InspectWindow([IntPtr]([long]$handleText))
}

function Capture-Pixels($Request) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $state = Read-WindowState $Request
    $handleText = $state.windowId
    $handle = [IntPtr]([long]$handleText)
    if (-not $state.valid) { Fail 'WINDOW_CLOSED' '所选游戏窗口已关闭，请重新选择窗口' $state }
    if ($state.minimized -or -not $state.visible) { Fail 'WINDOW_MINIMIZED' '游戏已最小化，等待恢复窗口' $state }
    if (-not $state.foreground) { Fail 'WINDOW_NOT_FOREGROUND' '游戏暂未在前台，等待切回游戏' $state }
    if ($Request.action -eq 'champSelectPixels' -and ([HexCaptureNative]::ForegroundLeagueClient()).windowId -ne $handleText) { Fail 'WINDOW_NOT_FOREGROUND' '等待选人客户端处于前台' $state }
    if ($null -eq $state.bounds) { Fail 'WINDOW_UNAVAILABLE' '无法读取游戏窗口位置' $state }
    $sourceWidth = $state.bounds.width
    $sourceHeight = $state.bounds.height
    if ($sourceWidth -lt 200 -or $sourceHeight -lt 150) { Fail 'WINDOW_TOO_SMALL' '所选窗口过小，无法识别海克斯选项' $state }
    $cropX = 0; $cropY = 0; $cropWidth = $sourceWidth; $cropHeight = $sourceHeight
    if ($null -ne $Request.roi) {
        $roi = $Request.roi
        $x = [double]$roi.x; $y = [double]$roi.y; $w = [double]$roi.width; $h = [double]$roi.height
        if ([double]::IsNaN($x) -or [double]::IsNaN($y) -or [double]::IsNaN($w) -or [double]::IsNaN($h) -or $x -lt 0 -or $y -lt 0 -or $w -le 0 -or $h -le 0 -or ($x+$w) -gt 1 -or ($y+$h) -gt 1) { Fail 'INVALID_ROI' '识别区域必须位于所选窗口内部' }
        $cropX = [int][Math]::Floor($sourceWidth * $x)
        $cropY = [int][Math]::Floor($sourceHeight * $y)
        $cropWidth = [int][Math]::Floor($sourceWidth * $w)
        $cropHeight = [int][Math]::Floor($sourceHeight * $h)
    }
    if ($cropWidth -lt 50 -or $cropHeight -lt 30) { Fail 'WINDOW_TOO_SMALL' '所选识别区域过小' }
    $screenX = $state.bounds.x + $cropX; $screenY = $state.bounds.y + $cropY
    $vx = [HexCaptureNative]::GetSystemMetrics(76); $vy = [HexCaptureNative]::GetSystemMetrics(77)
    $vw = [HexCaptureNative]::GetSystemMetrics(78); $vh = [HexCaptureNative]::GetSystemMetrics(79)
    if ($screenX -lt $vx -or $screenY -lt $vy -or $screenX+$cropWidth -gt $vx+$vw -or $screenY+$cropHeight -gt $vy+$vh) { Fail 'WINDOW_OFFSCREEN' '请将游戏窗口完整移动到屏幕内再识别' $state }

    $bitmap = $null; $graphics = $null; $resized = $null; $scaleGraphics = $null; $pngStream = $null
    try {
        $bitmap = New-Object System.Drawing.Bitmap($cropWidth, $cropHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($screenX, $screenY, 0, 0, (New-Object System.Drawing.Size($cropWidth, $cropHeight)), [System.Drawing.CopyPixelOperation]::SourceCopy)
        $graphics.Dispose(); $graphics = $null
        # Drop a frame if the user switched applications during the copy.
        if (-not [HexCaptureNative]::IsSelectedForeground($handle)) { Fail 'WINDOW_NOT_FOREGROUND' '游戏暂未在前台，等待切回游戏' ([HexCaptureNative]::InspectWindow($handle)) }
        # Preserve 1080p text detail. Bound very large/portrait frames so an
        # incompressible PNG plus base64 remains below the 32 MiB protocol cap.
        $scale = [Math]::Min(1.0, 2560.0 / [Math]::Max($cropWidth, $cropHeight))
        $scale = [Math]::Min($scale, [Math]::Sqrt(4000000.0 / ([double]$cropWidth * $cropHeight)))
        $width = [int][Math]::Max(1, [Math]::Floor($cropWidth * $scale))
        $height = [int][Math]::Max(1, [Math]::Floor($cropHeight * $scale))
        $image = $bitmap
        if ($scale -lt 1) {
            $resized = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
            $scaleGraphics = [System.Drawing.Graphics]::FromImage($resized)
            $scaleGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scaleGraphics.DrawImage($bitmap, 0, 0, $width, $height)
            $scaleGraphics.Dispose(); $scaleGraphics = $null
            $image = $resized
        }
        $analysis = [HexCaptureNative]::Analyze($image)
        if (-not $analysis.visible) { Fail 'FRAME_EMPTY' '游戏截图未包含有效像素，正在等待下一帧' $state }
        $after = [HexCaptureNative]::InspectWindow($handle)
        if (-not $after.foreground) { Fail 'WINDOW_NOT_FOREGROUND' '游戏暂未在前台，等待切回游戏' $after }
        if ($Request.action -eq 'champSelectPixels' -and ([HexCaptureNative]::ForegroundLeagueClient()).windowId -ne $handleText) { Fail 'WINDOW_NOT_FOREGROUND' '等待选人客户端处于前台' $after }
        if ($null -eq $after.bounds -or $after.bounds.x -ne $state.bounds.x -or $after.bounds.y -ne $state.bounds.y -or $after.bounds.width -ne $sourceWidth -or $after.bounds.height -ne $sourceHeight) { Fail 'WINDOW_MOVING' '游戏窗口位置变化，正在重新定位' $after }
        $metadata = @{ width=$width; height=$height; sourceWidth=$sourceWidth; sourceHeight=$sourceHeight;
            windowId=$handleText; foreground=$true; bounds=$state.bounds; clientBounds=$state.bounds;
            capturedAt=[DateTime]::UtcNow.ToString('o'); timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); scale=$scale; fingerprint=$analysis.fingerprint;
            crop=@{x=$cropX;y=$cropY;width=$cropWidth;height=$cropHeight}; engine='GDI' }
        if ($Request.skipUnchanged -eq $true -and [string]$Request.previousFingerprint -eq $analysis.fingerprint) {
            $metadata.unchanged=$true
            $metadata.timings=@{captureMs=$watch.ElapsedMilliseconds}
            return $metadata
        }
        # Format32bppRgb ensures the PNG is opaque regardless of the alpha bits
        # returned by the screen DC. Encode only to memory, never to a file.
        $pngStream = New-Object System.IO.MemoryStream
        $image.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
        # GetBuffer avoids copying the complete compressed PNG. Capacity can be
        # larger than Length, so encode only the bytes actually written by GDI+.
        $metadata.imageBase64=[Convert]::ToBase64String($pngStream.GetBuffer(), 0, [int]$pngStream.Length)
        $metadata.unchanged=$false
        $metadata.timings=@{captureMs=$watch.ElapsedMilliseconds}
        return $metadata
    } finally {
        foreach ($resource in @($graphics,$scaleGraphics,$pngStream,$resized,$bitmap)) {
            if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
        }
    }
}

function Write-Response($Response) {
    if ($Response.ok -eq $true -and $Response.result -is [System.Collections.IDictionary] -and $Response.result.ContainsKey('imageBase64')) {
        # Convert only metadata to JSON. Base64 comes from Convert.ToBase64String
        # above, whose alphabet needs no JSON escaping. This keeps JSONL intact
        # without creating another multi-megabyte escaped response string.
        $pixels = $Response.result.imageBase64
        $Response.result.Remove('imageBase64')
        try {
            $idJson = ConvertTo-Json -InputObject $Response.id -Depth 12 -Compress
            $metadataJson = ConvertTo-Json -InputObject $Response.result -Depth 12 -Compress
            [Console]::Write('{"id":' + $idJson + ',"ok":true,"result":')
            [Console]::Write($metadataJson.Substring(0, $metadataJson.Length - 1))
            if ($metadataJson.Length -gt 2) { [Console]::Write(',') }
            [Console]::Write('"imageBase64":"')
            [Console]::Write($pixels)
            [Console]::WriteLine('"}}')
        } finally {
            # Do not keep the completed frame on the response while stdin waits
            # for the next request. All image data remains memory-only.
            $pixels = $null
        }
    } else {
        [Console]::WriteLine(($Response | ConvertTo-Json -Depth 12 -Compress))
    }
    [Console]::Out.Flush()
}

while ($null -ne ($inputLine = [Console]::ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($inputLine)) { continue }
    $request = $null
    try {
        if ($inputLine.Length -gt 8192) { Fail 'INVALID_REQUEST' '截图请求过大' }
        $request = $inputLine | ConvertFrom-Json
        if ($request.action -eq 'capabilities') {
            $result = Get-CaptureCapabilities
        } elseif ($request.action -eq 'listWindows') {
            if ($null -ne $script:BootstrapError) { Fail 'WINDOWS_COMPONENT_MISSING' 'Windows 截图组件无法初始化，请确认 PowerShell 与 .NET 组件正常' }
            $result = @([HexCaptureNative]::ListWindows())
        } elseif ($request.action -eq 'champSelectForeground') {
            if ($null -ne $script:BootstrapError) { Fail 'WINDOWS_COMPONENT_MISSING' '无法读取英雄联盟客户端窗口' }
            $state = [HexCaptureNative]::ForegroundLeagueClient()
            $pressed = @([HexCaptureNative]::PollHotkeys($null -ne $state))
            $result = @{ client=$state; toggle=($pressed -contains 'toggle') }
        } elseif ($request.action -eq 'inspectWindow') {
            $result = Read-WindowState $request
        } elseif ($request.action -eq 'pollHotkeys') {
            $state = Read-WindowState $request
            $result = @{ pressed=@([HexCaptureNative]::PollHotkeys($state.foreground)); foreground=$state.foreground; focused=$state.foreground; windowState=$state; bounds=$state.bounds }
        } elseif ($request.action -eq 'capturePixels' -or $request.action -eq 'champSelectPixels') {
            $result = Capture-Pixels $request
        } else {
            Fail 'INVALID_REQUEST' '不支持的截图请求'
        }
        $response = @{ id=$request.id; ok=$true; result=$result }
    } catch {
        $code = $_.Exception.Data['code']
        if (-not $code) { $code = 'CAPTURE_ERROR' }
        $paused = @('WINDOW_NOT_FOREGROUND','WINDOW_MINIMIZED','WINDOW_MOVING','WINDOW_OFFSCREEN') -contains $code
        $transient = $paused -or (@('FRAME_EMPTY','CAPTURE_ERROR') -contains $code)
        $category = 'error'
        if ($paused) { $category = 'paused' } elseif (@('WINDOW_CLOSED','INVALID_WINDOW') -contains $code) { $category = 'invalid-window' } elseif ($code -eq 'FRAME_EMPTY') { $category = 'capture-unavailable' }
        $response = @{ id=$request.id; ok=$false; error=@{code=$code;message=$_.Exception.Message;transient=$transient;category=$category;windowState=$_.Exception.Data['windowState']} }
    }
    Write-Response $response
}
