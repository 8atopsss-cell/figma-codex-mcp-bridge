import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/plugin', { recursive: true });
await mkdir('dist/bridge', { recursive: true });

await build({
  entryPoints: ['src/plugin/main.ts'],
  outfile: 'dist/plugin/main.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
});

const ui = await build({
  entryPoints: ['src/plugin/ui.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
});
const html = await readFile('src/plugin/ui.html', 'utf8');
const css = await readFile('src/plugin/ui.css', 'utf8');
const script = ui.outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile('dist/plugin/ui.html', html.replace('/* STYLE */', css).replace('/* SCRIPT */', script));

await build({
  entryPoints: ['src/bridge/index.ts'],
  outfile: 'dist/bridge/index.js',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
});
