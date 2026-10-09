import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePastudio, decodePastudio } from '../lib/pastudio-container.mjs';

test('pastudio CRC32 handles both ZIP modes and rejects corrupt payloads', () => {
  const data = Buffer.from('123456789');
  const stored = encodePastudio([['manifest.json', data]]);
  assert.equal(stored.readUInt16LE(8), 0);
  assert.equal(stored.readUInt32LE(14), 0xcbf43926);
  assert.deepEqual(decodePastudio(stored).get('manifest.json'), data);

  const repeated = Buffer.from('session fixture\n'.repeat(128));
  const compressed = encodePastudio([['manifest.json', repeated]]);
  assert.equal(compressed.readUInt16LE(8), 8);
  assert.deepEqual(decodePastudio(compressed).get('manifest.json'), repeated);

  const dataOffset = 30 + stored.readUInt16LE(26) + stored.readUInt16LE(28);
  stored[dataOffset] ^= 1;
  assert.throws(() => decodePastudio(stored), {
    code: 'pastudio_mismatch',
    message: /CRC mismatch/,
  });
});
