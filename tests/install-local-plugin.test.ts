import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const installer = resolve('scripts/install-local-plugin.mjs');

async function fixture(run: (source: string, target: string, expected: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), 'figma-install-'));
  const source = join(folder, 'source');
  const target = join(folder, 'installed');
  const template = { name: 'Bridge', api: '1.0.0', main: 'dist/plugin/main.js', ui: 'dist/plugin/ui.html' };
  const expected = `${JSON.stringify({ ...template, id: '1687117682194875562' }, null, 2)}\n`;
  try {
    await mkdir(join(source, 'dist/plugin'), { recursive: true });
    await mkdir(target);
    await writeFile(join(source, 'manifest.example.json'), JSON.stringify(template));
    await writeFile(join(source, 'dist/plugin/main.js'), 'plugin code');
    await writeFile(join(source, 'dist/plugin/ui.html'), 'plugin UI');
    await run(source, target, expected);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe('Figma plugin installation', () => {
  it('never truncates a manifest already held open by another reader', async () => {
    await fixture(async (source, target, expected) => {
      const manifest = join(target, 'manifest.json');
      const previous = JSON.stringify({ name: 'Previous', id: '1687117682194875562' });
      await writeFile(manifest, previous);
      const held = await open(manifest, 'r');
      try {
        const installation = execute(process.execPath, [installer, target], { cwd: source });
        if (process.platform === 'win32') {
          // Windows locks replacement while the reader holds the file open.
          await expect(installation).rejects.toThrow('EPERM');
          expect(await readFile(manifest, 'utf8')).toBe(previous);
        } else {
          await installation;
          expect(await readFile(manifest, 'utf8')).toBe(expected);
        }
        expect(await held.readFile('utf8')).toBe(previous);
        expect(await readFile(join(target, 'dist/plugin/main.js'), 'utf8')).toBe('plugin code');
      } finally { await held.close(); }
    });
  });

  it('updates an unlocked manifest and preserves its original plugin ID', async () => {
    await fixture(async (source, target, expected) => {
      const manifest = join(target, 'manifest.json');
      await writeFile(manifest, JSON.stringify({ name: 'Previous', id: '1687117682194875562' }));
      await execute(process.execPath, [installer, target], { cwd: source });
      expect(await readFile(manifest, 'utf8')).toBe(expected);
    });
  });

  it('does not rewrite an unchanged manifest while updating plugin bundles', async () => {
    await fixture(async (source, target, expected) => {
      const manifest = join(target, 'manifest.json');
      await writeFile(manifest, expected);
      const date = new Date('2000-01-01T00:00:00Z');
      await utimes(manifest, date, date);
      const before = await stat(manifest);
      await execute(process.execPath, [installer, target], { cwd: source });
      expect((await stat(manifest)).mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(join(target, 'dist/plugin/ui.html'), 'utf8')).toBe('plugin UI');
    });
  });
});
