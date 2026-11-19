import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  activate,
  findConfigEntry,
  normalizeCallResult,
  normalizeConfig,
  publicToolName,
  sanitizeServersForWrite,
} from '../lib/host.js';
import { nodeSpawn } from './fixtures/node-spawn.mjs';

const STUB = fileURLToPath(new URL('./fixtures/stub-server.mjs', import.meta.url));

/**
 * A fake Cordis context exposing just the two services the plugin injects.
 *
 * `optional` supplies the lazily injected services (`webServer`,
 * `configEditor`); when omitted, `ctx.inject` is not defined at all, which is
 * how the plugin behaves in a headless profile.
 */
function makeCtx(optional = null) {
  const registered = new Map();
  const disposers = [];
  const services = { tools: null, subprocess: null, ...(optional === null ? {} : optional.services) };
  const ctx = {
    tools: {
      register(definition) {
        if (registered.has(definition.name)) {
          throw new Error(`duplicate tool name: ${definition.name}`);
        }
        registered.set(definition.name, definition);
        return () => {
          registered.delete(definition.name);
        };
      },
    },
    subprocess: { spawn: nodeSpawn },
    effect(factory) {
      disposers.push(factory());
    },
    get(name) {
      return services[name];
    },
    // --- test-only surface ---
    registeredTools: registered,
    dispose() {
      for (const disposer of disposers) disposer();
    },
  };
  if (optional !== null) {
    ctx.inject = (names, callback) => {
      // Only fire when every requested service is actually present, mirroring
      // Cordis' "stay pending until the dependency exists" behaviour.
      if (names.every((name) => services[name] !== undefined)) callback(ctx);
    };
  }
  return ctx;
}

/** Poll until `check()` is truthy or the deadline passes. */
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Config for one stub server. */
function stubConfig(env = {}, extra = {}) {
  return {
    verbose: false,
    servers: [{ id: 'stub', command: process.execPath, args: [STUB], env }],
    ...extra,
  };
}

test('public tool names are namespaced and sanitized', () => {
  assert.equal(publicToolName('mcp', 'blender', 'get_scene_info'), 'mcp__blender__get_scene_info');
  assert.equal(publicToolName('mcp', 'blender', 'get_scene.info'), 'mcp__blender__get_scene_info');
  assert.equal(publicToolName('mcp', 'my server', 'do it'), 'mcp__my_server__do_it');
  // A name with nothing usable left falls back instead of collapsing to "".
  assert.equal(publicToolName('mcp', 'blender', '中文名'), 'mcp__blender__tool');
});

test('normalizeConfig applies defaults and skips malformed entries', () => {
  const warnings = [];
  const options = normalizeConfig(
    {
      toolPrefix: 'mcp',
      servers: [
        { id: 'ok', command: 'node', args: ['x.mjs'] },
        { id: 'no-command' },
        { command: 'node' },
        { id: 'bad-args', command: 'node', args: 'not-an-array' },
        { id: 'ok', command: 'node' },
        null,
      ],
    },
    (level, message) => warnings.push(`${level}: ${message}`),
  );

  assert.deepEqual(
    options.servers.map((server) => server.id),
    ['ok'],
  );
  assert.deepEqual(options.servers[0].args, ['x.mjs']);
  assert.deepEqual(options.servers[0].env, {});
  assert.equal(options.callTimeoutMs, 60000);
  assert.equal(options.connectTimeoutMs, 20000);
  assert.equal(options.toolPrefix, 'mcp');
  assert.equal(warnings.length, 5);
});

test('normalizeConfig rejects a non-array servers field', () => {
  assert.throws(() => normalizeConfig({ servers: 'nope' }), /config\.servers must be an array/);
});

test('normalizeConfig trims the command so spawn sees a real executable', () => {
  const options = normalizeConfig({ servers: [{ id: 'a', command: '  node  ', args: [] }] });
  assert.equal(options.servers[0].command, 'node');
  // A non-string command is still skipped rather than crashing the normalizer.
  const warnings = [];
  const skipped = normalizeConfig(
    { servers: [{ id: 'b', command: 7 }] },
    (level, message) => warnings.push(`${level}: ${message}`),
  );
  assert.deepEqual(skipped.servers, []);
  assert.match(warnings[0], /no command configured/);
});

test('normalizeCallResult flattens MCP content blocks', () => {
  const flat = normalizeCallResult('stub', 'echo', {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'resource', resource: { uri: 'file:///x' } },
    ],
    structuredContent: { ok: true },
  });
  assert.equal(flat.isError, false);
  assert.match(flat.text, /hello/);
  assert.match(flat.text, /image\/png/);
  assert.match(flat.text, /file:\/\/\/x/);
  assert.match(flat.text, /"ok": true/);

  const empty = normalizeCallResult('stub', 'echo', { content: [] });
  assert.equal(empty.text, '(MCP tool returned no content)');
});

test('activate registers every remote tool and forwards calls', async () => {
  const ctx = makeCtx();
  await activate(ctx, stubConfig());

  // The bounded startup wait means the tools are already visible when the
  // plugin finishes loading, so a one-shot run's first model step sees them.
  assert.equal(ctx.registeredTools.size, 3);
  await waitFor(() => ctx.registeredTools.size === 3);
  assert.deepEqual(
    [...ctx.registeredTools.keys()].sort(),
    ['mcp__stub__echo', 'mcp__stub__fail', 'mcp__stub__slow'],
  );

  const echo = ctx.registeredTools.get('mcp__stub__echo');
  // The hostile remote schema was projected into the supported subset.
  assert.equal(echo.parameters.type, 'object');
  assert.deepEqual(echo.parameters.required, ['message']);
  assert.deepEqual(echo.parameters.properties.mode, {});
  assert.match(echo.description, /via MCP server "stub"/);

  const value = await echo.execute({ message: { text: 'hi' } }, { signal: undefined });
  assert.equal(value.server, 'stub');
  assert.match(value.text, /echo:/);

  const blocks = echo.output.render({}, value);
  assert.deepEqual(blocks, [{ type: 'text', text: value.text }]);

  const call = echo.presentCall({ message: { text: 'hi' } });
  assert.equal(call.card, 'generic');
  assert.equal(call.title, 'stub: echo');

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('an MCP-level tool error becomes a real DSH tool error', async () => {
  const ctx = makeCtx();
  await activate(ctx, stubConfig());
  await waitFor(() => ctx.registeredTools.size === 3);

  const fail = ctx.registeredTools.get('mcp__stub__fail');
  await assert.rejects(
    () => fail.execute({}, { signal: undefined }),
    /MCP tool "fail" reported an error:\nstub failure/,
  );

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('a list_changed notification publishes the new tool', async () => {
  const ctx = makeCtx();
  await activate(ctx, stubConfig({ STUB_LIST_CHANGED: '1' }));

  await waitFor(() => ctx.registeredTools.size === 3);
  await waitFor(() => ctx.registeredTools.has('mcp__stub__late'));
  assert.equal(ctx.registeredTools.size, 4);

  const late = ctx.registeredTools.get('mcp__stub__late');
  const value = await late.execute({}, { signal: undefined });
  assert.equal(value.text, 'late tool ran');

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('a disabled server is never started', async () => {
  const ctx = makeCtx();
  await activate(ctx, {
    servers: [{ id: 'stub', command: process.execPath, args: [STUB], enabled: false }],
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(ctx.registeredTools.size, 0);
  ctx.dispose();
});

test('one broken server does not stop a healthy one', async () => {
  const ctx = makeCtx();
  await activate(ctx, {
    servers: [
      { id: 'broken', command: 'definitely-not-a-real-binary-xyz', args: [] },
      { id: 'stub', command: process.execPath, args: [STUB] },
    ],
  });

  await waitFor(() => ctx.registeredTools.size === 3);
  assert.deepEqual(
    [...ctx.registeredTools.keys()].sort(),
    ['mcp__stub__echo', 'mcp__stub__fail', 'mcp__stub__slow'],
  );

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('awaitStartupMs: 0 skips the wait and connects in the background', async () => {
  const ctx = makeCtx();
  await activate(ctx, stubConfig({}, { awaitStartupMs: 0 }));
  // Nothing awaited, so no process can have completed its handshake yet.
  assert.equal(ctx.registeredTools.size, 0);
  await waitFor(() => ctx.registeredTools.size === 3);
  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('an empty server list registers nothing and starts no process', async () => {
  const ctx = makeCtx();
  await activate(ctx, { servers: [] });
  assert.equal(ctx.registeredTools.size, 0);
  ctx.dispose();
});

/* -------------------------------------------------------------------------- */
/* Panel wiring                                                               */
/* -------------------------------------------------------------------------- */

/** A fake web server that records the routes the plugin mounts. */
function makeFakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

test('the panel mounts even with zero servers, so the first one can be added', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, { servers: [] });

  assert.deepEqual([...webServer.routes.keys()].sort(), [
    '/dsh-mcp-client/config.json',
    '/dsh-mcp-client/reconnect.json',
    '/dsh-mcp-client/status.json',
  ]);

  // The status route answers with an empty, well-formed payload.
  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).servers, []);

  ctx.dispose();
  assert.equal(webServer.routes.size, 0);
});

test('the status route reports live server state', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, stubConfig());
  await waitFor(() => ctx.registeredTools.size === 3);

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const payload = JSON.parse(res.body);
  assert.equal(payload.servers.length, 1);
  assert.equal(payload.servers[0].id, 'stub');
  assert.equal(payload.servers[0].status, 'connected');
  assert.equal(payload.servers[0].serverInfo.name, 'stub');
  assert.equal(payload.servers[0].toolCount, 3);
  assert.deepEqual(
    payload.servers[0].tools.map((tool) => tool.name).sort(),
    ['mcp__stub__echo', 'mcp__stub__fail', 'mcp__stub__slow'],
  );
  // The published schema is what the model receives, so the panel shows it.
  assert.equal(payload.servers[0].tools[0].parameters.type, 'object');

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('a disabled server still appears in the panel as disabled', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, {
    servers: [{ id: 'off', command: process.execPath, args: [STUB], enabled: false }],
  });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const [server] = JSON.parse(res.body).servers;
  assert.equal(server.id, 'off');
  assert.equal(server.status, 'disabled');
  assert.equal(server.enabled, false);
  assert.equal(server.config.enabled, false);
  assert.equal(ctx.registeredTools.size, 0);
  ctx.dispose();
});

test('the panel record separates configured values from negotiated runtime state', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, {
    servers: [
      {
        id: 'stub',
        command: process.execPath,
        args: [STUB],
        env: {},
        callTimeoutMs: 45000,
        startupTimeoutMs: 2000,
        graceMs: 500,
      },
    ],
  });
  await waitFor(() => ctx.registeredTools.size === 3);

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const [server] = JSON.parse(res.body).servers;

  assert.equal(server.config.command, process.execPath);
  assert.deepEqual(server.config.args, [STUB]);
  assert.equal(server.config.callTimeoutMs, 45000);
  assert.equal(server.config.startupTimeoutMs, 2000);
  assert.equal(server.config.graceMs, 500);
  assert.equal(server.config.enabled, true);
  // Nothing configured: the key must stay absent instead of gaining a default.
  assert.equal('protocolVersion' in server.config, false);
  assert.equal('cwd' in server.config, false);
  // The negotiated value is runtime state, deliberately not configuration.
  assert.equal(server.negotiatedProtocolVersion, '2025-06-18');
  assert.equal(server.protocolVersion, '2025-06-18');

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('a server that advertises no tools capability is healthy with zero tools', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, {
    servers: [
      { id: 'notools', command: process.execPath, args: [STUB], env: { STUB_NO_TOOLS: '1' } },
    ],
  });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const [server] = JSON.parse(res.body).servers;
  // The stub still answers tools/list with three tools, so a client that called
  // it anyway would report them here.
  assert.equal(server.status, 'connected');
  assert.equal(server.error, null);
  assert.equal(server.toolCount, 0);
  assert.deepEqual(server.tools, []);
  assert.equal(ctx.registeredTools.size, 0);

  ctx.dispose();
});

test('an erroring server reports its message and stderr in the panel', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, {
    verbose: true,
    servers: [{ id: 'broken', command: 'definitely-not-a-real-binary-xyz', args: [] }],
    awaitStartupMs: 3000,
  });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const [server] = JSON.parse(res.body).servers;
  assert.equal(server.id, 'broken');
  assert.equal(server.status, 'error');
  assert.ok(typeof server.error === 'string' && server.error.length > 0);
  assert.deepEqual(server.tools, []);
  ctx.dispose();
});

test('a panel write goes through configEditor and preserves other config keys', async () => {
  const webServer = makeFakeWebServer();
  const edits = [];
  const entry = { id: 'mcp-client', options: { id: 'mcp-client' } };
  const configEditor = {
    entries: () => [entry],
    edit: async (target, change) => {
      edits.push({ target, next: change({ verbose: true, toolPrefix: 'mcp', servers: [] }, {}) });
    },
  };
  const ctx = makeCtx({ services: { webServer, configEditor } });
  await activate(ctx, { verbose: true, servers: [], awaitStartupMs: 0 });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/config.json').handler(
    makeFakeReq({ method: 'POST', body: { servers: [{ id: 'blender', command: 'uvx', args: ['blender-mcp'], env: {} }] } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].target, entry);
  assert.deepEqual(edits[0].next.servers, [
    { id: 'blender', command: 'uvx', args: ['blender-mcp'], env: {} },
  ]);
  // Keys the panel never sends must survive the write.
  assert.equal(edits[0].next.verbose, true);
  assert.equal(edits[0].next.toolPrefix, 'mcp');
  ctx.dispose();
});

test('a panel write fails cleanly when configEditor is unavailable', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, { servers: [], awaitStartupMs: 0 });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/config.json').handler(
    makeFakeReq({ method: 'POST', body: { servers: [] } }),
    res,
  );
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /configEditor/);
  ctx.dispose();
});

test('a panel reconcile restarts the named server', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  await activate(ctx, stubConfig({}, { awaitStartupMs: 5000 }));
  await waitFor(() => ctx.registeredTools.size === 3);

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/reconnect.json').handler(
    makeFakeReq({ method: 'POST', body: { id: 'stub' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  await waitFor(() => ctx.registeredTools.size === 3);

  const unknown = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/reconnect.json').handler(
    makeFakeReq({ method: 'POST', body: { id: 'nope' } }),
    unknown,
  );
  assert.equal(unknown.statusCode, 404);

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

/* -------------------------------------------------------------------------- */
/* Concurrency: reconnect and shutdown                                        */
/* -------------------------------------------------------------------------- */

test('concurrent reconnects spawn exactly one process', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  const spawns = [];
  ctx.subprocess = {
    spawn(spec) {
      spawns.push(spec);
      return nodeSpawn(spec);
    },
  };
  await activate(ctx, stubConfig({}, { awaitStartupMs: 5000 }));
  await waitFor(() => ctx.registeredTools.size === 3);
  assert.equal(spawns.length, 1);

  const route = webServer.routes.get('/dsh-mcp-client/reconnect.json');
  // Two reconnects at once: the second must join the first one's restart
  // instead of stopping the client it just started and spawning a twin.
  const both = await Promise.all([
    route.handler(makeFakeReq({ method: 'POST', body: { id: 'stub' } }), makeFakeRes()),
    route.handler(makeFakeReq({ method: 'POST', body: { id: 'stub' } }), makeFakeRes()),
  ]);
  assert.equal(both.length, 2);
  assert.equal(spawns.length, 2, 'a merged restart spawns one process, not two');
  await waitFor(() => ctx.registeredTools.size === 3);

  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('a shutdown that races a restart still kills the restarted process', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  const handles = [];
  ctx.subprocess = {
    spawn(spec) {
      // The restarted process answers slowly, which keeps the restart in flight
      // while the shutdown arrives.
      const env =
        handles.length === 0 ? spec.env : { ...spec.env, STUB_INITIALIZE_DELAY_MS: '800' };
      const handle = nodeSpawn({ ...spec, env });
      handles.push(handle);
      return handle;
    },
  };
  await activate(ctx, stubConfig({}, { awaitStartupMs: 5000 }));
  await waitFor(() => ctx.registeredTools.size === 3);
  assert.equal(handles.length, 1);

  const route = webServer.routes.get('/dsh-mcp-client/reconnect.json');
  const restarting = route.handler(
    makeFakeReq({ method: 'POST', body: { id: 'stub' } }),
    makeFakeRes(),
  );
  // The restart has replaced the process and is waiting on its handshake.
  await waitFor(() => handles.length === 2);
  // The fiber disposer stops every bridge. Without the restart-aware guard this
  // call short-circuits on `#stopped` and orphans the new process.
  ctx.dispose();
  await restarting;

  assert.equal(handles.length, 2);
  await waitFor(
    () =>
      handles.every(
        (handle) => handle.child.exitCode !== null || handle.child.signalCode !== null,
      ),
    5000,
  );
});

test('a reconnect that arrives after shutdown does not resurrect the server', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  const handles = [];
  ctx.subprocess = {
    spawn(spec) {
      const handle = nodeSpawn(spec);
      handles.push(handle);
      return handle;
    },
  };
  await activate(ctx, stubConfig({}, { awaitStartupMs: 5000 }));
  await waitFor(() => ctx.registeredTools.size === 3);
  assert.equal(handles.length, 1);

  const route = webServer.routes.get('/dsh-mcp-client/reconnect.json');
  const res = makeFakeRes();
  const request = route.handler(makeFakeReq({ method: 'POST', body: { id: 'stub' } }), res);
  // Shut down before the request body has even been read.
  ctx.dispose();
  await request.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 150));
  // Whatever the answer was, a disposed bridge must not spawn a process that
  // nothing will ever stop.
  assert.equal(res.statusCode, 200);
  assert.equal(handles.length, 1);
  await waitFor(
    () =>
      handles.every(
        (handle) => handle.child.exitCode !== null || handle.child.signalCode !== null,
      ),
    5000,
  );
});

/* -------------------------------------------------------------------------- */
/* Config-write validation                                                    */
/* -------------------------------------------------------------------------- */

test('sanitizeServersForWrite normalizes and rejects bad input', () => {
  assert.deepEqual(
    sanitizeServersForWrite([
      { id: 'blender', command: ' uvx ', args: ['blender-mcp'], env: { PORT: 9876 } },
    ]),
    [{ id: 'blender', command: 'uvx', args: ['blender-mcp'], env: { PORT: '9876' } }],
  );

  // enabled === false is preserved; anything else defaults to on.
  assert.equal(sanitizeServersForWrite([{ id: 'a', command: 'x', enabled: false }])[0].enabled, false);
  assert.equal('enabled' in sanitizeServersForWrite([{ id: 'a', command: 'x' }])[0], false);

  // cwd is only kept when non-empty.
  assert.equal(sanitizeServersForWrite([{ id: 'a', command: 'x', cwd: '  ' }])[0].cwd, undefined);
  assert.equal(sanitizeServersForWrite([{ id: 'a', command: 'x', cwd: ' D:\\w ' }])[0].cwd, 'D:\\w');

  const rejects = [
    ['not an array', /must be an array/],
    [[null], /must be an object/],
    [[{ command: 'x' }], /"id" is required/],
    [[{ id: 'a' }], /"command" is required/],
    [[{ id: 'a', command: 'x', args: 'nope' }], /"args" must be an array of strings/],
    [[{ id: 'a', command: 'x', env: [] }], /"env" must be an object/],
    [[{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }], /duplicate server id/],
  ];
  for (const [input, pattern] of rejects) {
    assert.throws(() => sanitizeServersForWrite(input), pattern);
  }
});

test('sanitizeServersForWrite inherits overrides the payload omits', () => {
  const current = [
    {
      id: 'blender',
      command: 'uvx',
      args: ['blender-mcp'],
      env: {},
      callTimeoutMs: 45000,
      startupTimeoutMs: 2000,
      graceMs: 500,
      protocolVersion: '2025-03-26',
    },
  ];

  // A toggle payload carries configuration only; nothing may be lost.
  const [written] = sanitizeServersForWrite(
    [{ id: 'blender', command: 'uvx', args: ['blender-mcp'], env: {}, enabled: false }],
    current,
  );
  assert.deepEqual(written, {
    id: 'blender',
    command: 'uvx',
    args: ['blender-mcp'],
    env: {},
    enabled: false,
    callTimeoutMs: 45000,
    startupTimeoutMs: 2000,
    graceMs: 500,
    protocolVersion: '2025-03-26',
  });

  // An explicit null is a deliberate clear, not an omission.
  const [cleared] = sanitizeServersForWrite(
    [
      {
        id: 'blender',
        command: 'uvx',
        callTimeoutMs: null,
        startupTimeoutMs: null,
        graceMs: null,
        protocolVersion: null,
      },
    ],
    current,
  );
  for (const key of ['callTimeoutMs', 'startupTimeoutMs', 'graceMs', 'protocolVersion']) {
    assert.equal(key in cleared, false, `${key} must be cleared`);
  }

  // A new id has nothing to inherit from.
  const [fresh] = sanitizeServersForWrite([{ id: 'other', command: 'uvx' }], current);
  assert.equal('callTimeoutMs' in fresh, false);
  assert.equal('protocolVersion' in fresh, false);

  // An explicitly provided value always wins over the inherited one.
  const [overridden] = sanitizeServersForWrite(
    [{ id: 'blender', command: 'uvx', callTimeoutMs: 1000, protocolVersion: '2024-11-05' }],
    current,
  );
  assert.equal(overridden.callTimeoutMs, 1000);
  assert.equal(overridden.protocolVersion, '2024-11-05');
  assert.equal(overridden.startupTimeoutMs, 2000);

  // Values still have to be usable.
  assert.throws(
    () => sanitizeServersForWrite([{ id: 'a', command: 'x', graceMs: 0 }], current),
    /"graceMs" must be a positive integer/,
  );
  assert.throws(
    () => sanitizeServersForWrite([{ id: 'a', command: 'x', graceMs: 'soon' }], current),
    /"graceMs" must be a positive integer/,
  );
});

test('a panel write keeps the overrides the panel record did not resend', async () => {
  const webServer = makeFakeWebServer();
  const edits = [];
  const entry = { id: 'mcp-client', options: { id: 'mcp-client' } };
  const configEditor = {
    entries: () => [entry],
    edit: async (_target, change) => {
      edits.push(change({ verbose: true, toolPrefix: 'mcp', servers: [] }, {}));
    },
  };
  const ctx = makeCtx({ services: { webServer, configEditor } });
  await activate(ctx, {
    verbose: true,
    awaitStartupMs: 0,
    servers: [
      {
        id: 'stub',
        command: process.execPath,
        args: [STUB],
        env: {},
        callTimeoutMs: 45000,
        startupTimeoutMs: 2000,
        graceMs: 500,
        protocolVersion: '2025-03-26',
      },
    ],
  });

  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/config.json').handler(
    makeFakeReq({
      method: 'POST',
      body: {
        servers: [
          { id: 'stub', command: process.execPath, args: [STUB], env: {}, enabled: false },
        ],
      },
    }),
    res,
  );

  assert.equal(res.statusCode, 200);
  // The switch landed, and no override (nor the configured protocol version)
  // was silently replaced by the negotiated one.
  assert.deepEqual(edits[0].servers, [
    {
      id: 'stub',
      command: process.execPath,
      args: [STUB],
      env: {},
      enabled: false,
      callTimeoutMs: 45000,
      startupTimeoutMs: 2000,
      graceMs: 500,
      protocolVersion: '2025-03-26',
    },
  ]);
  ctx.dispose();
});

test('findConfigEntry locates a loader row by patch id', () => {
  const flat = { id: 'mcp-client' };
  const nested = { options: { id: 'mcp-client' } };
  assert.equal(findConfigEntry([flat], 'mcp-client'), flat);
  assert.equal(findConfigEntry([nested], 'mcp-client'), nested);
  assert.equal(findConfigEntry([{ id: 'other' }], 'mcp-client'), undefined);
  assert.equal(findConfigEntry(undefined, 'mcp-client'), undefined);
  assert.equal(findConfigEntry([null, 'nope', 7], 'mcp-client'), undefined);
});

/* -------------------------------------------------------------------------- */
/* Child stderr: panel buffer vs. host log                                    */
/* -------------------------------------------------------------------------- */

/** Count the panel's stderr lines for one server. */
async function stderrLines(webServer, marker) {
  const res = makeFakeRes();
  await webServer.routes.get('/dsh-mcp-client/status.json').handler(makeFakeReq(), res);
  const [server] = JSON.parse(res.body).servers;
  return (server.stderr ?? []).filter((line) => line.includes(marker));
}

test('child stderr is collected in the panel without being mirrored by default', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  const captured = [];
  const original = console.error;
  console.error = (line) => captured.push(String(line));
  try {
    await activate(ctx, {
      verbose: false,
      servers: [
        {
          id: 'noisy',
          command: process.execPath,
          args: [STUB],
          env: { STUB_STDERR_NOISE: '5' },
        },
      ],
    });
    await waitFor(() => ctx.registeredTools.size === 3);
    // The panel buffer is unconditional...
    await waitFor(async () => (await stderrLines(webServer, 'stub-noise-')).length === 5);
    // ...but a non-verbose host log must not receive third-party chatter.
    assert.equal(captured.some((line) => line.includes('stub-noise-')), false);
  } finally {
    console.error = original;
  }
  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

test('verbose mirrors child stderr to the host log, rate limited', async () => {
  const webServer = makeFakeWebServer();
  const ctx = makeCtx({ services: { webServer } });
  const captured = [];
  const original = console.error;
  console.error = (line) => captured.push(String(line));
  try {
    await activate(ctx, {
      verbose: true,
      servers: [
        {
          id: 'noisy',
          command: process.execPath,
          args: [STUB],
          env: { STUB_STDERR_NOISE: '30' },
        },
      ],
    });
    await waitFor(() => ctx.registeredTools.size === 3);
    await waitFor(async () => (await stderrLines(webServer, 'stub-noise-')).length === 30);
    const logged = captured.filter((line) => line.includes('stub-noise-'));
    assert.ok(logged.length >= 1, 'verbose must still surface some stderr');
    assert.ok(logged.length <= 20, `expected at most 20 lines, got ${logged.length}`);
  } finally {
    console.error = original;
  }
  ctx.dispose();
  await waitFor(() => ctx.registeredTools.size === 0);
});

/* -------------------------------------------------------------------------- */
/* Panel request/response doubles                                             */
/* -------------------------------------------------------------------------- */

/**
 * A minimal request double. A POST carries the `content-type` the real panel
 * sends, because writes must now be same-origin JSON requests.
 */
function makeFakeReq({ method = 'GET', body, address = '127.0.0.1', headers = {} } = {}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const all = { ...headers };
  if (method === 'POST' && all['content-type'] === undefined) {
    all['content-type'] = 'application/json';
  }
  return {
    method,
    headers: all,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeFakeRes() {
  const res = { statusCode: 0, headers: {}, body: undefined };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.end = (value) => {
    res.body = value === undefined ? '' : String(value);
  };
  return res;
}
