'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function captureError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.transient = details.transient === true || (details.transient !== false && ['HELPER_IO', 'HELPER_EXIT', 'CAPTURE_TIMEOUT'].includes(code));
  error.category = typeof details.category === 'string' ? details.category : 'error';
  if (details.windowState && typeof details.windowState === 'object') error.windowState = details.windowState;
  return error;
}

function validateWindowId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw captureError('INVALID_WINDOW', '请选择一个有效的游戏窗口');
  }
  if (BigInt(value) > 0x7fffffffffffffffn) throw captureError('INVALID_WINDOW', '窗口标识超出范围');
  return value;
}

function validateRoi(value) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw captureError('INVALID_ROI', '识别区域格式不正确');
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw captureError('INVALID_ROI', '识别区域必须在所选窗口内，使用 0 至 1 的相对坐标');
  }
  return { x, y, width, height };
}

/**
 * Persistent local Windows capture worker. No screenshots are persisted or uploaded.
 * Each request is serialized; stop() cancels current and queued requests, while
 * a later explicit call may start a fresh helper. scriptPath must be unpacked
 * when this module lives in app.asar.
 */
function createCaptureService(options = {}) {
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;
  const scriptPath = options.scriptPath || path.join(__dirname, 'recognize.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const powershellPath = options.powershellPath || path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const timeoutMs = options.timeoutMs ?? 15000;
  let child = null;
  let pending = null;
  let buffer = '';
  let stderr = '';
  let nextId = 0;
  let generation = 0;
  let queued = 0;
  let tail = Promise.resolve();

  function killWorker(error) {
    const old = child;
    child = null;
    buffer = '';
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(error || captureError('CAPTURE_STOPPED', '自动识别已停止'));
    }
    if (old) {
      try { old.stdin.end(); } catch { /* already closed */ }
      try { old.kill(); } catch { /* already exited */ }
    }
  }

  function startWorker() {
    if (child) return child;
    if (platform !== 'win32') throw captureError('WINDOWS_REQUIRED', '画面自动识别仅支持 Windows 10 / 11');
    // All commands are fixed. Window identifiers and ROI go through stdin JSON,
    // never a command line or an evaluated PowerShell expression.
    const worker = spawnImpl(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = worker;
    buffer = '';
    stderr = '';
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdin.on('error', () => {
      if (child === worker) killWorker(captureError('HELPER_IO', '与本地截图程序的连接已中断'));
    });
    worker.stderr.on('data', data => { if (child === worker) stderr = (stderr + data).slice(-4096); });
    worker.stdout.on('data', data => {
      if (child !== worker) return;
      buffer += data;
      if (buffer.length > 32 * 1024 * 1024) {
        killWorker(captureError('HELPER_PROTOCOL', '截图程序返回的数据过大，请缩小识别区域后重试'));
        return;
      }
      // PNG base64 contains no newlines; avoid rescanning the growing image
      // response on every pipe chunk.
      if (!data.includes('\n')) return;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/^\uFEFF/, '').trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { killWorker(captureError('HELPER_PROTOCOL', '本地截图程序返回了无效响应，请重新开启识别')); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          killWorker(captureError('HELPER_PROTOCOL', '本地截图程序返回了无效响应，请重新开启识别')); return;
        }
        if (!pending || message.id !== pending.id) continue;
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        if (message.ok === true) current.resolve(message.result);
        else current.reject(captureError(String(message.error?.code || 'CAPTURE_ERROR'), String(message.error?.message || '本地截图失败，请检查游戏窗口是否可见'), message.error || {}));
      }
    });
    worker.on('error', () => {
      if (child === worker) killWorker(captureError('HELPER_IO', '无法启动 Windows PowerShell 截图程序，请确认系统组件可用'));
    });
    worker.on('exit', () => {
      if (child === worker) killWorker(captureError('HELPER_EXIT', stderr.trim() ? '本地截图程序意外退出，请检查 Windows PowerShell 与 .NET 组件' : '本地截图程序已退出，正在等待重新启动'));
    });
    return worker;
  }

  function send(action, args, epoch) {
    if (epoch !== generation) return Promise.reject(captureError('CAPTURE_STOPPED', '自动识别已停止'));
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = startWorker(); } catch (error) { reject(error); return; }
      const id = ++nextId;
      const timer = setTimeout(() => killWorker(captureError('CAPTURE_TIMEOUT', '截图处理超时，下一轮将重新启动截图组件')), timeoutMs);
      pending = { id, resolve, reject, timer };
      const payload = JSON.stringify({ id, action, ...args }) + '\n';
      try {
        worker.stdin.write(payload, 'utf8', error => {
          if (error && child === worker) killWorker(captureError('HELPER_IO', '无法向本地截图程序发送请求'));
        });
      } catch {
        if (child === worker) killWorker(captureError('HELPER_IO', '无法向本地截图程序发送请求'));
      }
    });
  }

  function request(action, args = {}) {
    if (platform !== 'win32') return Promise.reject(captureError('WINDOWS_REQUIRED', '画面自动识别仅支持 Windows 10 / 11'));
    if (queued >= 8) return Promise.reject(captureError('CAPTURE_BUSY', '截图任务较多，请稍候再试'));
    const epoch = generation;
    queued++;
    const result = tail.then(async () => {
      try { return await send(action, args, epoch); }
      catch (error) {
        if (epoch === generation && ['HELPER_EXIT', 'HELPER_IO'].includes(error.code)) return send(action, args, epoch);
        throw error;
      }
    });
    tail = result.catch(() => {}).finally(() => { queued--; });
    return result;
  }

  return {
    async capabilities() {
      if (platform !== 'win32') return { available: false, platform, code: 'WINDOWS_REQUIRED', engine: 'GDI', message: '游戏画面截图仅支持 Windows 10 / 11；当前平台可使用手动输入与识别逻辑测试。' };
      return request('capabilities');
    },
    listWindows: () => request('listWindows'),
    champSelectForeground: () => request('champSelectForeground'),
    inspectWindow(windowId) {
      try { return request('inspectWindow', { windowId: validateWindowId(windowId) }); }
      catch (error) { return Promise.reject(error); }
    },
    // Use a separate service instance for polling so PNG encoding and captures
    // cannot block hotkeys. Consume these edges OR Electron shortcuts, not both.
    pollHotkeys(windowId) {
      try { return request('pollHotkeys', { windowId: validateWindowId(windowId) }); }
      catch (error) { return Promise.reject(error); }
    },
    captureWindow(windowId, settings = {}) {
      try {
        const previousFingerprint = typeof settings.previousFingerprint === 'string' && /^[0-9]+x[0-9]+:[a-f0-9]{64}$/i.test(settings.previousFingerprint) ? settings.previousFingerprint : undefined;
        return request(settings.leagueClientOnly===true?'champSelectPixels':'capturePixels', { windowId: validateWindowId(windowId), roi: validateRoi(settings.roi),
          previousFingerprint, skipUnchanged: settings.skipUnchanged === true && Boolean(previousFingerprint) });
      } catch (error) { return Promise.reject(error); }
    },
    stop() { generation++; killWorker(captureError('CAPTURE_STOPPED', '自动识别已停止')); },
  };
}

module.exports = { createCaptureService, validateWindowId, validateRoi };
