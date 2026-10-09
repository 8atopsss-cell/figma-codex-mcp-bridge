import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: npm run install:figma -- <folder created by Figma New plugin>');
  process.exitCode = 1;
} else {
  const target = resolve(folder);
  const manifestPath = join(target, 'manifest.json');
  const currentText = await readFile(manifestPath, 'utf8');
  const current = JSON.parse(currentText);
  if (!/^\d{8,}$/.test(current.id ?? '')) {
    throw new Error('The Figma plugin folder has no valid numeric ID');
  }
  const template = JSON.parse(await readFile('manifest.example.json', 'utf8'));
  const manifest = { ...template, id: current.id };
  const pluginDist = join(target, 'dist', 'plugin');
  await mkdir(pluginDist, { recursive: true });
  await copyFile('dist/plugin/main.js', join(pluginDist, 'main.js'));
  await copyFile('dist/plugin/ui.html', join(pluginDist, 'ui.html'));
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (currentText !== manifestText) {
    // Figma watches this file: never expose a truncated/partly written manifest.
    const temporary = join(target, `manifest.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, manifestText, { flag: 'wx' });
      await rename(temporary, manifestPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  console.log(`Installed Figma Codex MCP Bridge in ${target} with ID ${current.id}.`);
}
