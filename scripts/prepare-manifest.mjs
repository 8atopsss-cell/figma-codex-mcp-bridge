import { readFile, writeFile } from 'node:fs/promises';

const id = process.argv[2];
if (!id || !/^\d{8,}$/.test(id)) {
  console.error('Usage: npm run manifest -- <Figma plugin ID from your generated manifest.json>');
  process.exitCode = 1;
} else {
  const template = JSON.parse(await readFile('manifest.example.json', 'utf8'));
  const manifest = { ...template, id };
  await writeFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('Created local manifest.json with your Figma plugin ID.');
}
