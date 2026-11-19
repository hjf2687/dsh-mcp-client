import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  McpStdioClient,
  buildArgv,
  decodeMessages,
  decodeStderrLine,
  encodeMessage,
} from '../lib/mcp-client.js';
import { nodeSpawn } from './fixtures/node-spawn.mjs';

const STUB = fileURLToPath(new URL('./fixtures/stub-server.mjs', import.meta.url));

/** Spawn the stub server through the real client. */
function makeClient(env = {}) {
  const logs = [];
  const notifications = [];
  const client = new McpStdioClient({
    server: {
      id: 'stub',
      command: process.execPath,
      args: [STUB],
      env,
      graceMs: 1000,
    },
    spawn: nodeSpawn,
    cwd: process.cwd(),
    timeoutMs: 10000,
    log: (level, message) => logs.push(`${level}: ${message}`),
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  return { client, logs, notifications };
}

/** Poll until `check()` is truthy or the deadline passes. */
async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('framing helpers round-trip newline-delimited JSON', () => {
  assert.equal(encodeMessage({ a: 1 }), '{"a":1}\n');
  const { messages, rest } = decodeMessages('{"a":1}\r\n{"b":2}\n{"partial"');
  assert.deepEqual(messages, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '{"partial"');
});

test('stderr decodes as UTF-8 first, then as the Windows ANSI codepage', () => {
  assert.equal(decodeStderrLine(Buffer.from('plain text', 'utf8')), 'plain text');
  // Valid UTF-8 always wins.
  assert.equal(decodeStderrLine(Buffer.from('→ 设置', 'utf8')), '→ 设置');
  // GBK bytes for '→' are 0xA1 0xFA. Forced through UTF-8 those become two
  // U+FFFD replacement characters — the "two diamonds" users actually see.
  assert.equal(decodeStderrLine(Buffer.from([0xa1, 0xfa])), '→');
  assert.notEqual(decodeStderrLine(Buffer.from([0xa1, 0xfa])), '\uFFFD\uFFFD');
  // GBK bytes for '设置' are 0xC9 0xE8 0xD6 0xC3.
  assert.equal(decodeStderrLine(Buffer.from([0xc9, 0xe8, 0xd6, 0xc3])), '设置');
  // Nothing in, nothing out, and a plain string is accepted too.
  assert.equal(decodeStderrLine(Buffer.alloc(0)), '');
  assert.equal(decodeStderrLine('ascii'), 'ascii');
});

test('buildArgv wraps Windows command shims in cmd.exe', () => {
  const server = { command: 'npx.cmd', args: ['-y', 'some-mcp'] };
  assert.deepEqual(buildArgv(server, 'win32'), ['cmd.exe', '/d', '/s', '/c', 'npx.cmd', '-y', 'some-mcp']);
  assert.deepEqual(buildArgv(server, 'linux'), ['npx.cmd', '-y', 'some-mcp']);
});

test('completes the handshake, lists tools, and calls one', async () => {
  const { client } = makeClient();
  try {
    const init = await client.start();
    assert.equal(init.serverInfo.name, 'stub');
    assert.equal(client.ready, true);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['echo', 'fail', 'slow'],
    );

    const call = await client.callTool('echo', { hello: 'world' });
    assert.equal(call.isError, undefined);
    assert.equal(call.content[0].text, 'echo:{"hello":"world"}');

    // The hostile inputSchema arrives intact; projection is the host's job.
    const echo = tools.find((tool) => tool.name === 'echo');
    assert.equal(echo.inputSchema.properties.message.$ref, '#/$defs/Message');
  } finally {
    await client.stop();
  }
});

test('the per-server cwd actually reaches the spawned process', async () => {
  const dir = os.tmpdir();
  const logs = [];
  const client = new McpStdioClient({
    server: { id: 'stub', command: process.execPath, args: [STUB], env: {}, cwd: dir, graceMs: 1000 },
    spawn: nodeSpawn,
    // A deliberately different client-level default: the per-server value wins.
    cwd: process.cwd(),
    timeoutMs: 10000,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  try {
    await client.start();
    assert.ok(
      logs.some((line) => line.includes(`stub cwd=${dir}`)),
      `expected the stub to report cwd=${dir}, got:\n${logs.join('\n')}`,
    );
  } finally {
    await client.stop();
  }
});

test('follows tools/list cursor pagination', async () => {
  const { client } = makeClient({ STUB_PAGE_SIZE: '2' });
  try {
    await client.start();
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['echo', 'fail', 'slow'],
    );
  } finally {
    await client.stop();
  }
});

test('surfaces MCP-level tool errors', async () => {
  const { client } = makeClient();
  try {
    await client.start();
    const result = await client.callTool('fail', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'stub failure');
  } finally {
    await client.stop();
  }
});

test('rejects a JSON-RPC error from tools/call', async () => {
  const { client } = makeClient();
  try {
    await client.start();
    await assert.rejects(() => client.callTool('does-not-exist', {}), /unknown tool: does-not-exist/);
  } finally {
    await client.stop();
  }
});

test('delivers notifications/tools/list_changed', async () => {
  const { client, notifications } = makeClient({ STUB_LIST_CHANGED: '1' });
  try {
    await client.start();
    await waitFor(() =>
      notifications.some((entry) => entry.method === 'notifications/tools/list_changed'),
    );
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['echo', 'fail', 'late', 'slow'],
    );
  } finally {
    await client.stop();
  }
});

test('answers a server-initiated request instead of going silent', async () => {
  const { client, logs } = makeClient({ STUB_SERVER_REQUEST: '1' });
  try {
    await client.start();
    // The stub only writes this line once it receives our "method not found".
    await waitFor(() => logs.some((line) => line.includes('server-request-answered')));
  } finally {
    await client.stop();
  }
});

test('cancels an in-flight call through the abort signal', async () => {
  const { client } = makeClient();
  try {
    await client.start();
    const controller = new AbortController();
    const pending = client.callTool('slow', { ms: 3000 }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => pending, /aborted/);
    // The client stays usable after one cancelled call.
    const after = await client.callTool('echo', { alive: true });
    assert.equal(after.content[0].text, 'echo:{"alive":true}');
  } finally {
    await client.stop();
  }
});

test('stop() releases the process and refuses further work', async () => {
  const { client } = makeClient();
  await client.start();
  await client.stop();
  assert.equal(client.ready, false);
  await assert.rejects(() => client.request('tools/list', {}), /closed/);
});

/* -------------------------------------------------------------------------- */
/* The subprocess seam                                                       */
/* -------------------------------------------------------------------------- */

/** A fake handle whose process never speaks, so `start()` only sees timeouts. */
function makeSilentHandle() {
  return {
    stdin: { write() {}, end() {} },
    stdout: { setEncoding() {}, on() {} },
    stderr: null,
    done: new Promise(() => {}),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  };
}

test('the child env is exactly the configured extras, never process.env', async () => {
  const specs = [];
  const spawn = (spec) => {
    specs.push(spec);
    return makeSilentHandle();
  };
  const sentinel = 'DSH_MCP_ENV_SENTINEL';
  process.env[sentinel] = 'harness-secret';
  try {
    const client = new McpStdioClient({
      server: { id: 'envtest', command: 'node', args: [], env: { MCP_ONLY: 'yes' } },
      spawn,
      timeoutMs: 5000,
      graceMs: 4321,
      log: () => {},
    });
    const pending = client.start();
    void pending.catch(() => {});
    assert.equal(specs.length, 1);
    // `childEnv(extra) = scrubbedParentEnv() + extra`, so passing the parent
    // environment through here would re-add every credential it just removed.
    assert.deepEqual(specs[0].env, { MCP_ONLY: 'yes' });
    assert.equal(sentinel in specs[0].env, false);
    assert.equal('PATH' in specs[0].env, false);
    // The deployment-level graceMs reaches the provider when a server has none.
    assert.equal(specs[0].graceMs, 4321);
    await client.stop();
    await assert.rejects(() => pending, /closed/);

    // A per-server graceMs still wins over the deployment default.
    const perServer = new McpStdioClient({
      server: { id: 'envtest2', command: 'node', args: [], env: {}, graceMs: 999 },
      spawn,
      timeoutMs: 5000,
      graceMs: 4321,
      log: () => {},
    });
    const second = perServer.start();
    void second.catch(() => {});
    assert.equal(specs[1].graceMs, 999);
    await perServer.stop();
    await assert.rejects(() => second, /closed/);
  } finally {
    delete process.env[sentinel];
  }
});

test('the handshake timeout falls back to connectTimeoutMs', async () => {
  const client = new McpStdioClient({
    server: {
      id: 'hang',
      command: process.execPath,
      args: [STUB],
      env: { STUB_HANG_INITIALIZE: '1' },
    },
    spawn: nodeSpawn,
    timeoutMs: 10000,
    connectTimeoutMs: 150,
    log: () => {},
  });
  await assert.rejects(() => client.start(), /initialize timed out after 150ms/);
  assert.equal(client.ready, false);
});

test('a failed handshake kills the child and the same client can start again', async () => {
  const handles = [];
  const spawn = (spec) => {
    // Only the first spawn gets a server that never answers `initialize`.
    const env = handles.length === 0 ? { ...spec.env, STUB_HANG_INITIALIZE: '1' } : spec.env;
    const handle = nodeSpawn({ ...spec, env });
    handles.push(handle);
    return handle;
  };
  const client = new McpStdioClient({
    server: {
      id: 'flaky',
      command: process.execPath,
      args: [STUB],
      env: {},
      // Keep the failed handshake short; the path under test is the cleanup.
      startupTimeoutMs: 250,
    },
    spawn,
    timeoutMs: 10000,
    log: () => {},
  });

  await assert.rejects(() => client.start(), /timed out/);
  assert.equal(client.ready, false);
  assert.equal(handles.length, 1);

  // No orphan: the terminated child really left, so it is not still holding a
  // pipe (or a port) on behalf of a server that never completed a handshake.
  await waitFor(
    () => handles[0].child.exitCode !== null || handles[0].child.signalCode !== null,
    3000,
  );
  let alive = true;
  try {
    process.kill(handles[0].pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'the child of a failed handshake must not survive');

  // stop() dropped the handle, so this client is usable for a second attempt.
  const init = await client.start();
  assert.equal(init.serverInfo.name, 'stub');
  assert.equal(client.ready, true);
  assert.equal(handles.length, 2);
  await client.stop();
  assert.equal(client.ready, false);
});

test('answers a ping with an empty result instead of method-not-found', async () => {
  const { client, logs } = makeClient({ STUB_PING: '1' });
  try {
    await client.start();
    // The stub only reports success once it received `result: {}`.
    await waitFor(() => logs.some((line) => line.includes('ping-answered')));
    assert.equal(logs.some((line) => line.includes('ping-failed')), false);
  } finally {
    await client.stop();
  }
});

test('still answers genuinely unsupported requests with method-not-found', async () => {
  const { client, logs } = makeClient({ STUB_SERVER_REQUEST: '1' });
  try {
    await client.start();
    await waitFor(() => logs.some((line) => line.includes('server-request-answered')));
  } finally {
    await client.stop();
  }
});
