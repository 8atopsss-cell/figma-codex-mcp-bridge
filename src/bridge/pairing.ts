import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const pairingCodePath = join(
  process.env.LOCALAPPDATA || join(homedir(), '.config'),
  'figma-codex-mcp-bridge',
  'pairing-token',
);

export async function loadOrCreatePairingCode(path = pairingCodePath): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString('hex');
  try {
    await writeFile(path, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stored = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('INVALID_PAIRING_CODE_FILE');
  return stored;
}
