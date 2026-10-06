import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const storageRoot = join(process.env.LOCALAPPDATA || join(homedir(), '.config'), 'figma-codex-mcp-bridge', 'storybook-access');

export async function syncAccessCodePath(project: string, storage = storageRoot) {
  const root = await realpath(project);
  const identity = process.platform === 'win32' ? root.toLowerCase() : root;
  return join(storage, createHash('sha256').update(identity).digest('hex') + '.token');
}

export async function loadOrCreateSyncAccessCode(project: string, storage = storageRoot) {
  const path = await syncAccessCodePath(project, storage);
  await mkdir(storage, { recursive: true, mode: 0o700 });
  try {
    const stored = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('INVALID_SYNC_ACCESS_CODE_FILE');
    return stored;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const generated = randomBytes(32).toString('hex');
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, generated, { flag: 'wx', mode: 0o600 });
  try {
    // Publish a complete file exactly once, even when two processes start together.
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(temporary); }
  const stored = (await readFile(path, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(stored)) throw new Error('INVALID_SYNC_ACCESS_CODE_FILE');
  return stored;
}
