import test from 'node:test';
import assert from 'node:assert/strict';

import { mountPanel } from '../lib/panel.js';

/** A fake Cordis scope exposing just `webServer.register` and `effect`. */
function makeScope() {
  const routes = new Map();
  const disposers = [];
  return {
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(factory) {
      disposers.push(factory());
    },
    routes,
    dispose() {
      for (const disposer of disposers) disposer();
    },
  };
}

/**
 * A minimal request: async-iterable body plus a peer address.
 *
 * A POST defaults to the `content-type` the real panel sends, because a write
 * now has to be a same-origin JSON request; pass `headers` to override (and
 * `origin`/`secFetchSite` for the origin checks).
 */
function makeReq({
  method = 'GET',
  body,
  address = '127.0.0.1',
  headers = {},
  origin,
  secFetchSite,
  host,
} = {}) {
  const chunks =
    body === undefined
      ? []
      : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  const all = { ...headers };
  if (method === 'POST' && all['content-type'] === undefined) {
    all['content-type'] = 'application/json';
  }
  if (origin !== undefined) all.origin = origin;
  if (secFetchSite !== undefined) all['sec-fetch-site'] = secFetchSite;
  if (host !== undefined) all.host = host;
  return {
    method,
    headers: all,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A minimal response that records what the route wrote. */
function makeRes() {
  const res = { statusCode: 0, headers: {}, body: undefined };
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.end = (value) => {
    res.body = value === undefined ? '' : String(value);
  };
  return res;
}

/** Mount the panel over a scope and return its routes. */
function mount(deps = {}) {
  const scope = makeScope();
  const calls = [];
  const log = (level, message) => calls.push({ level, message });
  mountPanel(scope, scope.webServer, {
    log,
    snapshot: () => ({ servers: [{ id: 'stub', status: 'connected', tools: [{ name: 'a' }] }] }),
    writeServers: async (servers) => {
      calls.push({ write: servers });
      return { count: servers.length };
    },
    reconnect: async (id) => {
      calls.push({ reconnect: id });
    },
    ...deps,
  });
  return { scope, calls };
}

/** Drive one route. */
async function call(scope, path, req) {
  const route = scope.routes.get(path);
  assert.ok(route !== undefined, `route ${path} is not registered`);
  const res = makeRes();
  await route.handler(req, res);
  return res;
}

test('mounts exactly the three documented routes', () => {
  const { scope } = mount();
  assert.deepEqual(
    [...scope.routes.keys()].sort(),
    [
      '/dsh-mcp-client/config.json',
      '/dsh-mcp-client/reconnect.json',
      '/dsh-mcp-client/status.json',
    ],
  );
  scope.dispose();
  assert.equal(scope.routes.size, 0);
});

test('GET status returns the snapshot with a no-store cache policy', async () => {
  const { scope } = mount();
  const res = await call(scope, '/dsh-mcp-client/status.json', makeReq());
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.servers[0].id, 'stub');
  scope.dispose();
});

test('rejects the wrong method with 405', async () => {
  const { scope } = mount();
  const res = await call(scope, '/dsh-mcp-client/status.json', makeReq({ method: 'POST' }));
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).ok, false);
  scope.dispose();
});

test('POST config writes the server list and echoes the snapshot', async () => {
  const { scope, calls } = mount();
  const servers = [{ id: 'stub', command: 'node', args: ['x.mjs'], env: {} }];
  const res = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({ method: 'POST', body: { servers } }),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.find((entry) => entry.write !== undefined).write, servers);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.servers[0].id, 'stub');
  scope.dispose();
});

test('POST config refuses a non-loopback peer with 403', async () => {
  const { scope, calls } = mount();
  const res = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({ method: 'POST', body: { servers: [] }, address: '192.168.1.20' }),
  );
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some((entry) => entry.write !== undefined), false);
  scope.dispose();
});

test('POST config requires a servers array', async () => {
  const { scope } = mount();
  for (const body of [{}, { servers: 'nope' }, { servers: null }]) {
    const res = await call(scope, '/dsh-mcp-client/config.json', makeReq({ method: 'POST', body }));
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /servers/);
  }
  scope.dispose();
});

test('POST config rejects a malformed JSON body', async () => {
  const { scope } = mount();
  const res = await call(scope, '/dsh-mcp-client/config.json', makeReq({ method: 'POST', body: '{oops' }));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /not valid JSON/);
  scope.dispose();
});

test('POST config rejects an oversized body with 413', async () => {
  const { scope } = mount();
  const huge = 'x'.repeat(70 * 1024);
  const res = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({ method: 'POST', body: JSON.stringify({ servers: [], padding: huge }) }),
  );
  assert.equal(res.statusCode, 413);
  scope.dispose();
});

test('a write failure surfaces its status instead of a stack', async () => {
  const { scope } = mount({
    writeServers: async () => {
      throw Object.assign(new Error('configEditor is unavailable'), { status: 503 });
    },
  });
  const res = await call(scope, '/dsh-mcp-client/config.json', makeReq({ method: 'POST', body: { servers: [] } }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'configEditor is unavailable' });
  scope.dispose();
});

test('POST reconnect requires an id and restarts the server', async () => {
  const { scope, calls } = mount();
  const bad = await call(scope, '/dsh-mcp-client/reconnect.json', makeReq({ method: 'POST', body: {} }));
  assert.equal(bad.statusCode, 400);

  const good = await call(
    scope,
    '/dsh-mcp-client/reconnect.json',
    makeReq({ method: 'POST', body: { id: 'stub' } }),
  );
  assert.equal(good.statusCode, 200);
  assert.equal(calls.some((entry) => entry.reconnect === 'stub'), true);
  scope.dispose();
});

test('POST reconnect refuses a non-loopback peer', async () => {
  const { scope, calls } = mount();
  const res = await call(
    scope,
    '/dsh-mcp-client/reconnect.json',
    makeReq({ method: 'POST', body: { id: 'stub' }, address: '10.0.0.5' }),
  );
  assert.equal(res.statusCode, 403);
  assert.equal(calls.some((entry) => entry.reconnect !== undefined), false);
  scope.dispose();
});

/* -------------------------------------------------------------------------- */
/* A write must be a same-origin JSON request                                 */
/*                                                                            */
/* Loopback is not authentication: any page the user has open can POST to     */
/* 127.0.0.1. Every one of these tests also proves nothing reached the write  */
/* side, not merely that the status code was pretty.                          */
/* -------------------------------------------------------------------------- */

test('a CORS-simple write is refused with 415 before the body is read', async () => {
  const { scope, calls } = mount();
  const simpleTypes = [
    'text/plain',
    'text/plain; charset=UTF-8',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=----x',
    '',
  ];
  for (const type of simpleTypes) {
    const res = await call(
      scope,
      '/dsh-mcp-client/config.json',
      makeReq({ method: 'POST', body: { servers: [] }, headers: { 'content-type': type } }),
    );
    assert.equal(res.statusCode, 415, `content-type ${JSON.stringify(type)} must be refused`);
    assert.match(JSON.parse(res.body).error, /application\/json/);
  }

  const reconnect = await call(
    scope,
    '/dsh-mcp-client/reconnect.json',
    makeReq({ method: 'POST', body: { id: 'stub' }, headers: { 'content-type': 'text/plain' } }),
  );
  assert.equal(reconnect.statusCode, 415);

  assert.equal(calls.some((entry) => entry.write !== undefined), false);
  assert.equal(calls.some((entry) => entry.reconnect !== undefined), false);
  scope.dispose();
});

test('a cross-origin JSON write is refused with 403 and never lands', async () => {
  const { scope, calls } = mount();
  const res = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({
      method: 'POST',
      body: { servers: [{ id: 'evil', command: 'calc' }] },
      origin: 'https://evil.example',
      secFetchSite: 'cross-site',
    }),
  );
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /cross-origin/);
  assert.equal(calls.some((entry) => entry.write !== undefined), false);

  // A scheme-less/relative origin cannot be parsed and must not be trusted.
  const malformed = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({ method: 'POST', body: { servers: [] }, origin: 'not a url' }),
  );
  assert.equal(malformed.statusCode, 403);
  assert.match(JSON.parse(malformed.body).error, /malformed origin/);
  assert.equal(calls.some((entry) => entry.write !== undefined), false);
  scope.dispose();
});

test('a cross-site write with no usable origin is refused with 403', async () => {
  const { scope, calls } = mount();
  for (const origin of [undefined, 'null']) {
    const res = await call(
      scope,
      '/dsh-mcp-client/reconnect.json',
      makeReq({ method: 'POST', body: { id: 'stub' }, origin, secFetchSite: 'cross-site' }),
    );
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /cross-site/);
  }
  assert.equal(calls.some((entry) => entry.reconnect !== undefined), false);
  scope.dispose();
});

test('a same-origin JSON write still succeeds', async () => {
  const { scope, calls } = mount();
  const servers = [{ id: 'stub', command: 'node', args: ['x.mjs'], env: {} }];
  const res = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({
      method: 'POST',
      body: { servers },
      origin: 'http://127.0.0.1:19387',
      host: '127.0.0.1:19387',
      secFetchSite: 'same-origin',
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.find((entry) => entry.write !== undefined).write, servers);
  assert.equal(JSON.parse(res.body).ok, true);

  const reconnect = await call(
    scope,
    '/dsh-mcp-client/reconnect.json',
    makeReq({
      method: 'POST',
      body: { id: 'stub' },
      origin: 'http://localhost:19387',
      host: 'localhost:19387',
    }),
  );
  assert.equal(reconnect.statusCode, 200);
  assert.equal(calls.some((entry) => entry.reconnect === 'stub'), true);
  scope.dispose();
});

test('a desktop-shell origin is never rejected for not being http(s)', async () => {
  const { scope, calls } = mount();
  // The Electron shell may load the panel from its own registered scheme; its
  // Origin must not be treated as hostile merely because it is not http(s).
  const shell = await call(
    scope,
    '/dsh-mcp-client/config.json',
    makeReq({ method: 'POST', body: { servers: [] }, origin: 'dsh-app://app' }),
  );
  assert.equal(shell.statusCode, 200);

  // A same-origin page with no Origin at all (and no cross-site fetch metadata)
  // is the ordinary panel case and must keep working.
  const noOrigin = await call(
    scope,
    '/dsh-mcp-client/reconnect.json',
    makeReq({ method: 'POST', body: { id: 'stub' } }),
  );
  assert.equal(noOrigin.statusCode, 200);
  assert.equal(calls.some((entry) => entry.write !== undefined), true);
  assert.equal(calls.some((entry) => entry.reconnect === 'stub'), true);
  scope.dispose();
});
