const https = require('node:https');

// The only TLS exception is Riot's fixed local game client. Never accepts a URL.
function readLiveGame({ requestImpl = https.get, timeoutMs = 1200 } = {}) {
  return new Promise(resolve => {
    let req, settled = false;
    const finish = (value, destroy = false) => {
      if (settled) return;
      settled = true;
      // Do not depend on destroy() emitting an error/close event to settle.
      resolve(value);
      if (destroy) { try { req?.destroy(); } catch {} }
    };
    try {
      req = requestImpl({ hostname: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata', method: 'GET', rejectUnauthorized: false, agent: false }, res => {
        let body = '', size = 0;
        res.on('error', () => finish(null, true));
        res.on('aborted', () => finish(null, true));
        res.on('close', () => finish(null));
        if (res.statusCode !== 200) { finish(null, true); return; }
        // StringDecoder preserves Chinese characters split across TCP chunks.
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (settled) return;
          size += Buffer.byteLength(chunk, 'utf8');
          if (size > 4 * 1024 * 1024) { finish(null, true); return; }
          body += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          try { finish(JSON.parse(body)); } catch { finish(null); }
        });
      });
      req.on('error', () => finish(null));
      req.on('close', () => finish(null));
      req.setTimeout(timeoutMs, () => finish(null, true));
    } catch { finish(null, true); }
  });
}
module.exports = { readLiveGame };
