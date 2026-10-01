import { cp, mkdir, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2]
  ? resolve(process.argv[2])
  : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
for (const item of await readdir(join(root, 'skills'), { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  const source = join(root, 'skills', item.name);
  await access(join(source, 'SKILL.md'));
  await mkdir(target, { recursive: true });
  await cp(source, join(target, item.name), { recursive: true, force: true });
  console.log(`Installed skill: ${join(target, item.name)}`);
}
