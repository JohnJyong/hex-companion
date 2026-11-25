import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const modelRoot = new URL('../app/data/ocr/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', modelRoot), 'utf8'));

test('the bundled Chinese OCR model matches its recorded SHA-256 and byte length', () => {
  assert.deepEqual(manifest.files.map(file => file.file), ['chi_sim.traineddata']);
  for (const record of manifest.files) {
    const bytes = readFileSync(new URL(record.file, modelRoot));
    assert.equal(bytes.length, record.bytes, `${record.file} byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, `${record.file} SHA-256`);
  }
});
