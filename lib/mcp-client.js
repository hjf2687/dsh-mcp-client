/**
 * A minimal, dependency-free Model Context Protocol client speaking JSON-RPC
 * 2.0 over the MCP stdio transport.
 *
 * Framing: the stdio transport is newline-delimited JSON — one complete
 * JSON-RPC message per line, UTF-8, no embedded newlines. It is NOT the
 * LSP-style `Content-Length` framing.
 *
 * Scope: `initialize` / `notifications/initialized`, `tools/list` (with cursor
 * pagination), `tools/call`, and the `notifications/tools/list_changed`
 * notification. Server-initiated requests are answered with "method not found"
 * rather than left hanging, because this client advertises no capabilities
 * beyond `tools`.
 *
 * The process seam is injected (`spawn`), so the client is testable without a
 * DSH runtime and without any global process state.
 */

/** Methods this client implements as a server->client request. */
const UNSUPPORTED = -32601;

/** JSON-RPC error codes we raise locally. */
const TIMEOUT = -32001;
const ABORTED = -32002;

/** Build the `argv` for one configured server, wrapping Windows shims. */
export function buildArgv(server, platform = process.platform) {
  const argv = [server.command, ...(server.args ?? [])];
  // Node cannot CreateProcess a `.cmd`/`.bat` shim without a shell, and most
  // MCP servers are launched through `npx` / `uvx` shims on Windows.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(server.command)) {
    return ['cmd.exe', '/d', '/s', '/c', ...argv];
  }
  return argv;
}

/** Serialize one message the way the stdio transport requires. */
export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a growing buffer into complete newline-delimited JSON messages.
 * Returns the messages and the unconsumed tail.
 */
export function decodeMessages(buffer) {
  const messages = [];
  let rest = buffer;
  for (;;) {
    const index = rest.indexOf('\n');
    if (index === -1) break;
    const line = rest.slice(0, index).replace(/\r$/, '').trim();
    rest = rest.slice(index + 1);
    if (line === '') continue;
    messages.push(line);
  }
  return { messages, rest };
}

/**
 * Decode one complete line of a child's stderr.
 *
 * MCP guarantees UTF-8 on the protocol stream, but stderr is free-form and on
 * Windows is frequently written in the system ANSI codepage (GBK/CP936) — which
 * turns `→` into two U+FFFD replacement characters when forced through UTF-8.
 * Try strict UTF-8 first, then the ANSI codepage, then a lossy UTF-8 pass, so a
 * diagnostic is never dropped just because of its encoding.
 */
export function decodeStderrLine(bytes) {
  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(String(bytes ?? ''), 'utf8');
  if (buffer.length === 0) return '';
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      /* not this encoding, or this Node lacks it */
    }
  }
  try {
    return new TextDecoder('utf-8').decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

/** One connected MCP server process. */
export class McpStdioClient {
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #handle = null;
  #closed = false;
  #started = false;

  /**
   * @param options.server            normalized server config
   * @param options.spawn             `(spec) => SubprocessHandle`, injected
   * @param options.cwd               fallback working directory
   * @param options.timeoutMs         default per-request timeout
   * @param options.connectTimeoutMs  handshake timeout (per-server value wins)
   * @param options.graceMs           terminate grace period (per-server value wins)
   * @param options.protocolVersion   MCP protocol version to request
   * @param options.log               `(level, message) => void`
   * @param options.onNotification    `(method, params) => void`
   * @param options.onExit            `(outcome) => void`, called exactly once
   */
  constructor(options) {
    this.server = options.server;
    this.spawn = options.spawn;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.graceMs = options.graceMs;
    this.protocolVersion = options.protocolVersion ?? '2025-06-18';
    this.log = options.log ?? (() => {});
    this.onNotification = options.onNotification ?? (() => {});
    this.onExit = options.onExit ?? (() => {});
    this.serverInfo = undefined;
    this.capabilities = undefined;
  }

  /** True once `initialize` has completed and the process is still alive. */
  get ready() {
    return this.#started && !this.#closed;
  }

  /** Spawn the process and complete the MCP handshake. */
  async start() {
    if (this.#handle !== null) throw new Error(`mcp server "${this.server.id}" is already started`);

    // A stopped (or crashed-and-stopped) client may be started again: clear the
    // flags the previous run left behind. `#settleExit` compares process
    // identity, so a late exit from the old process cannot close this run.
    this.#closed = false;
    this.#started = false;
    this.#buffer = '';

    const spec = {
      argv: buildArgv(this.server),
      cwd: this.server.cwd ?? this.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: this.server.graceMs ?? this.graceMs ?? 3000,
      // Only the explicit per-server extras. The subprocess provider adds them
      // on top of its own scrubbed copy of the parent environment
      // (`childEnv(extra) = scrubbedParentEnv() + extra`), which already
      // supplies PATH/HOME/locale and strips credentials
      // (*_KEY / *_PASSWORD / *_SECRET / *_TOKEN and every DSH_*). Spreading
      // `process.env` here would undo that scrubbing and hand the harness's own
      // credentials (DEEPSEEK_API_KEY, ...) to every third-party MCP server.
      env: { ...(this.server.env ?? {}) },
    };

    const handle = this.spawn(spec);
    this.#handle = handle;

    const { stdout, stderr } = handle;
    if (stdout === undefined || stdout === null) {
      const error = new Error(`mcp server "${this.server.id}": subprocess handle exposes no stdout`);
      await this.#recycle();
      throw error;
    }
    if (handle.stdin === undefined || handle.stdin === null) {
      const error = new Error(`mcp server "${this.server.id}": subprocess handle exposes no stdin`);
      await this.#recycle();
      throw error;
    }

    stdout.setEncoding?.('utf8');
    stdout.on('data', (chunk) => this.#consume(String(chunk)));

    if (stderr) {
      // stderr is free-form diagnostics, NOT the UTF-8 protocol stream. On
      // Windows a Python MCP server usually writes the system ANSI codepage
      // (GBK/CP936 here), so forcing UTF-8 turns every non-ASCII byte into
      // U+FFFD — the familiar `→` arriving as two diamonds. Keep the raw bytes
      // and decode each complete line with a fallback chain.
      let pending = Buffer.alloc(0);
      const emit = (bytes) => {
        const text = decodeStderrLine(bytes).replace(/\r$/, '').trimEnd();
        if (text !== '') this.log('stderr', text);
      };
      stderr.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
        for (;;) {
          const index = pending.indexOf(0x0a);
          if (index === -1) break;
          const line = pending.subarray(0, index);
          pending = pending.subarray(index + 1);
          emit(line);
        }
        // A line that never terminates must not grow without bound.
        if (pending.length > 1024 * 1024) pending = Buffer.alloc(0);
      });
      stderr.on('end', () => emit(pending));
    }

    // `done` may reject for provider-level failures; both paths funnel here.
    Promise.resolve(handle.done).then(
      (outcome) => this.#settleExit(handle, outcome ?? { exitCode: null, signal: null }),
      (error) => this.#settleExit(handle, { exitCode: null, signal: null }, error),
    );

    let result;
    try {
      result = await this.request(
        'initialize',
        {
          // A per-server override wins; otherwise the deployment default applies.
          protocolVersion: this.server.protocolVersion ?? this.protocolVersion,
          capabilities: {},
          clientInfo: { name: 'dsh-mcp-client', version: '0.1.0' },
        },
        // A per-server override wins; then the deployment default, which the
        // README documents as covering both the handshake and `tools/list`.
        { timeoutMs: this.server.startupTimeoutMs ?? this.connectTimeoutMs ?? 20000 },
      );
    } catch (error) {
      // A failed handshake must not leave an orphaned child running: the
      // caller only sees "not ready" and has no handle to clean up with.
      await this.#recycle();
      throw error;
    }

    this.serverInfo = result?.serverInfo;
    this.capabilities = result?.capabilities ?? {};
    this.#started = true;
    this.notify('notifications/initialized', {});
    return result;
  }

  /** Send a request and resolve with its `result`, rejecting on `error`. */
  request(method, params, options = {}) {
    if (this.#closed) {
      return Promise.reject(new Error(`mcp server "${this.server.id}" is closed`));
    }
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signal = options.signal;

    return new Promise((resolve, reject) => {
      let timer = null;
      let onAbort = null;

      const settle = (message) => {
        if (timer !== null) clearTimeout(timer);
        if (onAbort !== null) signal?.removeEventListener('abort', onAbort);
        if (message.error !== undefined && message.error !== null) {
          const detail =
            typeof message.error.message === 'string' && message.error.message !== ''
              ? message.error.message
              : JSON.stringify(message.error);
          const error = new Error(`mcp ${method} failed: ${detail}`);
          error.code = message.error.code;
          error.data = message.error.data;
          reject(error);
          return;
        }
        resolve(message.result);
      };

      const fail = (error) => {
        if (timer !== null) clearTimeout(timer);
        if (onAbort !== null) signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        reject(error);
      };

      this.#pending.set(id, { settle, fail });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.#pending.delete(id);
          const error = new Error(
            `mcp ${method} timed out after ${timeoutMs}ms (server "${this.server.id}")`,
          );
          error.code = TIMEOUT;
          fail(error);
        }, timeoutMs);
        timer.unref?.();
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          const error = new Error(`mcp ${method} aborted`);
          error.code = ABORTED;
          fail(error);
          return;
        }
        onAbort = () => {
          const error = new Error(`mcp ${method} aborted`);
          error.code = ABORTED;
          fail(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        fail(error);
      }
    });
  }

  /** Send a notification (no id, no reply expected). */
  notify(method, params) {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /** List every tool the server exposes, following `nextCursor` pagination. */
  async listTools(options = {}) {
    const tools = [];
    let cursor;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(
        'tools/list',
        cursor === undefined ? {} : { cursor },
        options,
      );
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      const next = result?.nextCursor;
      if (typeof next !== 'string' || next === '') break;
      cursor = next;
    }
    return tools;
  }

  /** Invoke one tool; returns the raw MCP `CallToolResult`. */
  async callTool(name, args, options = {}) {
    return this.request(
      'tools/call',
      { name, arguments: args ?? {} },
      { timeoutMs: this.server.callTimeoutMs ?? this.timeoutMs, ...options },
    );
  }

  /** Terminate the process and reject everything still in flight. */
  async stop() {
    const handle = this.#handle;
    if (handle === null && this.#closed) return;
    this.#closed = true;
    this.#started = false;
    const error = new Error(`mcp server "${this.server.id}" is closed`);
    for (const [, pending] of this.#pending) pending.fail(error);
    this.#pending.clear();
    try {
      handle?.stdin?.end?.();
    } catch {
      /* the process may already be gone */
    }
    try {
      handle?.terminate?.();
    } catch {
      /* already terminated */
    }
    // Wait for the process to actually leave, so the owning disposer resolves
    // only once nothing is still running. Without this a terminated child can
    // still hold the parent's event loop (and its stdio pipes) open.
    if (handle !== null && typeof handle?.waitForExit === 'function') {
      try {
        await Promise.race([
          handle.waitForExit(),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, 3000);
            timer.unref?.();
          }),
        ]);
      } catch {
        /* the provider could not observe the exit; termination was still requested */
      }
    }
    // Drop the handle so the same client can be started again. `#settleExit`
    // matches on process identity, so the dead process cannot affect the next
    // run, and the alternate buffer is gone with it.
    if (this.#handle === handle) this.#handle = null;
    this.#buffer = '';
  }

  // --- internals -----------------------------------------------------------

  /**
   * Terminate a half-started process and drop its handle, so a failed
   * handshake leaves no orphan and the client can be started again.
   * Never throws: the caller rethrows the original failure.
   */
  async #recycle() {
    try {
      await this.stop();
    } catch {
      /* termination was still requested */
    }
  }

  #write(message) {
    const { stdin } = this.#handle ?? {};
    if (stdin === undefined || stdin === null) {
      throw new Error(`mcp server "${this.server.id}": stdin is not writable`);
    }
    stdin.write(encodeMessage(message));
  }

  #consume(chunk) {
    const { messages, rest } = decodeMessages(this.#buffer + chunk);
    this.#buffer = rest;
    for (const line of messages) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log('warn', `non-JSON line on stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this.#dispatch(message);
    }
    // A server that never newline-terminates would grow this without bound.
    if (this.#buffer.length > 8 * 1024 * 1024) {
      this.log('warn', 'dropping oversized stdout buffer');
      this.#buffer = '';
    }
  }

  #dispatch(message) {
    if (message === null || typeof message !== 'object') return;
    const hasId = message.id !== undefined && message.id !== null;

    if (hasId && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      pending.settle(message);
      return;
    }

    if (typeof message.method === 'string') {
      // A server-initiated request carries an id and expects an answer.
      if (hasId) {
        try {
          if (message.method === 'ping') {
            // MCP requires a ping to be answered with an empty result, so a
            // server's liveness check must not turn into a "method not found".
            this.#write({ jsonrpc: '2.0', id: message.id, result: {} });
          } else {
            this.#write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: UNSUPPORTED, message: `method not supported: ${message.method}` },
            });
          }
        } catch {
          /* the process is going away */
        }
        return;
      }
      try {
        this.onNotification(message.method, message.params);
      } catch (error) {
        this.log('warn', `notification handler failed for ${message.method}: ${String(error)}`);
      }
    }
  }

  #settleExit(handle, outcome, error) {
    // A process from a previous start()/stop() cycle must not close this one.
    if (handle !== this.#handle) return;
    if (this.#closed) return;
    this.#closed = true;
    this.#started = false;
    const reason =
      error !== undefined
        ? String(error?.message ?? error)
        : `exitCode=${outcome.exitCode} signal=${outcome.signal}`;
    const closed = new Error(`mcp server "${this.server.id}" exited (${reason})`);
    for (const [, pending] of this.#pending) pending.fail(closed);
    this.#pending.clear();
    this.onExit({ outcome, error, reason });
  }
}
