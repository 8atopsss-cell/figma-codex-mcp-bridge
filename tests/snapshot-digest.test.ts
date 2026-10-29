import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { snapshotDigest } from '../src/plugin/snapshot-digest.js';

it('matches SHA-256 UTF-8 across block boundaries, Unicode and large snapshots without WebCrypto', () => {
  vi.stubGlobal('TextEncoder', undefined); vi.stubGlobal('crypto', undefined);
  try {
    const values = ['', 'abc', '🙂Привет中文', '\ud800', '\udc00', '\ud800a\udc00', ...[55, 56, 63, 64, 65, 127, 128, 129, 1000, 600_000].map(n => 'a'.repeat(n)), '🙂'.repeat(70_000)];
    for (const value of values) expect(snapshotDigest(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
  } finally { vi.unstubAllGlobals(); }
});
