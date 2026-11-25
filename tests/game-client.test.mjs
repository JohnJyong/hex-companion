import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readLiveGame } = require('../desktop/game-client.cjs');

function mockRequest(statusCode = 200) {
  const request = new EventEmitter();
  const response = new PassThrough();
  response.statusCode = statusCode;
  let options, timeout, timeoutCallback, destroyed = 0;
  // Deliberately emit no event from destroy(): terminal branches must resolve
  // themselves rather than waiting for an error or close event that may not fire.
  request.destroy = () => { destroyed++; };
  request.setTimeout = (ms, callback) => { timeout = ms; timeoutCallback = callback; return request; };
  const requestImpl = (receivedOptions, onResponse) => {
    options = receivedOptions;
    queueMicrotask(() => onResponse(response));
    return request;
  };
  return {
    request, response, requestImpl,
    get options() { return options; },
    get timeout() { return timeout; },
    get destroyed() { return destroyed; },
    triggerTimeout() { timeoutCallback(); },
  };
}

async function settles(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Live Client request did not settle')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

test('UTF-8 characters survive every-byte response splits and the endpoint stays fixed', async () => {
  const mock = mockRequest();
  const pending = readLiveGame({ requestImpl: mock.requestImpl, url: 'https://example.invalid/ignored' });
  await Promise.resolve();
  const payload = { activePlayer: { summonerName: '测试玩家', riotId: '海克斯#国服' }, note: '金克丝🙂' };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  for (const byte of bytes) mock.response.write(Buffer.from([byte]));
  mock.response.end();
  assert.deepEqual(await settles(pending), payload);
  assert.deepEqual(mock.options, {
    hostname: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata',
    method: 'GET', rejectUnauthorized: false, agent: false,
  });
  assert.equal(mock.timeout, 1200);
});

test('the four-MiB limit counts UTF-8 bytes and settles immediately even without an end event', async () => {
  const mock = mockRequest();
  const pending = readLiveGame({ requestImpl: mock.requestImpl });
  await Promise.resolve();
  const text = '界'.repeat(Math.ceil((4 * 1024 * 1024 + 1) / 3));
  assert.ok(text.length < 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(text) > 4 * 1024 * 1024);
  mock.response.write(text);
  assert.equal(await settles(pending), null);
  assert.equal(mock.destroyed, 1);
  mock.response.end('{}');
  assert.equal(mock.destroyed, 1);
});

test('timeout resolves without depending on destroy events', async () => {
  const mock = mockRequest();
  const pending = readLiveGame({ requestImpl: mock.requestImpl, timeoutMs: 50 });
  await Promise.resolve();
  mock.triggerTimeout();
  assert.equal(await settles(pending), null);
  assert.equal(mock.timeout, 50);
  assert.equal(mock.destroyed, 1);
  mock.response.end('{"late":true}');
  assert.equal(await pending, null);
});

test('response abort, disconnect, and request errors all settle without hanging', async t => {
  for (const [target, event] of [
    ['response', 'aborted'], ['response', 'close'], ['response', 'error'],
    ['request', 'close'], ['request', 'error'],
  ]) await t.test(`${target} ${event}`, async () => {
    const mock = mockRequest();
    const pending = readLiveGame({ requestImpl: mock.requestImpl });
    await Promise.resolve();
    mock.response.write('{"unfinished":');
    mock[target].emit(event, new Error('connection interrupted'));
    assert.equal(await settles(pending), null);
    mock.response.end();
  });
});

test('invalid JSON and non-200 responses return null', async t => {
  await t.test('invalid JSON', async () => {
    const mock = mockRequest();
    const pending = readLiveGame({ requestImpl: mock.requestImpl });
    await Promise.resolve();
    mock.response.end('{"broken":');
    assert.equal(await settles(pending), null);
  });
  await t.test('non-200 without response end', async () => {
    const mock = mockRequest(503);
    const pending = readLiveGame({ requestImpl: mock.requestImpl });
    assert.equal(await settles(pending), null);
    assert.equal(mock.destroyed, 1);
  });
});

test('synchronous transport failures resolve null', async () => {
  const pending = readLiveGame({ requestImpl() { throw new Error('transport unavailable'); } });
  assert.equal(await settles(pending), null);
});
