import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function packageTransfer() {
  const parent = join(projectRoot, 'transfer');
  const target = join(parent, 'figma-codex-mcp-bridge');
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== join(await realpath(projectRoot), 'transfer')) {
    throw new Error('Transfer directory must stay inside the project');
  }
  const existing = await lstat(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Transfer bundle must not be a symbolic link');
  if (resolve(target) !== join(projectRoot, 'transfer', 'figma-codex-mcp-bridge')) {
    throw new Error('Unexpected transfer bundle path');
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const path of ['dist', 'skills', 'assets', 'manifest.example.json', 'package-lock.json', 'INSTALL-BRIDGE.md']) {
    await cp(join(projectRoot, path), join(target, path), { recursive: true });
  }
  for (const path of ['install-local-plugin.mjs', 'install-skills.mjs']) {
    await cp(join(projectRoot, 'scripts', path), join(target, 'scripts', path));
  }
  await cp(join(projectRoot, 'docs', 'TRANSFER-README.md'), join(target, 'README.md'));
  await cp(join(projectRoot, 'docs', 'TRANSFER-AGENTS.md'), join(target, 'AGENTS.md'));
  const original = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  const runtime = {
    ...original,
    engines: { node: '>=24' },
    scripts: {
      start: 'node dist/bridge/index.js',
      'install:figma': 'node scripts/install-local-plugin.mjs',
      'install:skills': 'node scripts/install-skills.mjs',
    },
  };
  await writeFile(join(target, 'package.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  const files = {};
  async function scan(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) throw new Error(`Bundle contains a symbolic link: ${path}`);
      if (item.isDirectory()) await scan(path);
      else files[relative(target, path).split(sep).join('/')] = createHash('sha256')
        .update(await readFile(path)).digest('hex');
    }
  }
  await scan(target);
  await writeFile(join(target, 'bundle-info.json'), `${JSON.stringify({
    version: original.version,
    generatedAt: new Date().toISOString(),
    files,
  }, null, 2)}\n`);
  console.log(`Transfer bundle ready: ${target} (${Object.keys(files).length} files)`);
}
