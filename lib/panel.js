/**
 * dsh-mcp-client — host-side panel surface.
 *
 * Exposes the live MCP server state to the client half over three loopback
 * HTTP routes, and routes configuration writes through the official
 * `configEditor` service so they persist in the profile and reconcile through
 * the normal Loader path (rather than this plugin hand-editing YAML).
 *
 * Routes (exact, under /dsh-mcp-client):
 *   GET  /status.json     -> { ok, servers: [...] }
 *   POST /config.json     -> body { servers: [...] }, replaces the servers list
 *   POST /reconnect.json  -> body { id }, restarts one server
 *
 * Reads are open to any peer that can reach the web server. Writes are
 * restricted to loopback AND to same-origin JSON requests, because they mutate
 * the user's profile.
 */

const ROUTE_PREFIX = '/dsh-mcp-client';

/** Cap on a request body; the panel only ever posts a small server list. */
const MAX_BODY_BYTES = 64 * 1024;

/** Send one JSON response with an explicit no-store cache policy. */
function sendJson(res, status, payload) {
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    status = 500;
    body = JSON.stringify({ ok: false, error: `response was not serializable: ${String(error)}` });
  }
  try {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    /* the peer went away mid-response */
  }
}

/** True when the request came from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/**
 * A write must be a same-origin JSON request. Loopback alone is not
 * authentication: any page in the user's browser can POST to 127.0.0.1.
 * A CORS-simple request (text/plain / urlencoded / multipart, or a no-cors
 * fetch) can never carry application/json without a preflight, and the
 * browser refuses a cross-origin preflight here because we send no CORS
 * headers. The Origin check is deliberately limited to http(s) origins so a
 * desktop shell loading the panel from its own scheme is never rejected.
 */
function rejectUnsafeWrite(req) {
  const type = String(req.headers['content-type'] ?? '');
  if (!/^application\/json\b/i.test(type)) {
    return { status: 415, error: 'writes require content-type: application/json' };
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { status: 403, error: 'malformed origin' };
    }
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.host !== req.headers.host
    ) {
      return { status: 403, error: 'cross-origin writes are not allowed' };
    }
  } else if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') {
    return { status: 403, error: 'cross-site writes are not allowed' };
  }
  return null;
}

/** Collect and parse a JSON body, rejecting anything oversized. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body is too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('request body is not valid JSON'), { status: 400 });
  }
}

/** Wrap a thrown value in an HTTP status without leaking a stack. */
function failure(error, fallbackStatus = 500) {
  const status = Number.isInteger(error?.status) ? error.status : fallbackStatus;
  return { status, error: String(error?.message ?? error) };
}

/**
 * Register the panel routes.
 *
 * @param scope  a Cordis context that can see `webServer` (for `scope.effect`)
 * @param server the resolved web server service
 * @param deps   `{ log, snapshot, writeServers, reconnect }`
 */
export function mountPanel(scope, server, deps) {
  const register = (method, path, handler) => {
    scope.effect(
      () =>
        server.register({
          kind: 'exact',
          path,
          async handler(req, res) {
            if (req.method !== method) {
              sendJson(res, 405, { ok: false, error: `use ${method} ${path}` });
              return;
            }
            try {
              await handler(req, res);
            } catch (error) {
              const { status, error: message } = failure(error);
              if (status >= 500) deps.log('warn', `${method} ${path} failed: ${message}`);
              sendJson(res, status, { ok: false, error: message });
            }
          },
        }),
      `mcp-client: ${method} ${path}`,
    );
  };

  register('GET', `${ROUTE_PREFIX}/status.json`, async (_req, res) => {
    sendJson(res, 200, { ok: true, ...deps.snapshot() });
  });

  register('POST', `${ROUTE_PREFIX}/config.json`, async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'configuration can only be changed from this machine' });
      return;
    }
    const guard = rejectUnsafeWrite(req);
    if (guard !== null) {
      sendJson(res, guard.status, { ok: false, error: guard.error });
      return;
    }
    const body = await readJsonBody(req);
    if (!Array.isArray(body?.servers)) {
      sendJson(res, 400, { ok: false, error: 'body must be { servers: [...] }' });
      return;
    }
    const result = await deps.writeServers(body.servers);
    sendJson(res, 200, { ok: true, ...result, ...deps.snapshot() });
  });

  register('POST', `${ROUTE_PREFIX}/reconnect.json`, async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'servers can only be restarted from this machine' });
      return;
    }
    const guard = rejectUnsafeWrite(req);
    if (guard !== null) {
      sendJson(res, guard.status, { ok: false, error: guard.error });
      return;
    }
    const body = await readJsonBody(req);
    if (typeof body?.id !== 'string' || body.id === '') {
      sendJson(res, 400, { ok: false, error: 'body must be { id: "<server id>" }' });
      return;
    }
    await deps.reconnect(body.id);
    sendJson(res, 200, { ok: true, ...deps.snapshot() });
  });

  deps.log('notice', `panel mounted at ${ROUTE_PREFIX}`);
}
