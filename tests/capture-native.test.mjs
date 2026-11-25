import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCaptureService } = require('../desktop/capture.cjs');
const execFileAsync = promisify(execFile);
const powershell = process.env.HEX_TEST_POWERSHELL || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const available = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 15000, windowsHide: true }).status === 0;
const source = (await readFile(new URL('../desktop/recognize.ps1', import.meta.url), 'utf8')).replace(/^\uFEFF/, '');
const nativeSource = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@ -ReferencedAssemblies System.Drawing/)[1];
const writerSource = source.slice(source.indexOf('function Write-Response('), source.indexOf('while ($null -ne ($inputLine'));
const base64Expression = source.match(/\$metadata\.imageBase64=(\[Convert\]::ToBase64String\([^\r\n]+\))/)[1];
const missingShell = available ? false : 'PowerShell unavailable; set HEX_TEST_POWERSHELL, or run on Windows PowerShell 5.1';

async function fixture(t, text) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hex-capture-native-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture.ps1');
  await writeFile(file, '\uFEFF' + text);
  return file;
}

function nativeBootstrap(extraSource = '') {
  // The same C# source is compiled on both runtimes. PS7 uses explicit reference
  // assemblies; Windows PowerShell 5.1 uses its original .NET Framework defaults.
  return `$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$native = @'
${nativeSource}
${extraSource}
'@
if ($PSVersionTable.PSEdition -eq 'Core') {
  $references = @((Get-ChildItem (Join-Path $PSHOME 'ref/*.dll')).FullName)
  $references += Join-Path $PSHOME 'System.Drawing.Common.dll'
  Add-Type -TypeDefinition $native -ReferencedAssemblies $references -CompilerOptions '/langversion:5'
} else {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition $native -ReferencedAssemblies System.Drawing
}
`;
}

test('PowerShell parses the complete production helper without executing capture', { skip: missingShell, timeout: 30000 }, async t => {
  const file = await fixture(t, `param([string]$SourcePath)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($SourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw ($errors | Out-String) }
[Console]::WriteLine('helper syntax passed')
`);
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, path.resolve('desktop/recognize.ps1')], { timeout: 30000, windowsHide: true });
  assert.match(stdout, /helper syntax passed/);
});

test('actual PowerShell writer streams large base64 through the production JSONL client', { skip: missingShell, timeout: 60000 }, async t => {
  const file = await fixture(t, `$ErrorActionPreference='Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
${writerSource}
$payload=New-Object byte[] (4*1024*1024+7)
(New-Object System.Random(17)).NextBytes($payload)
$pngStream=New-Object System.IO.MemoryStream(9000000)
$pngStream.Write($payload,0,$payload.Length)
$encoded=${base64Expression}
$hash=[Security.Cryptography.SHA256]::Create()
$digest=[BitConverter]::ToString($hash.ComputeHash($payload)).Replace('-','').ToLowerInvariant()
$hash.Dispose(); $pngStream.Dispose()
while ($null -ne ($line=[Console]::ReadLine())) {
  $request=$line | ConvertFrom-Json
  $response=@{ id=$request.id; ok=$true }
  switch ($request.action) {
    'listWindows' { $response.result=@(@{id='123';title='游戏 "quoted" \\ path';width=2560;height=1440}) }
    'inspectWindow' { $response.result=[pscustomobject]@{windowId='123';foreground=$true} }
    'capturePixels' {
      $response.result=@{windowId='123';width=2560;height=1440;crop=@{x=0;y=0;width=2560;height=1440};
        foreground=$true;bounds=@{x=-2560;y=0;width=2560;height=1440};
        fingerprint='2560x1440:'+('A'*64);payloadBytes=$payload.Length;payloadSha256=$digest;unchanged=$false}
      if ($request.skipUnchanged) { $response.result.unchanged=$true }
      else { $response.result.imageBase64=$encoded }
      if ($request.windowId -eq '124') { $response.result=@{imageBase64=$encoded} }
    }
    default { $response=@{id=$request.id;ok=$false;error=@{code='FRAME_EMPTY';message='暂时没有有效像素';transient=$true;category='capture-unavailable'}} }
  }
  $hadPixels=$response.ok -eq $true -and $response.result -is [Collections.IDictionary] -and $response.result.ContainsKey('imageBase64')
  Write-Response $response
  if ($hadPixels -and $response.result.ContainsKey('imageBase64')) { throw 'completed response retained its image' }
}
`);
  const service = createCaptureService({ platform: 'win32', powershellPath: powershell, scriptPath: file });
  t.after(() => service.stop());
  const windows = await service.listWindows();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].title, '游戏 "quoted" \\ path');
  assert.equal((await service.inspectWindow('123')).foreground, true);
  const shot = await service.captureWindow('123');
  const bytes = Buffer.from(shot.imageBase64, 'base64');
  assert.equal(bytes.length, 4 * 1024 * 1024 + 7, 'stream capacity must never become payload');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.payloadSha256);
  assert.deepEqual(shot.bounds, { x: -2560, y: 0, width: 2560, height: 1440 });
  const cached = await service.captureWindow('123', { skipUnchanged: true, previousFingerprint: shot.fingerprint });
  assert.equal(cached.unchanged, true);
  assert.equal(cached.imageBase64, undefined);
  const imageOnly = await service.captureWindow('124');
  assert.deepEqual(Object.keys(imageOnly), ['imageBase64']);
  assert.equal(imageOnly.imageBase64, shot.imageBase64, 'an otherwise empty metadata object needs no leading comma');
  await assert.rejects(service.pollHotkeys('123'), { code: 'FRAME_EMPTY', transient: true, category: 'capture-unavailable' });
});

const pixelTests = `
public static class CapturePixelRegression {
    static System.Reflection.MethodInfo analyze = typeof(HexCaptureNative).GetMethod("AnalyzePixels", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic);
    static HexCaptureNative.PixelAnalysis Actual(IntPtr pointer, int stride, int width, int height) {
        return (HexCaptureNative.PixelAnalysis)analyze.Invoke(null, new object[] { pointer, stride, width, height });
    }
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static string Reference(byte[] physical, int origin, int stride, int width, int height) {
        byte[] canonical = new byte[width*height*4];
        for (int row=0; row<height; row++) Array.Copy(physical, origin+row*stride, canonical, row*width*4, width*4);
        for (int i=3; i<canonical.Length; i+=4) canonical[i]=0;
        using (var hash=SHA256.Create()) return width+"x"+height+":"+BitConverter.ToString(hash.ComputeHash(canonical)).Replace("-", "");
    }
    static void ImageCase(int width, int height, int padding, bool reverse) {
        int stride=width*4+padding, length=stride*height, origin=reverse ? (height-1)*stride : 0;
        if (reverse) stride=-stride;
        byte[] physical=new byte[length]; new Random(31).NextBytes(physical);
        IntPtr allocation=Marshal.AllocHGlobal(length), pointer=IntPtr.Add(allocation,origin);
        try {
            Marshal.Copy(physical,0,allocation,length);
            var initial=Actual(pointer,stride,width,height);
            Check(initial.visible,"colored image was empty");
            Check(initial.fingerprint==Reference(physical,origin,stride,width,height),"fingerprint differs from old full-frame SHA256");
            // Neither undefined alpha nor row padding may create new evidence.
            for (int row=0; row<height; row++) {
                for (int col=3; col<width*4; col+=4) physical[origin+row*stride+col]^=255;
                if (padding>0) physical[origin+row*stride+width*4]^=255;
            }
            Marshal.Copy(physical,0,allocation,length);
            Check(Actual(pointer,stride,width,height).fingerprint==initial.fingerprint,"alpha/padding changed evidence");
            // A single RGB byte at the far end of a 1440p image must be noticed.
            physical[origin+(height-1)*stride+(width-1)*4]^=255;
            Marshal.Copy(physical,0,allocation,length);
            var changed=Actual(pointer,stride,width,height);
            Check(changed.fingerprint!=initial.fingerprint,"missed changed edge pixel");
            Check(changed.fingerprint==Reference(physical,origin,stride,width,height),"changed image hash differs");
        } finally { Marshal.FreeHGlobal(allocation); }
    }
    public static string Run() {
        ImageCase(2560,1440,0,false);
        ImageCase(17,13,16,false);
        ImageCase(17,13,16,true);
        ImageCase(2,2,0,false);
        byte[] dark=new byte[80*40*4];
        for(int i=0;i<dark.Length;i+=4) {dark[i]=14;dark[i+1]=14;dark[i+2]=14;dark[i+3]=255;}
        IntPtr memory=Marshal.AllocHGlobal(dark.Length);
        try {
            Marshal.Copy(dark,0,memory,dark.Length);
            Check(!Actual(memory,320,80,40).visible,"alpha or dim RGB counted as visible");
            dark[dark.Length-4]=15;
            Marshal.Copy(dark,0,memory,dark.Length);
            Check(Actual(memory,320,80,40).visible,"bright final pixel missed");
        } finally { Marshal.FreeHGlobal(memory); }
        byte[] scratch=(byte[])typeof(HexCaptureNative).GetField("analysisBuffer",System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic).GetValue(null);
        Check(scratch.Length==65536,"scratch allocation not bounded");
        foreach(byte value in scratch) Check(value==0,"scratch retains image bytes after request");
        return "1440p full SHA256, alpha, padded/negative stride, changed edge, empty threshold, bounded cleared scratch passed";
    }
}
`;

test('production C# analysis preserves full pixel evidence with bounded scratch memory', { skip: missingShell, timeout: 60000 }, async t => {
  const file = await fixture(t, nativeBootstrap(pixelTests) + '[Console]::WriteLine([CapturePixelRegression]::Run())');
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.match(stdout, /1440p full SHA256.*passed/);
});

test('Windows GDI bitmap analysis and PNG encoding preserve 1440p dimensions', { skip: process.platform !== 'win32' ? 'requires actual Windows System.Drawing/GDI+' : missingShell, timeout: 60000 }, async t => {
  const file = await fixture(t, nativeBootstrap() + `
$bitmap=New-Object Drawing.Bitmap(2560,1440,[Drawing.Imaging.PixelFormat]::Format32bppRgb)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::FromArgb(29,71,113))
$graphics.Dispose()
$analysis=[HexCaptureNative]::Analyze($bitmap)
if (-not $analysis.visible) { throw 'solid bitmap detected as empty' }
$pngStream=New-Object IO.MemoryStream(1000000)
$image=$bitmap
$image.Save($pngStream,[System.Drawing.Imaging.ImageFormat]::Png)
$encoded=${base64Expression}
$decoded=[Convert]::FromBase64String($encoded)
if ($decoded.Length -ne $pngStream.Length) { throw 'PNG includes unused capacity' }
$readStream=New-Object IO.MemoryStream(,$decoded)
$restored=[Drawing.Image]::FromStream($readStream)
if ($restored.Width -ne 2560 -or $restored.Height -ne 1440) { throw '1440p dimensions changed' }
if ($restored.GetPixel(2559,1439).A -ne 255) { throw 'PNG not opaque' }
$restored.Dispose();$readStream.Dispose();$pngStream.Dispose();$bitmap.Dispose()
[Console]::WriteLine('Windows bitmap/PNG passed')
`);
  const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { timeout: 60000, windowsHide: true });
  assert.match(stdout, /Windows bitmap\/PNG passed/);
});
