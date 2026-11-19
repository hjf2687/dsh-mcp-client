/**
 * dsh-mcp-client — host implementation.
 *
 * Connects Model Context Protocol servers over the stdio transport and
 * registers each remote tool as a native DSH tool named
 * `mcp__<serverId>__<toolName>`.
 *
 * Ownership: every child process, tool registration, and timer created here
 * belongs to the plugin fiber and is released through one `ctx.effect`
 * disposer. Nothing is registered globally outside that scope.
 */

/**
 * Sibling modules are imported dynamically so that the cache-busting stamp
 * `plugin.js` puts on THIS module's URL also applies to them.
 *
 * A plain `import './mcp-client.js'` would NOT be re-evaluated when plugin.js
 * re-imports `host.js?v=<stamp>`: a relative specifier does not inherit the
 * parent URL's query string, so the sibling resolves to the same bare URL as
 * the previous load and Node hands back the cached module. Edited sibling code
 * would then silently keep running old until a full restart.
 */
const STAMP = new URL(import.meta.url).searchParams.get('v') ?? '';
const bust = (specifier) =>
  STAMP === '' ? specifier : `${specifier}?v=${encodeURIComponent(STAMP)}`;

const { McpStdioClient } = await import(bust('./mcp-client.js'));
const { mountPanel } = await import(bust('./panel.js'));
const { openObjectSchema, projectToolParameters } = await import(bust('./schema.js'));

/** Defaults applied to every field the deployment may want to change. */
const DEFAULTS = {
  enabled: true,
  toolPrefix: 'mcp',
  connectTimeoutMs: 20000,
  callTimeoutMs: 60000,
  graceMs: 3000,
  awaitStartupMs: 10000,
  protocolVersion: '2025-06-18',
  resyncDebounceMs: 250,
};

const DEFAULT_SERVER = {
  enabled: true,
  args: [],
  env: {},
};

/** Tool names must survive DSH's registry; keep them to a conservative set. */
function sanitizeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/** Build the public DSH tool name for one remote tool. */
export function publicToolName(prefix, serverId, remoteName) {
  const server = sanitizeSegment(serverId, 'server');
  const tool = sanitizeSegment(remoteName, 'tool');
  return `${prefix}__${server}__${tool}`;
}

/** Human-readable, bounded description for one bridged tool. */
function toolDescription(server, remote) {
  const detail =
    typeof remote.description === 'string' && remote.description.trim() !== ''
      ? remote.description.trim()
      : `Remote tool "${remote.name}" exposed by MCP server "${server.id}".`;
  return `${detail}\n\n[via MCP server "${server.id}" (${server.command}); remote tool name: ${remote.name}]`;
}

/** Flatten an MCP CallToolResult into one text payload plus an error flag. */
export function normalizeCallResult(serverId, remoteName, result) {
  const lines = [];
  const blocks = Array.isArray(result?.content) ? result.content : [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') lines.push(block.text);
        break;
      case 'image':
        // v1 renders text only; surfacing the type keeps the model honest about
        // what it did and did not receive.
        lines.push(`[image content (${block.mimeType ?? 'unknown type'}) not inlined by dsh-mcp-client]`);
        break;
      case 'audio':
        lines.push(`[audio content (${block.mimeType ?? 'unknown type'}) not inlined by dsh-mcp-client]`);
        break;
      case 'resource':
        lines.push(`[resource ${block.resource?.uri ?? '(no uri)'} not inlined by dsh-mcp-client]`);
        break;
      case 'resource_link':
        lines.push(`[resource_link ${block.uri ?? '(no uri)'}]`);
        break;
      default:
        lines.push(`[${String(block.type ?? 'unknown')} content]`);
        break;
    }
  }
  if (result?.structuredContent !== undefined) {
    try {
      lines.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      lines.push('[structuredContent was not JSON-serializable]');
    }
  }
  const text = lines.join('\n').trim();
  return {
    server: serverId,
    tool: remoteName,
    isError: result?.isError === true,
    text: text === '' ? '(MCP tool returned no content)' : text,
  };
}

/** Normalize the plugin config; malformed entries are skipped with a log. */
export function normalizeConfig(raw, log = () => {}) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const servers = [];
  const seen = new Set();

  const list = Array.isArray(config.servers) ? config.servers : [];
  if (config.servers !== undefined && !Array.isArray(config.servers)) {
    throw new Error('dsh-mcp-client: config.servers must be an array');
  }

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      log('warn', 'skipping non-object server entry');
      continue;
    }
    const id = sanitizeSegment(entry.id, '');
    if (id === '') {
      log('warn', `skipping server with a missing/empty id (command: ${String(entry.command)})`);
      continue;
    }
    // Validate the trimmed value AND keep it: a stray leading space would
    // otherwise reach spawn as a different executable name and fail with an
    // opaque ENOENT.
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (command === '') {
      log('warn', `skipping server "${id}": no command configured`);
      continue;
    }
    if (seen.has(id)) {
      log('warn', `skipping duplicate server id "${id}"`);
      continue;
    }
    seen.add(id);

    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      log('warn', `skipping server "${id}": args must be an array`);
      continue;
    }
    if (entry.env !== undefined && (entry.env === null || typeof entry.env !== 'object')) {
      log('warn', `skipping server "${id}": env must be an object of strings`);
      continue;
    }

    servers.push({
      ...DEFAULT_SERVER,
      ...entry,
      id,
      command,
      env: Object.fromEntries(
        Object.entries(entry.env ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    });
  }

  return {
    enabled: config.enabled !== false,
    verbose: config.verbose === true,
    toolPrefix: sanitizeSegment(config.toolPrefix, DEFAULTS.toolPrefix) || DEFAULTS.toolPrefix,
    connectTimeoutMs: positiveInt(config.connectTimeoutMs, DEFAULTS.connectTimeoutMs),
    callTimeoutMs: positiveInt(config.callTimeoutMs, DEFAULTS.callTimeoutMs),
    graceMs: positiveInt(config.graceMs, DEFAULTS.graceMs),
    awaitStartupMs: nonNegativeInt(config.awaitStartupMs, DEFAULTS.awaitStartupMs),
    protocolVersion:
      typeof config.protocolVersion === 'string' && config.protocolVersion !== ''
        ? config.protocolVersion
        : DEFAULTS.protocolVersion,
    resyncDebounceMs: positiveInt(config.resyncDebounceMs, DEFAULTS.resyncDebounceMs),
    servers,
  };
}

/** Accept only positive integers; anything else falls back to the default. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Accept zero as a meaningful "do not wait"; anything else falls back. */
function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * The *persisted* configuration of one normalized server, as the panel needs it
 * to write a server back without inventing values.
 *
 * A panel record also carries runtime state (status, tool list, and the
 * protocol version the server actually negotiated), and a client that fed those
 * runtime fields back as configuration would silently replace per-server
 * overrides with whatever happened at connect time. Keys that are not
 * configured stay `undefined` instead of gaining a default here, so the write
 * path can tell "not set" from "set".
 */
function serverConfig(server) {
  return {
    command: server.command,
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    cwd: server.cwd,
    enabled: server.enabled,
    callTimeoutMs: server.callTimeoutMs,
    startupTimeoutMs: server.startupTimeoutMs,
    graceMs: server.graceMs,
    protocolVersion: server.protocolVersion,
  };
}

/** One connected MCP server and the DSH tools it currently owns. */
class McpServerBridge {
  /** publicName -> { disposition, fingerprint } */
  #registered = new Map();
  #syncing = false;
  #syncQueued = false;
  #resyncTimer = null;
  #stopped = false;
  /** In-flight restart, so concurrent reconnects share one spawn. */
  #restarting = undefined;
  /** Rate-limit window for mirroring child stderr into the host log. */
  #stderrLogWindow = 0;
  #stderrLogLines = 0;

  /** Panel-visible state; kept separate from the tool registry. */
  #state = {
    status: 'idle',
    error: null,
    serverInfo: null,
    protocolVersion: null,
    connectedAt: null,
    tools: [],
    stderr: [],
  };

  /** Ring buffer of recent stderr lines, so the panel can explain failures. */
  static #STDERR_LINES = 40;

  /** Most stderr lines one server may add to the host log per second. */
  static #STDERR_LOG_PER_SECOND = 20;

  constructor(ctx, server, options, log, cwd) {
    this.ctx = ctx;
    this.server = server;
    this.options = options;
    this.log = log;
    this.cwd = cwd;
    this.client = null;
  }

  /** Everything the panel needs to render this server. */
  snapshot() {
    const enabled = this.server.enabled !== false;
    return {
      id: this.server.id,
      enabled,
      command: this.server.command,
      args: [...(this.server.args ?? [])],
      env: { ...(this.server.env ?? {}) },
      cwd: this.server.cwd ?? null,
      toolCount: this.#registered.size,
      connectedAt: this.#state.connectedAt,
      ...this.#state,
      // The protocol version above is the *negotiated* one, not configuration.
      // The write path must read `config.protocolVersion` instead.
      negotiatedProtocolVersion: this.#state.protocolVersion,
      config: serverConfig(this.server),
      status: enabled ? this.#state.status : 'disabled',
      stderr: [...this.#state.stderr],
    };
  }

  /** Record one line of the child's stderr. */
  #noteStderr(message) {
    const lines = message.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    this.#state.stderr.push(...lines);
    const excess = this.#state.stderr.length - McpServerBridge.#STDERR_LINES;
    if (excess > 0) this.#state.stderr.splice(0, excess);
  }

  /**
   * Mirror one stderr line into the host log: verbose-only, and capped per
   * second because a chatty server can otherwise drown the log. The panel's
   * ring buffer is fed separately and is never rate limited.
   */
  #logStderr(message) {
    if (this.options.verbose !== true) return;
    const now = Date.now();
    if (now - this.#stderrLogWindow >= 1000) {
      this.#stderrLogWindow = now;
      this.#stderrLogLines = 0;
    }
    if (this.#stderrLogLines >= McpServerBridge.#STDERR_LOG_PER_SECOND) return;
    this.#stderrLogLines += 1;
    this.log('stderr', `[${this.server.id}] ${message}`);
  }

  /** Spawn, handshake, and publish the server's tools. */
  async start() {
    this.#state.status = 'connecting';
    this.#state.error = null;
    this.#state.serverInfo = null;
    this.#state.tools = [];

    this.client = new McpStdioClient({
      server: this.server,
      spawn: (spec) => this.ctx.subprocess.spawn(spec),
      cwd: this.cwd,
      timeoutMs: this.server.callTimeoutMs ?? this.options.callTimeoutMs,
      // The per-server value still wins inside the client; these carry the
      // deployment-level defaults documented in the README.
      connectTimeoutMs: this.options.connectTimeoutMs,
      graceMs: this.options.graceMs,
      protocolVersion: this.server.protocolVersion ?? this.options.protocolVersion,
      log: (level, message) => {
        if (level === 'stderr') {
          // The panel always collects stderr; the host log is opt-in and capped.
          this.#noteStderr(message);
          this.#logStderr(message);
          return;
        }
        this.log(level, `[${this.server.id}] ${message}`);
      },
      onNotification: (method, params) => this.#onNotification(method, params),
      onExit: ({ reason }) => {
        this.log('warn', `[${this.server.id}] process ended: ${reason}`);
        this.#state.status = 'error';
        this.#state.error = `process ended (${reason})`;
        this.#unregisterAll();
      },
    });

    let init;
    try {
      init = await this.client.start();
    } catch (error) {
      const message = String(error?.message ?? error);
      this.#state.status = 'error';
      this.#state.error = message;
      throw error;
    }

    const name = init?.serverInfo?.name ?? '(unnamed)';
    const version = init?.serverInfo?.version ?? '?';
    this.#state.status = 'connected';
    this.#state.serverInfo = { name, version };
    this.#state.protocolVersion = init?.protocolVersion ?? null;
    this.#state.connectedAt = new Date().toISOString();
    this.log('info', `[${this.server.id}] connected to ${name} ${version}`);
    await this.syncTools();
  }

  /** Reconcile the remote tool list with what this bridge has registered. */
  async syncTools() {
    if (this.#stopped) return;
    if (this.#syncing) {
      this.#syncQueued = true;
      return;
    }
    this.#syncing = true;
    try {
      do {
        this.#syncQueued = false;
        await this.#syncOnce();
      } while (this.#syncQueued && !this.#stopped);
    } finally {
      this.#syncing = false;
    }
  }

  async #syncOnce() {
    if (this.client === null || !this.client.ready) return;

    // A server that does not advertise `tools` has none. Calling tools/list
    // anyway is a protocol violation, and the rejection would show up in the
    // panel as a broken server instead of a healthy one with zero tools.
    const capabilities = this.client.capabilities;
    if (capabilities === undefined || capabilities === null || capabilities.tools === undefined) {
      this.#state.error = null;
      this.#state.tools = [];
      this.#unregisterAll();
      return;
    }

    let remoteTools;
    try {
      remoteTools = await this.client.listTools({ timeoutMs: this.options.connectTimeoutMs });
    } catch (error) {
      const message = String(error?.message ?? error);
      this.#state.error = `tools/list failed: ${message}`;
      this.log('error', `[${this.server.id}] tools/list failed: ${message}`);
      return;
    }
    this.#state.error = null;

    const desired = new Map();
    for (const remote of remoteTools) {
      if (remote === null || typeof remote !== 'object') continue;
      if (typeof remote.name !== 'string' || remote.name === '') continue;

      const name = publicToolName(this.options.toolPrefix, this.server.id, remote.name);
      const fingerprint = JSON.stringify({
        description: remote.description ?? '',
        inputSchema: remote.inputSchema ?? {},
      });
      if (desired.has(name)) {
        this.log('warn', `[${this.server.id}] duplicate tool name after sanitizing: ${name}`);
        continue;
      }
      desired.set(name, { remote, fingerprint });
    }

    // Publish the remote catalogue for the panel before reconciling. The
    // projected schema is what the model actually receives, so showing it is
    // the honest thing to display.
    this.#state.tools = [...desired].map(([name, entry]) => ({
      name,
      remoteName: entry.remote.name,
      description: typeof entry.remote.description === 'string' ? entry.remote.description : '',
      parameters: projectToolParameters(entry.remote.inputSchema),
    }));

    // Drop tools that vanished or whose published schema changed.
    for (const [name, entry] of [...this.#registered]) {
      const next = desired.get(name);
      if (next !== undefined && next.fingerprint === entry.fingerprint) continue;
      this.#disposeOne(name);
    }

    // Publish new and changed tools.
    let added = 0;
    for (const [name, entry] of desired) {
      if (this.#registered.has(name)) continue;
      try {
        const dispose = this.ctx.tools.register(this.#buildToolDefinition(entry.remote));
        this.#registered.set(name, { dispose, fingerprint: entry.fingerprint });
        added += 1;
      } catch (error) {
        this.log('error', `[${this.server.id}] could not register ${name}: ${String(error?.message ?? error)}`);
      }
    }

    if (added > 0 || this.#registered.size !== desired.size) {
      this.log('info', `[${this.server.id}] ${this.#registered.size} tool(s) registered`);
    }
  }

  /** Build the DSH ToolDefinition that forwards one remote tool. */
  #buildToolDefinition(remote) {
    const client = this.client;
    const server = this.server;
    const options = this.options;
    const remoteName = remote.name;

    return {
      name: publicToolName(options.toolPrefix, server.id, remoteName),
      description: toolDescription(server, remote),
      parameters: projectToolParameters(remote.inputSchema),
      output: {
        schema: openObjectSchema(),
        render: (_args, value) => {
          if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
            return [{ type: 'text', text: value.text }];
          }
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
        },
        presentationMeta: (_args, value) => value,
      },
      timeoutMs: options.callTimeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const result = await client.callTool(remoteName, args ?? {}, { signal: exec?.signal });
        const normalized = normalizeCallResult(server.id, remoteName, result);
        if (normalized.isError) {
          // An MCP-level tool failure is a failure here too, so the model gets a
          // real tool error instead of silently successful-looking text.
          throw new Error(`MCP tool "${remoteName}" reported an error:\n${normalized.text}`);
        }
        return normalized;
      },
      presentCall(args) {
        return {
          card: 'generic',
          kind: 'other',
          title: `${server.id}: ${remoteName}`,
          rawInput: args,
        };
      },
      presentResult(_args, result) {
        const text = result?.content?.find?.((block) => block.type === 'text')?.text;
        return {
          card: 'generic',
          title: `${server.id}: ${remoteName}`,
          content: typeof text === 'string' ? [{ type: 'text', text }] : [],
        };
      },
    };
  }

  #disposeOne(name) {
    const entry = this.#registered.get(name);
    if (entry === undefined) return;
    this.#registered.delete(name);
    try {
      entry.dispose();
    } catch (error) {
      this.log('warn', `[${this.server.id}] disposing ${name} failed: ${String(error)}`);
    }
  }

  #unregisterAll() {
    for (const name of [...this.#registered.keys()]) this.#disposeOne(name);
  }

  #onNotification(method, params) {
    if (method === 'notifications/tools/list_changed') {
      this.#scheduleResync();
      return;
    }
    if (method === 'notifications/message') {
      const level = typeof params?.level === 'string' ? params.level : 'info';
      const data = typeof params?.data === 'string' ? params.data : JSON.stringify(params?.data ?? {});
      this.log('info', `[${this.server.id}] server log (${level}): ${data}`);
      return;
    }
    if (this.options.verbose) this.log('info', `[${this.server.id}] notification ${method}`);
  }

  /** Coalesce bursts of list_changed notifications into one resync. */
  #scheduleResync() {
    if (this.#resyncTimer !== null) return;
    this.#resyncTimer = setTimeout(() => {
      this.#resyncTimer = null;
      void this.syncTools();
    }, this.options.resyncDebounceMs);
    this.#resyncTimer.unref?.();
  }

  /** Release every tool and terminate the child process. */
  async stop() {
    // A restart owns the client right now: wait for it to settle first, or the
    // `#stopped` short-circuit below would let its new child outlive this call.
    const restarting = this.#restarting;
    if (restarting !== undefined) {
      try {
        await restarting;
      } catch {
        /* a failed restart is reported to whoever asked for it */
      }
    }
    return this.#stopInner();
  }

  /** Stop and start again, keeping the same registration and panel identity. */
  async restart() {
    // Concurrent reconnects must not each spawn a process: the second caller
    // joins the first one's in-flight restart instead of racing it.
    const pending = this.#restarting ?? (this.#restarting = this.#doRestart());
    try {
      await pending;
    } finally {
      if (this.#restarting === pending) this.#restarting = undefined;
    }
  }

  async #doRestart() {
    // The bridge was already shut down (the fiber is going away) before this
    // reconnect got here: starting a process now would orphan it, because no
    // disposer is left to stop it.
    if (this.#stopped) return;
    await this.#stopInner();
    this.#stopped = false;
    this.#state.stderr = [];
    this.client = null;
    await this.start();
  }

  async #stopInner() {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#resyncTimer !== null) {
      clearTimeout(this.#resyncTimer);
      this.#resyncTimer = null;
    }
    this.#unregisterAll();
    try {
      await this.client?.stop();
    } catch (error) {
      this.log('warn', `[${this.server.id}] stop failed: ${String(error)}`);
    }
    this.#state.status = 'stopped';
    this.#state.tools = [];
  }
}

/**
 * Plugin entry point. Called by the loader bootstrap in `lib/plugin.js`.
 *
 * Servers connect concurrently, then the plugin waits at most
 * `awaitStartupMs` before finishing. A slow or broken server therefore delays
 * DSH startup by a bounded amount instead of indefinitely, and a one-shot run
 * still sees its tools on the first model step.
 */
export async function activate(ctx, config) {
  const verbose = config !== null && typeof config === 'object' && config.verbose === true;
  const log = (level, message) => {
    const line = `[mcp-client] ${message}`;
    if (level === 'error' || level === 'warn') {
      console.error(line);
      return;
    }
    // Child stderr is collected in the panel's ring buffer unconditionally, but
    // mirroring third-party output into the host log is opt-in.
    if (level === 'stderr') {
      if (verbose) console.error(line);
      return;
    }
    // 'info' is verbose-only. 'notice' always prints, so a plugin that loaded
    // but has nothing to do is never invisible in the host log.
    if (level === 'notice' || verbose) console.log(line);
  };

  const options = normalizeConfig(config, log);
  if (!options.enabled) {
    log('notice', 'disabled by config');
    return;
  }

  const cwd = typeof process.cwd === 'function' ? process.cwd() : undefined;
  const bridges = options.servers
    .filter((server) => server.enabled !== false)
    .map((server) => new McpServerBridge(ctx, server, options, log, server.cwd ?? cwd));

  /** Panel view of every configured server, disabled ones included. */
  const snapshot = () => ({
    toolPrefix: options.toolPrefix,
    servers: options.servers.map((server) => {
      const bridge = bridges.find((candidate) => candidate.server.id === server.id);
      if (bridge !== undefined) return bridge.snapshot();
      return {
        id: server.id,
        enabled: false,
        command: server.command,
        args: [...(server.args ?? [])],
        env: { ...(server.env ?? {}) },
        cwd: server.cwd ?? null,
        status: 'disabled',
        error: null,
        serverInfo: null,
        protocolVersion: null,
        negotiatedProtocolVersion: null,
        connectedAt: null,
        toolCount: 0,
        tools: [],
        stderr: [],
        config: serverConfig(server),
      };
    }),
  });

  /** Persist a new server list through the official config editor. */
  const writeServers = async (rawServers, scope) => {
    const editor = resolveService(scope, ctx, 'configEditor');
    if (editor === undefined || typeof editor.edit !== 'function') {
      throw Object.assign(
        new Error('the configEditor service is unavailable — edit cordis.patch.yml by hand'),
        { status: 503 },
      );
    }
    // The live config is passed as the inheritance source: a payload that omits
    // a per-server override (an older client, or a switch that only carries
    // configuration) keeps the configured value instead of silently dropping it.
    const servers = sanitizeServersForWrite(rawServers, options.servers);
    const entry = findConfigEntry(editor.entries(), 'mcp-client');
    if (entry === undefined) {
      throw Object.assign(
        new Error('this profile has no "mcp-client" row yet — add one to cordis.patch.yml first'),
        { status: 409 },
      );
    }
    // Only `servers` is replaced; every other key of the raw config survives.
    await editor.edit(entry, (current) => ({ ...current, servers }));
    log('notice', `configuration updated: ${servers.length} server(s)`);
    return { count: servers.length };
  };

  /** Restart one server without touching configuration. */
  const reconnect = async (id) => {
    const bridge = bridges.find((candidate) => candidate.server.id === id);
    if (bridge === undefined) {
      const known = options.servers.some((server) => server.id === id);
      throw Object.assign(
        new Error(known ? `server "${id}" is disabled — enable it first` : `unknown server "${id}"`),
        { status: known ? 409 : 404 },
      );
    }
    await bridge.restart();
  };

  ctx.effect(
    () => () =>
      // Return the promise so the owning fiber resolves only once every child
      // process has actually gone away.
      Promise.all(
        bridges.map((bridge) =>
          bridge.stop().catch((error) => {
            log('warn', `[${bridge.server.id}] shutdown failed: ${String(error?.message ?? error)}`);
          }),
        ),
      ),
    'mcp-client: mcp servers',
  );

  // The panel mounts even with zero servers configured, so the first server can
  // be added from the UI instead of by hand-editing YAML.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scoped) => {
      const server = resolveService(scoped, ctx, 'webServer');
      if (server === undefined || typeof server.register !== 'function') {
        log('warn', 'webServer is unavailable: the MCP panel stays unmounted');
        return;
      }
      mountPanel(scoped, server, {
        log,
        snapshot,
        writeServers: (servers) => writeServers(servers, scoped),
        reconnect,
      });
    });
  } else {
    log('warn', 'ctx.inject is unavailable: the MCP panel stays unmounted');
  }

  // One failing server must not take down the others or the plugin fiber.
  if (bridges.length > 0) {
    const starts = bridges.map((bridge) =>
      bridge.start().catch((error) => {
        log('error', `[${bridge.server.id}] failed to start: ${String(error?.message ?? error)}`);
      }),
    );

    // Bounded startup wait. A one-shot headless run may compose its very first
    // model step before a background connection finishes, and a model cannot
    // call a tool it has not been shown. Waiting a bounded time fixes that
    // without letting one slow server hold DSH startup open indefinitely.
    if (options.awaitStartupMs > 0) {
      await Promise.race([
        Promise.all(starts),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, options.awaitStartupMs);
          timer.unref?.();
        }),
      ]);
    }
    log('notice', `started ${bridges.length} MCP server(s)`);
    return;
  }

  log('notice', 'loaded with no MCP servers configured — add one from the MCP panel');
}

/** Read a service off a scope, falling back to the outer context. */
function resolveService(scope, outer, name) {
  for (const source of [scope, outer]) {
    if (source === undefined || source === null) continue;
    try {
      if (typeof source.get === 'function') {
        const value = source.get(name);
        if (value !== undefined && value !== null) return value;
      }
      const direct = source[name];
      if (direct !== undefined && direct !== null) return direct;
    } catch {
      /* try the next source */
    }
  }
  return undefined;
}

/** Find the live Loader row this plugin was mounted through. */
export function findConfigEntry(entries, id) {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.id === id) return entry;
    const options = entry.options;
    if (options !== null && typeof options === 'object' && options.id === id) return entry;
  }
  return undefined;
}

/**
 * Validate the raw server list a panel write proposes.
 *
 * Mirrors `normalizeConfig`'s rules but throws a 400-shaped error instead of
 * silently skipping, because a human typed it and deserves to know why.
 *
 * `currentServers` is the configuration in force right now. Per-server
 * overrides the payload does not mention are inherited from it by id, so a
 * client that writes back only what it edited (or does not know about a key at
 * all) cannot erase configured values. An explicit `null` means "clear it".
 */
export function sanitizeServersForWrite(input, currentServers = []) {
  if (!Array.isArray(input)) {
    throw Object.assign(new Error('servers must be an array'), { status: 400 });
  }
  const out = [];
  const seen = new Set();

  /** id -> configured entry, the inheritance source for omitted overrides. */
  const previous = new Map();
  for (const entry of Array.isArray(currentServers) ? currentServers : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = sanitizeSegment(entry.id, '');
    if (id !== '') previous.set(id, entry);
  }

  for (const [index, entry] of input.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw Object.assign(new Error(`servers[${index}] must be an object`), { status: 400 });
    }
    const id = sanitizeSegment(entry.id, '');
    if (id === '') {
      throw Object.assign(
        new Error(`servers[${index}]: "id" is required (letters, digits, "_" and "-" only)`),
        { status: 400 },
      );
    }
    if (seen.has(id)) {
      throw Object.assign(new Error(`duplicate server id "${id}"`), { status: 400 });
    }
    seen.add(id);

    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (command === '') {
      throw Object.assign(new Error(`server "${id}": "command" is required`), { status: 400 });
    }

    const args = entry.args === undefined || entry.args === null ? [] : entry.args;
    if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
      throw Object.assign(new Error(`server "${id}": "args" must be an array of strings`), { status: 400 });
    }

    const envIn = entry.env === undefined || entry.env === null ? {} : entry.env;
    if (typeof envIn !== 'object' || Array.isArray(envIn)) {
      throw Object.assign(new Error(`server "${id}": "env" must be an object`), { status: 400 });
    }

    const server = { id, command, args: [...args], env: {} };
    for (const [key, value] of Object.entries(envIn)) {
      if (key === '') continue;
      server.env[key] = String(value ?? '');
    }
    if (typeof entry.cwd === 'string' && entry.cwd.trim() !== '') server.cwd = entry.cwd.trim();
    if (entry.enabled === false) server.enabled = false;

    // Per-server overrides the panel offers. Anything present must be usable;
    // silently dropping them would make the saved config differ from the form.
    const inherited = previous.get(id) ?? {};
    if (entry.callTimeoutMs !== undefined && entry.callTimeoutMs !== null && entry.callTimeoutMs !== '') {
      if (!Number.isInteger(entry.callTimeoutMs) || entry.callTimeoutMs <= 0) {
        throw Object.assign(
          new Error(`server "${id}": "callTimeoutMs" must be a positive integer`),
          { status: 400 },
        );
      }
      server.callTimeoutMs = entry.callTimeoutMs;
    }
    if (entry.startupTimeoutMs !== undefined && entry.startupTimeoutMs !== null && entry.startupTimeoutMs !== '') {
      if (!Number.isInteger(entry.startupTimeoutMs) || entry.startupTimeoutMs <= 0) {
        throw Object.assign(
          new Error(`server "${id}": "startupTimeoutMs" must be a positive integer`),
          { status: 400 },
        );
      }
      server.startupTimeoutMs = entry.startupTimeoutMs;
    }
    if (entry.graceMs !== undefined && entry.graceMs !== null && entry.graceMs !== '') {
      if (!Number.isInteger(entry.graceMs) || entry.graceMs <= 0) {
        throw Object.assign(
          new Error(`server "${id}": "graceMs" must be a positive integer`),
          { status: 400 },
        );
      }
      server.graceMs = entry.graceMs;
    }
    if (typeof entry.protocolVersion === 'string' && entry.protocolVersion.trim() !== '') {
      server.protocolVersion = entry.protocolVersion.trim();
    }

    // Keys the payload never mentioned (not even as null) keep their current
    // configured value. `protocolVersion` matters most: the panel record also
    // exposes the *negotiated* version, and writing that back would pin every
    // server to whatever it happened to negotiate.
    for (const key of ['callTimeoutMs', 'startupTimeoutMs', 'graceMs', 'protocolVersion']) {
      if (entry[key] === undefined && inherited[key] !== undefined && inherited[key] !== null) {
        server[key] = inherited[key];
      }
    }

    out.push(server);
  }

  return out;
}
