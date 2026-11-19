# dsh-mcp-client

A DeepSeek Harness (DSH) plugin that connects **Model Context Protocol (MCP)**
servers over the **stdio** transport and exposes every remote tool to DSH agents
as a native tool named `mcp__<serverId>__<toolName>`.

Zero runtime dependencies: the JSON-RPC 2.0 client is implemented in this
package, so nothing is added to your profile's dependency tree and no build step
is involved.

- **Host + client**: the host half owns the connections, the client half adds an
  **MCP entry in the sidebar** with a full management panel (status, tools,
  add / edit / enable / disable / delete servers). The host half still works
  alone in a headless profile — the panel simply stays unmounted there.
- **No build step** on either half. The client bundle is a hand-written
  `window.__ModuleLoader__.load({...})` factory that only requires `react` from
  the platform module table, so nothing is added to your dependency tree.
- **stdio transport only** in v1 (covers the overwhelming majority of MCP
  servers, including Blender MCP, filesystem, git, sqlite, and friends).
- Verified shape: `initialize` → `notifications/initialized` → `tools/list`
  (with cursor pagination) → `tools/call`, plus
  `notifications/tools/list_changed` for live re-sync.

## The panel

The sidebar gains an **MCP** row (right after the shipped entries). It opens a
panel with **three separate views**.

**List** — search across id, command and arguments; one row per server (status
dot on the avatar, `stdio · <command>` subtitle, and an enable/disable switch
that applies immediately); a refresh button and **+ 新建**.

**Detail** — the read-only runtime page for one server, reached by clicking its
row. Shows state, server name and version, negotiated protocol version, tool
count, an expandable **tool list** with the exact projected `parameters` schema
each tool exposes to the model, and the child's recent **stderr** (usually the
only place a broken server explains itself). Actions: **reconnect**, **编辑配置**
and **delete**. The enable switch lives in the page header too.

**Form** — reached from **+ 新建** or the detail page's **编辑配置**, with a
breadcrumb back and a **表单 / JSON** tab pair:

- *表单*: name, type (stdio), timeout, protocol version (defaults to
  auto-negotiation), command, space-separated arguments (quote an argument that
  contains spaces), and collapsible env / working-directory sections;
- *JSON*: the raw config buffer, accepting either a bare
  `{"name": {…}}` table or the `{"mcpServers": {"name": {…}}}` wrapper other
  harnesses export, so a working config can be pasted in wholesale.

Saving returns to the server's detail page (or to the list, when a JSON paste
saved several at once). Runtime state and configuration are deliberately never
mixed on one screen.

Writes are persisted through DSH's own `configEditor` service, so they land in
the profile's patch layer and reconcile through the normal Loader path — no
hand-editing YAML, and the panel appears with an empty list when nothing is
configured. Only `servers` is replaced; every other key of the raw config
(`verbose`, `toolPrefix`, …) survives.

Reads are open to whoever can reach the web server. **Writes are restricted to
loopback and must be same-origin `application/json` requests**, because they
mutate your profile.

Loopback alone is not authentication: any page in your browser can POST to
`127.0.0.1`. A cross-site request can never be `application/json` without a CORS
preflight, and this server advertises no CORS headers, so a write is refused
with `415` unless it carries `content-type: application/json`, and with `403`
when an `http(s)` `Origin` does not match the `Host` (or when a `cross-site`
fetch arrives with no usable `Origin`). A desktop shell that loads the panel
from its own scheme is not affected: only `http(s)` origins are compared.

### Host routes

| Route | Method | Purpose |
|---|---|---|
| `/dsh-mcp-client/status.json` | GET | `{ ok, toolPrefix, servers: [...] }` |
| `/dsh-mcp-client/config.json` | POST | body `{ servers: [...] }`, replaces the list |
| `/dsh-mcp-client/reconnect.json` | POST | body `{ id }`, restarts one server |

Both POSTs require `content-type: application/json` and a same-origin (or
non-`http(s)`) `Origin`.

Each `servers[]` entry in `status.json` carries both halves of the record: the
live runtime state (`status`, `tools`, `stderr`, and the `protocolVersion` the
server actually **negotiated**, also exposed as `negotiatedProtocolVersion`) and
a read-only `config` object holding exactly what is configured
(`command`, `args`, `env`, `cwd`, `enabled`, `callTimeoutMs`,
`startupTimeoutMs`, `graceMs`, `protocolVersion`; keys with no configured value
are simply absent). Clients must write back `config`, never the runtime fields —
per-server overrides the payload omits are inherited from the configuration in
force, so an outdated client cannot erase them either.


## Requirements

- DSH with the `tools` and `subprocess` services (both are part of the standard
  bundles).
- Node.js 20+ for the plugin itself.
- Whatever runtime the target MCP server needs (`uv`, `uvx`, `npx`, ...).

## Install

From a path or a git URL:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile <name> add <path-or-git-url>
```

Then restart that profile. This plugin contributes a bundle layer
(`cordis.patch.yml`), so it takes effect when the profile loads — editing host
code afterwards is picked up through the entry's cache-busting reload, but
changing the bundle list itself needs a restart.

## Configure

The plugin ships with **no servers configured**: it starts no process and
registers no tool until you add one.

Add servers by overriding the `mcp-client` line in your profile's
`cordis.patch.yml` (or any later patch layer, e.g. a `--patch` file). A patch
line's `config` is **replaced wholesale, not deep-merged**, so restate every key
you still want:

```yaml
- id: mcp-client
  name: dsh-mcp-client
  config:
    verbose: true
    servers:
      - id: blender
        command: uvx
        args: ["blender-mcp"]

      - id: filesystem
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "D:\\work"]
        env:
          LOG_LEVEL: debug
```

### Top-level options

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the whole plugin off. |
| `verbose` | `false` | Log connect progress and every server notification. |
| `toolPrefix` | `"mcp"` | Leading segment of published tool names. |
| `connectTimeoutMs` | `20000` | Handshake and `tools/list` timeout. |
| `callTimeoutMs` | `60000` | `tools/call` timeout; also the DSH tool timeout. |
| `graceMs` | `3000` | Grace period handed to the subprocess provider on terminate. |
| `awaitStartupMs` | `10000` | Bounded wait for servers to connect before loading finishes; `0` never waits. |
| `protocolVersion` | `"2025-06-18"` | Requested MCP protocol version; the server's answer wins. |
| `resyncDebounceMs` | `250` | Coalescing window for bursts of `list_changed`. |

### Per-server options

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique; sanitized to `[A-Za-z0-9_-]`; becomes the tool namespace. |
| `command` | yes | Executable. Trimmed; bare names go through the subprocess provider's PATH. |
| `args` | no | Argument vector. Never passed through a shell. |
| `env` | no | Extra environment entries for the child process. |
| `cwd` | no | Working directory; defaults to the DSH process directory. |
| `enabled` | no | Set `false` to keep a server configured but not started. |
| `graceMs` | no | Per-server override of the top-level `graceMs`. |
| `callTimeoutMs` | no | Per-server override of the top-level `callTimeoutMs`. |
| `startupTimeoutMs` | no | Per-server handshake timeout; overrides `connectTimeoutMs` for `initialize`. |
| `protocolVersion` | no | Per-server MCP protocol version. Omit to let the server negotiate. |

`env` is **not** merged over your whole host environment. The subprocess
provider builds the child environment from a scrubbed copy of the parent
environment — it removes `*_KEY`, `*_PASSWORD`, `*_SECRET`, `*_TOKEN` and every
`DSH_*` variable — and then adds exactly the entries you list here. `PATH`,
`HOME` and the locale come from that baseline, so a credential the harness owns
(for example `DEEPSEEK_API_KEY`) is never handed to a third-party MCP server
just because it is set in the host process; list anything the server genuinely
needs under `env`.

On Windows, a `command` ending in `.cmd` / `.bat` (the `npx` / `uvx` shims) is
automatically wrapped in `cmd.exe /d /s /c`, because Node cannot `CreateProcess`
those shims directly.

## Behaviour worth knowing

- **Startup is bounded, not blocking.** Servers connect in the background, but
  the plugin waits up to `awaitStartupMs` (default 10s) for them, so a one-shot
  run's first model step already sees their tools — the model cannot call a tool
  it was never shown. After that budget the plugin loads anyway and the
  remaining servers publish their tools whenever they are ready. One broken or
  slow server never delays DSH indefinitely and never affects the others;
  failures go to the host log.
- **Remote schemas are projected, not copied.** MCP servers publish arbitrary
  JSON Schema; DSH accepts a fixed subset (`type`, `oneOf`, `properties`,
  `required`, `additionalProperties`, `items`, `enum`, `const`, plus
  `description` / `title` / `default`). `$ref`/`$defs` are resolved, `allOf` is
  folded, and anything unsupported is dropped. Dropping a constraint only
  *widens* what the model may send — the MCP server still validates the call, so
  a bad argument surfaces as an ordinary tool error.
- **`anyOf` is deliberately widened**, not guessed at: picking a branch would
  silently forbid the others, so such a field becomes unconstrained.
- **MCP-level tool errors are real DSH tool errors.** A result with
  `isError: true` makes the DSH tool throw, so the model sees a failure rather
  than successful-looking text.
- **Content is text-only in v1.** `image`, `audio`, `resource`, and
  `resource_link` blocks are reported by type and URI but not inlined.
  `structuredContent` is appended as JSON.
- **stderr is decoded tolerantly.** MCP guarantees UTF-8 on the protocol
  stream, but stderr is free-form and on Windows a Python server usually writes
  the system ANSI codepage (GBK/CP936) — which turns `→` into two U+FFFD
  replacement characters, seen as a pair of diamonds. Each stderr line is
  decoded as strict UTF-8 first, then as GBK, then lossily, so diagnostics are
  never lost to their encoding. The panel always keeps the last 40 lines;
  mirroring them into the host log is `verbose`-only and capped at 20 lines per
  server per second, so a chatty server cannot drown the log.
  `node test/fixtures/check-stderr-bytes.mjs <command> [args…]` inspects a real
  server's raw stderr when you need to prove which encoding it used.
- **A failed handshake leaves nothing behind.** `initialize` timing out (or
  failing) terminates the child process before the error is rethrown, so a
  server that never completes the handshake cannot leave an orphan holding
  pipes open.
- **Connection state is not configuration.** The panel edits the configured
  values and never writes the negotiated protocol version, the tool list or the
  status back into `servers`; a write that omits a per-server override keeps the
  configured one, and the panel clears a field you empty by sending `null`
  explicitly.
- **Reconnects are serialized.** Concurrent restarts of one server collapse
  into a single in-flight restart, so two clicks cannot spawn two processes, and
  a shutdown that races a restart still terminates the process the restart
  started.
- **Tool changes are tracked live.** `notifications/tools/list_changed` triggers
  a debounced re-sync; tools that disappear are unregistered, and tools whose
  description or `inputSchema` changed are re-registered.
- **Everything is owned.** The child process, tool registrations, routes, and
  timers are released through `ctx.effect` disposers. The server disposer
  returns a promise, so the plugin fiber resolves only once every child process
  has actually exited, and `stop()` waits for the process handle to report its
  exit rather than assuming termination was instantaneous.
- **Reloading without a restart.** `lib/plugin.js` re-imports `lib/host.js` with
  an `mtime:size` cache-busting query whenever any file in its closure changes,
  and `host.js` imports its own siblings through that same stamp. A plain
  relative `import './mcp-client.js'` would *not* be re-evaluated — a relative
  specifier does not inherit the parent URL's query string, so Node would serve
  the cached module and edited sibling code would silently keep running old
  until a full DSH restart. `test/reload.test.mjs` guards that arrangement.

  Changes to `lib/client.js` are separate: it is a browser bundle, so it needs a
  page refresh (or the client HMR receiver), not a plugin reload.

## Tool naming

```
mcp__<serverId>__<remoteToolName>
        \              \
         normalized     normalized to [A-Za-z0-9_-]
```

Example: server `blender`, remote tool `get_scene_info` →
`mcp__blender__get_scene_info`.

## Testing

```sh
npm test    # 93 tests: schema projection, protocol client, host integration,
            #           panel routes, client-bundle helpers, reload guard rails
npm run check
```

Two harnesses carry the suite:

- `test/fixtures/stub-server.mjs` — a deliberately awkward MCP server that
  paginates `tools/list`, raises `list_changed`, sends a server-initiated
  request and a `ping`, advertises a tool-less capability set, can hang or
  delay `initialize`, floods stderr, returns an `isError` result, and publishes
  an `inputSchema` full of unsupported keywords.
- `test/client-bundle.test.mjs` — loads the real `lib/client.js` with a stubbed
  `window.__ModuleLoader__` and a fake `react`, then tests the pure helpers. The
  fake `require` throws on anything but `react`, which also enforces the client
  bundle's purity.

## Limitations

- stdio transport only; no streamable-HTTP or SSE transport yet.
- No OAuth / authorization flow.
- No image inlining (see above).
- No automatic restart of a crashed server; use the panel's **reconnect**, or
  reload the plugin.
- The panel edits a server at a time and always rewrites the whole `servers`
  array; concurrent edits from two windows would last-write-win.
