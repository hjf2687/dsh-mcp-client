#!/usr/bin/env node
/**
 * A deliberately awkward MCP stdio server used only by the test suite.
 *
 * It exercises the parts of the protocol dsh-mcp-client has to get right:
 * handshake, `tools/list` pagination, `tools/call`, MCP-level tool errors,
 * `notifications/tools/list_changed`, a server-initiated request (which this
 * client must answer rather than ignore), and an `inputSchema` full of
 * keywords the DSH schema subset does not support.
 *
 * Environment switches:
 *   STUB_PAGE_SIZE=2       paginate tools/list
 *   STUB_LIST_CHANGED=1    reveal a fourth tool via list_changed
 *   STUB_SERVER_REQUEST=1  send one server->client request during initialize
 *   STUB_PING=1            ping the client during initialize and report the reply
 *   STUB_NO_TOOLS=1        advertise no `tools` capability at all
 *   STUB_HANG_INITIALIZE=1 read stdin but never answer `initialize`
 *   STUB_INITIALIZE_DELAY_MS=N  answer `initialize` only after N ms
 *   STUB_STDERR_NOISE=N    write N `stub-noise-<i>` lines to stderr
 */

import { NASTY_SCHEMA } from './nasty-schema.mjs';

// Announce the working directory we were spawned in. The panel's "工作目录"
// field is only real if this line changes with it.
process.stderr.write(`stub cwd=${process.cwd()}\n`);

const PAGE_SIZE = Number(process.env.STUB_PAGE_SIZE ?? 0) || 0;
const LIST_CHANGED = process.env.STUB_LIST_CHANGED === '1';
const SERVER_REQUEST = process.env.STUB_SERVER_REQUEST === '1';
const PING = process.env.STUB_PING === '1';
const NO_TOOLS = process.env.STUB_NO_TOOLS === '1';
const HANG_INITIALIZE = process.env.STUB_HANG_INITIALIZE === '1';
const INITIALIZE_DELAY = Number(process.env.STUB_INITIALIZE_DELAY_MS ?? 0) || 0;
const STDERR_NOISE = Number(process.env.STUB_STDERR_NOISE ?? 0) || 0;

for (let i = 0; i < STDERR_NOISE; i += 1) {
  process.stderr.write(`stub-noise-${i}\n`);
}

const ECHO = { name: 'echo', description: 'Echo the message back.', inputSchema: NASTY_SCHEMA };
const FAIL = {
  name: 'fail',
  description: 'Always fails at the MCP level.',
  inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
};
const SLOW = {
  name: 'slow',
  description: 'Sleeps, then answers.',
  inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
};
const LATE = {
  name: 'late',
  description: 'Only appears after a list_changed notification.',
  inputSchema: { type: 'object', properties: {} },
};

let revealed = false;
let serverRequestAnswered = false;

function toolList() {
  return revealed ? [ECHO, FAIL, SLOW, LATE] : [ECHO, FAIL, SLOW];
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

async function callTool(name, args) {
  if (name === 'echo') return textResult(`echo:${JSON.stringify(args ?? {})}`);
  if (name === 'fail') {
    return { content: [{ type: 'text', text: 'stub failure' }], isError: true };
  }
  if (name === 'slow') {
    const ms = Number(args?.ms ?? 50);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return textResult(`slept:${ms}`);
  }
  if (name === 'late') return textResult('late tool ran');
  throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    if (HANG_INITIALIZE) {
      // A server that accepts the request and never answers: the client's
      // handshake timeout is the only way out, and it must kill this process.
      return;
    }
    if (INITIALIZE_DELAY > 0) {
      // A server that is slow but alive: used to hold a restart open while a
      // shutdown races it.
      await new Promise((resolve) => setTimeout(resolve, INITIALIZE_DELAY));
    }
    if (SERVER_REQUEST) {
      // A server-initiated request. This client advertises no such capability,
      // so it must answer with "method not found" instead of going silent.
      write({ jsonrpc: '2.0', id: 900, method: 'roots/list', params: {} });
    }
    if (PING) {
      // MCP requires a ping to be answered with an empty result, never an error.
      write({ jsonrpc: '2.0', id: 901, method: 'ping', params: {} });
    }
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: NO_TOOLS ? {} : { tools: { listChanged: true } },
        serverInfo: { name: 'stub', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    if (LIST_CHANGED) {
      setTimeout(() => {
        revealed = true;
        write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
      }, 30);
    }
    return;
  }

  if (method === 'tools/list') {
    const all = toolList();
    if (PAGE_SIZE <= 0) {
      write({ jsonrpc: '2.0', id, result: { tools: all } });
      return;
    }
    const offset = Number(params?.cursor ?? 0) || 0;
    const page = all.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + PAGE_SIZE;
    const result = { tools: page };
    if (nextOffset < all.length) result.nextCursor = String(nextOffset);
    write({ jsonrpc: '2.0', id, result });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments);
      write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: error.code ?? -32000, message: String(error.message ?? error) },
      });
    }
    return;
  }

  // A reply to our own server-initiated request.
  if (id === 900 && (message.error !== undefined || message.result !== undefined)) {
    if (message.error?.code === -32601) {
      serverRequestAnswered = true;
      process.stderr.write('server-request-answered\n');
    }
    return;
  }

  // A reply to our own ping.
  if (id === 901 && (message.error !== undefined || message.result !== undefined)) {
    if (message.error === undefined && message.result !== undefined) {
      process.stderr.write('ping-answered\n');
    } else {
      process.stderr.write(`ping-failed: ${JSON.stringify(message.error)}\n`);
    }
    return;
  }

  if (id !== undefined) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(message);
  }
});

process.stdin.on('end', () => {
  process.exit(serverRequestAnswered ? 0 : 0);
});
