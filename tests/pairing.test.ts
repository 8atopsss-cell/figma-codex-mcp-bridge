import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreatePairingCode } from '../src/bridge/pairing.js';

describe('persistent pairing code', () => {
  it('reuses the same secret across bridge starts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figma-bridge-pairing-'));
    try {
      const path = join(directory, 'token');
      const first = await loadOrCreatePairingCode(path);
      const second = await loadOrCreatePairingCode(path);
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(second).toBe(first);
      expect((await readFile(path, 'utf8')).trim()).toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a damaged secret instead of silently changing the pairing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'figma-bridge-pairing-'));
    try {
      const path = join(directory, 'token');
      await writeFile(path, 'broken');
      await expect(loadOrCreatePairingCode(path)).rejects.toThrow('INVALID_PAIRING_CODE_FILE');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
