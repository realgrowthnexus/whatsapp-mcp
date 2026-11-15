#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// stdout is reserved for the MCP protocol; diagnostics go to stderr (shown in Claude Desktop's MCP log).
const { server, close } = createServer();
await server.connect(new StdioServerTransport());
console.error('whatsapp-local MCP server ready');

const stop = () => void close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('close', stop);
