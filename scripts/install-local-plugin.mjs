import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const folder = process.argv[2];
if (!folder) {
  console.error('Usage: npm run install:figma -- <folder created by Figma New plugin>');
  process.exitCode = 1;
} else {
  const target = resolve(folder);
  const current = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (!/^\d{8,}$/.test(current.id ?? '')) {
    throw new Error('The Figma plugin folder has no valid numeric ID');
  }
  const template = JSON.parse(await readFile('manifest.example.json', 'utf8'));
  const manifest = { ...template, id: current.id };
  const pluginDist = join(target, 'dist', 'plugin');
  await mkdir(pluginDist, { recursive: true });
  await copyFile('dist/plugin/main.js', join(pluginDist, 'main.js'));
  await copyFile('dist/plugin/ui.html', join(pluginDist, 'ui.html'));
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Installed Figma Codex MCP Bridge in ${target} with ID ${current.id}.`);
}
