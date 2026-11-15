import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { baseConfig, tempHome } from './helpers.js';

const built = path.resolve('dist/mcp/index.js');

describe.skipIf(!fs.existsSync(built))('built MCP server over stdio (as Claude Desktop runs it)', () => {
  it('starts, lists tools and gives clear errors before linking', async () => {
    const home = tempHome(baseConfig());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [built],
      env: { ...process.env, WHATSAPP_MCP_HOME: home } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('draft_reply');
    expect(tools).not.toContain('send_message');

    const chats = (await client.callTool({ name: 'list_chats', arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(chats.isError).toBe(true);
    expect(chats.content[0]!.text).toContain('npm run link');

    const status = (await client.callTool({ name: 'get_status', arguments: {} })) as { content: { text: string }[] };
    expect(status.content[0]!.text).toContain('listener_not_running');
    await client.close();
  });
});
