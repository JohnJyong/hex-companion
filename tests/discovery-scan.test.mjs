import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryScan } from '../desktop/discovery-scan.cjs';

test('searches widely without calibration, then checks the learned title band between wide scans', () => {
  const scan = createDiscoveryScan();
  assert.equal(scan.search(0), null);
  assert.equal(scan.search(250), null);
  const band = { x: 0.15, y: 0.52, width: 0.7, height: 0.065 };
  scan.learn(band);
  assert.equal(scan.search(400), null);
  assert.deepEqual(scan.search(650), band);
  assert.deepEqual(scan.search(2399), band);
  assert.equal(scan.search(2400), null);
  assert.deepEqual(scan.search(2650), band);
  scan.endSearch();
  assert.equal(scan.search(2700), null);
  assert.deepEqual(scan.search(2950), band);
  scan.reset();
  assert.equal(scan.search(3100), null);
  assert.equal(scan.search(3350), null);
});
