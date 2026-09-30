import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'figma-bridge-live-check', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/bridge/index.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});

try {
  await client.connect(transport);
  const code = await client.callTool({ name: 'get_pairing_code', arguments: {} });
  console.log(`Код подключения: ${code.content[0].text}`);
  console.log('Ожидаю подключение плагина Figma…');
  for (let attempt = 0; attempt < 120; attempt++) {
    const overview = await client.callTool({ name: 'get_file_overview', arguments: {} });
    if (!overview.isError) {
      console.log(`Figma подключена: ${overview.content[0].text}`);
      process.exitCode = 0;
      break;
    }
    if (attempt === 119) {
      console.error(`Не удалось подключиться: ${overview.content[0].text}`);
      process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await client.close();
}
