/**
 * dsh-mcp-client · client half
 *
 * Loaded by the Harness client module system as a factory bundle: the bootstrap
 * injects `window.__ModuleLoader__` and `require('react')` is answered from the
 * static platform module table. There is therefore no build step and no
 * dependency of our own.
 *
 * Two surfaces, matching the shipped panel conventions:
 *
 *   1. `sidebar.panellist` — one row in the left rail: icon + "MCP".
 *   2. `main` (keyed by the same id) — the panel it opens, with two views:
 *        list  — search, server rows with an enable switch, and "+ 新建"
 *        edit  — breadcrumb back to the list, a 表单 / JSON tab pair, and the
 *                live status of an existing server (tools, stderr, reconnect)
 *
 * All data comes from the host half's `/dsh-mcp-client/*.json` routes. Writes go
 * through the host's configEditor path, so they persist in the profile and
 * reconcile through the normal Loader.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mcp-client',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;

    const NS = 'dsh-mcp-client';
    const PANEL_ID = 'mcp';
    const ROUTE = '/dsh-mcp-client';
    const POLL_MS = 4000;

    /** Sentinel for "let the server negotiate"; an empty value never persists. */
    const PROTOCOL_AUTO = '';

    const JSON_TEMPLATE =
      '{\n  "my-mcp-server": {\n    "type": "stdio",\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-memory"]\n  }\n}';

    /* ------------------------------------------------------------------ */
    /* Styles                                                             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.mcp-scope{
  --mcp-fg:var(--dsw-alias-label-primary,#26272b);
  --mcp-fg-2:var(--dsw-alias-label-secondary,#5f6169);
  --mcp-accent:var(--dsw-alias-brand-primary,#3b7dff);
  --mcp-ok:var(--dsw-alias-state-success-primary,#2ea043);
  --mcp-warn:var(--dsw-alias-state-warn-primary,#bf8700);
  --mcp-err:var(--dsw-alias-state-error-primary,#d1242f);
  --mcp-idle:var(--dsw-alias-state-idle-primary,#8b8d96);
  /* The application's own page background: used to punch holes (status rings)
     and to invert the primary button. */
  --mcp-page:var(--dsw-alias-bg-base,#ffffff);

  /* Surfaces, borders and hover are DERIVED from the label color rather than
     from the shipped *-bg-layer-* tokens. In this composition those tokens
     resolve to the same value as the page background, which leaves every panel
     edge invisible. A translucent tint of the label color is guaranteed to
     differ from the page in both light and dark themes. */
  --mcp-tint:var(--dsw-alias-label-primary,#26272b);
  --mcp-fg-3:color-mix(in srgb, var(--mcp-tint) 60%, transparent);
  --mcp-bg-soft:color-mix(in srgb, var(--mcp-tint) 5%, transparent);
  --mcp-bg:color-mix(in srgb, var(--mcp-tint) 8%, transparent);
  --mcp-bg-input:color-mix(in srgb, var(--mcp-tint) 8%, transparent);
  --mcp-border-soft:color-mix(in srgb, var(--mcp-tint) 16%, transparent);
  --mcp-border:color-mix(in srgb, var(--mcp-tint) 27%, transparent);
  --mcp-hover:color-mix(in srgb, var(--mcp-tint) 10%, transparent);
  --mcp-track:color-mix(in srgb, var(--mcp-tint) 24%, transparent);
  color:var(--mcp-fg);
  font-size:13px;
  line-height:1.55;
  height:100%;
  overflow:auto;
  padding:26px 34px 48px;
  box-sizing:border-box;
}
.mcp-scope *{box-sizing:border-box}
.mcp-shell{max-width:1000px;margin:0 auto}

.mcp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.mcp-h1{font-size:26px;font-weight:700;margin:0;letter-spacing:-.01em}
.mcp-h2{font-size:17px;font-weight:650;margin:0 0 16px}
.mcp-h2-inline{font-size:21px;font-weight:650;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcp-head-detail{margin-bottom:5px}
.mcp-detail-title{display:flex;align-items:center;gap:11px;min-width:0}
.mcp-detail-title .mcp-dot{width:11px;height:11px}
.mcp-cmdline{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--mcp-fg-3);margin:0 0 18px;word-break:break-all}

.mcp-crumb{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--mcp-fg-3);margin-bottom:14px;flex-wrap:wrap}
.mcp-crumb-link{background:none;border:none;padding:0;font:inherit;color:var(--mcp-fg-2);cursor:pointer}
.mcp-crumb-link:hover{color:var(--mcp-fg);text-decoration:underline}
.mcp-crumb-sep{opacity:.6}

.mcp-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:6px}
.mcp-search{position:relative;flex:1 1 260px;min-width:200px;display:block}
.mcp-search svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--mcp-fg-3);pointer-events:none}
.mcp-search input{width:100%;background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);color:var(--mcp-fg);border-radius:999px;padding:9px 15px 9px 37px;font:inherit}
.mcp-search input:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}

.mcp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);color:var(--mcp-fg);border-radius:999px;padding:8px 16px;font:inherit;cursor:pointer;white-space:nowrap}
.mcp-btn:hover{background:var(--mcp-hover)}
.mcp-btn:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.mcp-btn[disabled]{opacity:.5;cursor:default}
.mcp-btn-icon{padding:0;width:38px;height:38px;border-radius:50%}
.mcp-btn-primary{background:var(--mcp-fg);color:var(--mcp-page);border-color:transparent;font-weight:550}
.mcp-btn-primary:hover{opacity:.88;background:var(--mcp-fg)}
.mcp-btn-danger{color:var(--mcp-err);border-color:color-mix(in srgb,var(--mcp-err) 40%,transparent)}
.mcp-btn-danger:hover{background:color-mix(in srgb,var(--mcp-err) 14%,transparent)}
.mcp-btn-sm{padding:4px 12px;font-size:12px}

.mcp-section{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;margin:24px 0 12px}
.mcp-section-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 8px;border-radius:999px;background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);color:var(--mcp-fg-2);font-size:11.5px;font-weight:500;line-height:1}

.mcp-row{display:flex;align-items:center;gap:15px;padding:13px 16px;border-radius:14px;background:var(--mcp-bg-soft);border:1px solid var(--mcp-border-soft);margin-bottom:9px;cursor:pointer;transition:background .12s ease}
.mcp-row:hover{background:var(--mcp-hover)}
.mcp-row:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.mcp-avatar{position:relative;width:46px;height:46px;border-radius:13px;background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);display:flex;align-items:center;justify-content:center;color:var(--mcp-fg-2);flex:0 0 auto}
/* The avatar picks up its status colour, so a glance down the list separates
   a healthy server from a broken one without reading any text. */
.mcp-avatar.is-connected{background:color-mix(in srgb, var(--mcp-ok) 15%, var(--mcp-bg-input));border-color:color-mix(in srgb, var(--mcp-ok) 38%, var(--mcp-border-soft));color:color-mix(in srgb, var(--mcp-ok) 85%, var(--mcp-fg))}
.mcp-avatar.is-connecting{background:color-mix(in srgb, var(--mcp-warn) 15%, var(--mcp-bg-input));border-color:color-mix(in srgb, var(--mcp-warn) 38%, var(--mcp-border-soft));color:color-mix(in srgb, var(--mcp-warn) 85%, var(--mcp-fg))}
.mcp-avatar.is-error{background:color-mix(in srgb, var(--mcp-err) 15%, var(--mcp-bg-input));border-color:color-mix(in srgb, var(--mcp-err) 40%, var(--mcp-border-soft));color:color-mix(in srgb, var(--mcp-err) 85%, var(--mcp-fg))}
.mcp-avatar .mcp-dot{position:absolute;left:-4px;bottom:-4px;box-shadow:0 0 0 3px var(--mcp-page)}
.mcp-rowtext{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.mcp-rowname{font-weight:600;font-size:14.5px;color:var(--mcp-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mcp-rowsub{font-size:12.5px;color:var(--mcp-fg-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.mcp-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto;background:var(--mcp-idle);display:inline-block}
.mcp-dot.connected{background:var(--mcp-ok)}
.mcp-dot.connecting{background:var(--mcp-warn)}
.mcp-dot.error{background:var(--mcp-err)}

.mcp-switch{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;cursor:pointer}
.mcp-switch input{position:absolute;opacity:0;width:0;height:0}
.mcp-switch-track{display:inline-block;position:relative;width:44px;height:25px;border-radius:999px;background:var(--mcp-track);transition:background .15s ease}
.mcp-switch-knob{position:absolute;top:2.5px;left:2.5px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 3px rgba(0,0,0,.28)}
.mcp-switch input:checked + .mcp-switch-track{background:var(--mcp-ok)}
.mcp-switch input:checked + .mcp-switch-track .mcp-switch-knob{transform:translateX(19px)}
.mcp-switch input:focus-visible + .mcp-switch-track{outline:2px solid var(--mcp-accent);outline-offset:2px}
.mcp-switch input:disabled + .mcp-switch-track{opacity:.45}

.mcp-empty{border:1px dashed var(--mcp-border);border-radius:14px;padding:44px 20px;text-align:center;color:var(--mcp-fg-3);background:var(--mcp-bg-soft)}
.mcp-empty-title{font-size:14px;color:var(--mcp-fg-2);margin-bottom:6px}
.mcp-hint{font-size:12px;color:var(--mcp-fg-3)}

.mcp-card{background:var(--mcp-bg-soft);border:1px solid var(--mcp-border-soft);border-radius:16px;padding:24px 26px 22px;margin-bottom:16px;box-shadow:0 1px 2px color-mix(in srgb, var(--mcp-tint) 6%, transparent)}
.mcp-tabs{display:inline-flex;gap:3px;background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);border-radius:12px;padding:3px;margin-bottom:20px}
.mcp-tab{border:none;background:transparent;color:var(--mcp-fg-2);font:inherit;padding:6px 20px;border-radius:9px;cursor:pointer}
.mcp-tab:hover{color:var(--mcp-fg)}
.mcp-tab.is-active{background:var(--mcp-page);color:var(--mcp-fg);font-weight:600;box-shadow:0 1px 3px color-mix(in srgb, var(--mcp-tint) 18%, transparent)}
.mcp-tab:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}

.mcp-field{display:flex;flex-direction:column;gap:7px;margin-bottom:17px}
.mcp-field.mcp-narrow{max-width:340px}
.mcp-label{font-size:13px;color:var(--mcp-fg-2)}
.mcp-input,.mcp-textarea,.mcp-select{background:var(--mcp-bg-input);border:1px solid var(--mcp-border-soft);color:var(--mcp-fg);border-radius:10px;padding:9px 12px;font:inherit;width:100%}
.mcp-input:hover,.mcp-textarea:hover,.mcp-select:hover{border-color:var(--mcp-border)}
.mcp-input::placeholder,.mcp-textarea::placeholder{color:var(--mcp-fg-3)}
.mcp-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;min-height:110px;resize:vertical;line-height:1.6}
.mcp-input:focus-visible,.mcp-textarea:focus-visible,.mcp-select:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.mcp-select{cursor:pointer}
.mcp-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--mcp-fg-2);cursor:pointer;margin-top:4px}
.mcp-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:22px}
.mcp-disclose{background:none;border:none;padding:0;font:inherit;color:var(--mcp-fg-2);cursor:pointer;display:inline-flex;align-items:center;gap:6px;margin:2px 0 12px}
.mcp-disclose:hover{color:var(--mcp-fg)}

.mcp-banner{border-radius:10px;padding:9px 13px;margin-bottom:14px;font-size:12.5px;word-break:break-word}
.mcp-banner.error{background:color-mix(in srgb,var(--mcp-err) 12%,transparent);border:1px solid color-mix(in srgb,var(--mcp-err) 40%,transparent);color:var(--mcp-err)}
.mcp-banner.ok{background:color-mix(in srgb,var(--mcp-ok) 12%,transparent);border:1px solid color-mix(in srgb,var(--mcp-ok) 38%,transparent);color:var(--mcp-ok)}

.mcp-status{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:16px;padding-bottom:15px;border-bottom:1px solid var(--mcp-border-soft);font-size:13px;color:var(--mcp-fg-2)}
.mcp-pre{background:var(--mcp-bg);border:1px solid var(--mcp-border-soft);border-radius:10px;padding:11px 13px;margin:9px 0 0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--mcp-fg-2);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto}
/* Tool list: one dense line per tool, expanding in place. Capped height with
   its own scroll so a server with many tools cannot push the page long. */
.mcp-toollist{max-height:440px;overflow:auto;border:1px solid var(--mcp-border-soft);border-radius:10px;background:var(--mcp-bg-soft);padding:1px 11px}
.mcp-tool{border-bottom:1px solid var(--mcp-border-soft)}
.mcp-tool:last-child{border-bottom:none}
.mcp-tool-head{display:flex;align-items:center;gap:9px;width:100%;background:none;border:none;padding:9px 2px;font:inherit;color:var(--mcp-fg);cursor:pointer;text-align:left}
.mcp-tool-head:hover{color:var(--mcp-accent)}
.mcp-tool-head:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-2px;border-radius:6px}
.mcp-tool-caret{color:var(--mcp-fg-3);flex:0 0 auto;font-size:10px}
.mcp-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;flex:0 0 auto}
.mcp-tool-summary{color:var(--mcp-fg-3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.mcp-tool-body{padding:1px 2px 13px 21px}
.mcp-tool-desc{color:var(--mcp-fg-2);font-size:12.5px;white-space:pre-wrap;line-height:1.6}
.mcp-legend{margin-top:24px;padding:11px 14px;border-radius:10px;background:var(--mcp-bg-soft);border:1px solid var(--mcp-border-soft);color:var(--mcp-fg-3);font-size:12px}
`;

    /** Inject the stylesheet once, tagged so HMR can replace it cleanly. */
    function ensureStyles() {
      if (typeof document === 'undefined') return;
      var id = NS + '-styles';
      var existing = document.querySelector('style[data-plugin="' + id + '"]');
      if (existing !== null && existing.textContent === CSS) return;
      if (existing !== null) existing.remove();
      var style = document.createElement('style');
      style.setAttribute('data-plugin', id);
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ */
    /* Host API                                                           */
    /* ------------------------------------------------------------------ */

    async function api(path, init) {
      const response = await fetch(ROUTE + path, Object.assign(
        { credentials: 'same-origin', cache: 'no-store' },
        init,
      ));
      const text = await response.text();
      let payload = null;
      try {
        payload = text === '' ? null : JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok || (payload !== null && payload.ok === false)) {
        throw new Error((payload && payload.error) || (response.status + ' ' + response.statusText));
      }
      return payload;
    }

    const fetchStatus = () => api('/status.json');
    const saveServers = (servers) =>
      api('/config.json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ servers }),
      });
    const reconnectServer = (id) =>
      api('/reconnect.json', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });

    /* ------------------------------------------------------------------ */
    /* Pure helpers (exported for node --test)                            */
    /* ------------------------------------------------------------------ */

    const STATUS_TEXT = {
      connected: '已连接',
      connecting: '连接中',
      error: '错误',
      disabled: '已禁用',
      stopped: '已停止',
      idle: '未启动',
    };

    /** Display text + class for one lifecycle status. */
    function statusMeta(status) {
      const key = typeof status === 'string' && STATUS_TEXT[status] !== undefined ? status : 'idle';
      return { key: key, text: STATUS_TEXT[key] };
    }

    /**
     * Split the form's single-line argument field. Whitespace separates
     * arguments; single or double quotes group them, so a path containing a
     * space survives. Backslash escapes inside quotes.
     */
    function splitArgs(text) {
      const source = String(text === undefined || text === null ? '' : text);
      const out = [];
      let current = '';
      let quote = null;
      let started = false;
      for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (quote !== null) {
          if (ch === quote) {
            quote = null;
          } else if (
            quote === '"' &&
            ch === '\\' &&
            (source[i + 1] === '"' || source[i + 1] === '\\')
          ) {
            // Only '"' and '\' are escapable inside double quotes, so a Windows
            // path keeps its backslashes.
            current += source[(i += 1)];
          } else {
            current += ch;
          }
          started = true;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          started = true;
          continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          if (started) {
            out.push(current);
            current = '';
            started = false;
          }
          continue;
        }
        current += ch;
        started = true;
      }
      if (started) out.push(current);
      return out;
    }

    /** Render an argument vector back into the single-line form. */
    function joinArgs(args) {
      if (!Array.isArray(args)) return '';
      return args
        .map((arg) => {
          const value = String(arg);
          if (value === '') return '""';
          if (!/[\s"']/.test(value)) return value;
          return '"' + value.replace(/(["\\])/g, '\\$1') + '"';
        })
        .join(' ');
    }

    /** One env object <-> KEY=VALUE lines. */
    function formatEnvText(env) {
      if (env === null || typeof env !== 'object') return '';
      return Object.keys(env)
        .map((key) => key + '=' + String(env[key]))
        .join('\n');
    }
    function parseEnvText(text) {
      const out = {};
      for (const raw of String(text === undefined || text === null ? '' : text).split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        if (key === '') continue;
        out[key] = line.slice(index + 1).trim();
      }
      return out;
    }

    /** The `stdio · <command> <args>` subtitle a list row shows. */
    function configCommandLine(server, transport) {
      const command = server && typeof server.command === 'string' ? server.command : '';
      const args = server && Array.isArray(server.args) ? server.args : [];
      const line = [command].concat(args).filter((part) => part !== '').join(' ');
      return (transport || 'stdio') + ' · ' + line;
    }

    /** Case-insensitive search over id, command and arguments. */
    function matchesQuery(server, query) {
      const needle = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
      if (needle === '') return true;
      const parts = [server && server.id, server && server.command];
      if (server && Array.isArray(server.args)) parts.push.apply(parts, server.args);
      return parts
        .filter((part) => typeof part === 'string')
        .join(' ')
        .toLowerCase()
        .includes(needle);
    }

    /** One-line gist of a tool description, for the collapsed tool list. */
    function toolSummary(description, maxLength) {
      const limit = Number.isInteger(maxLength) && maxLength > 4 ? maxLength : 90;
      const first =
        String(description === undefined || description === null ? '' : description)
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line) => line !== '')[0] || '';
      if (first.length <= limit) return first;
      return first.slice(0, limit - 1).trimEnd() + '…';
    }

    /**
     * The *configuration* half of a panel record.
     *
     * A host record also carries runtime state — status, the tool list, and the
     * protocol version the server actually negotiated. Feeding those back as
     * configuration silently replaces configured overrides with whatever
     * happened at connect time, so every write path reads through here instead.
     *
     * A host that predates `config` sends only flat fields; the fallback keeps
     * that combination working.
     */
    function configOf(server) {
      const source = server || {};
      const nested = source.config;
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested;
      const flat = {
        command: source.command,
        args: source.args,
        env: source.env,
        enabled: source.enabled,
      };
      if (source.cwd !== undefined && source.cwd !== null) flat.cwd = source.cwd;
      for (const key of ['callTimeoutMs', 'startupTimeoutMs', 'graceMs', 'protocolVersion']) {
        if (source[key] !== undefined) flat[key] = source[key];
      }
      return flat;
    }

    /**
     * One panel record -> the payload the host persists for that server.
     *
     * `id` is the record's identity and never comes from `config` (the host
     * exposes the id as a field, not as part of the configuration), so it is
     * re-attached here; the host requires it on every entry.
     */
    function serverToPayload(server, overrides) {
      const source = server || {};
      const config = configOf(source);
      const patch = overrides !== null && typeof overrides === 'object' ? overrides : {};
      const enabled = 'enabled' in patch ? patch.enabled !== false : config.enabled !== false;
      return Object.assign({}, config, patch, { id: String(source.id || ''), enabled: enabled });
    }

    /** Server record -> editable draft. */
    function serverToDraft(server) {
      const source = server || {};
      const config = configOf(source);
      return {
        id: String(source.id || ''),
        transport: 'stdio',
        command: String(config.command || ''),
        argsText: joinArgs(config.args),
        envText: formatEnvText(config.env),
        cwd: String(config.cwd || ''),
        timeoutMs: config.callTimeoutMs ? String(config.callTimeoutMs) : '',
        // Never the negotiated version: an empty value means "let the server
        // negotiate".
        protocolVersion: typeof config.protocolVersion === 'string' ? config.protocolVersion : PROTOCOL_AUTO,
        enabled: config.enabled !== false,
      };
    }

    /**
     * Mark the overrides the form and JSON editors can empty as explicitly
     * cleared (`null`), so the host does not inherit the configured value.
     *
     * The host keeps a configured override when a write simply omits the key,
     * which is what protects fields the panel never shows (startupTimeoutMs,
     * graceMs). The two it does show — the call timeout and the protocol
     * version — must therefore be able to say "none", otherwise emptying the
     * field or picking 自动 would leave the old value pinned in place.
     */
    function withClearedOverrides(server) {
      const out = Object.assign({}, server);
      if (!('callTimeoutMs' in out)) out.callTimeoutMs = null;
      if (!('protocolVersion' in out)) out.protocolVersion = null;
      return out;
    }

    /** Editable draft -> the record the host expects. */
    function draftToServer(draft) {
      const server = {
        id: String(draft.id || '').trim(),
        command: String(draft.command || '').trim(),
        args: splitArgs(draft.argsText),
        env: parseEnvText(draft.envText),
        enabled: draft.enabled !== false,
      };
      const cwd = String(draft.cwd || '').trim();
      if (cwd !== '') server.cwd = cwd;
      const timeout = String(
        draft.timeoutMs === undefined || draft.timeoutMs === null ? '' : draft.timeoutMs,
      ).trim();
      if (timeout !== '') server.callTimeoutMs = Number(timeout);
      const protocol = String(draft.protocolVersion || '').trim();
      if (protocol !== '') server.protocolVersion = protocol;
      return server;
    }

    /** Client-side validation mirroring the host's, for immediate feedback. */
    function validateDraft(draft, allServers, editingId) {
      const id = String(draft.id || '').trim();
      if (id === '') return '名称不能为空';
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return '名称只能包含字母、数字、下划线和连字符';
      if (String(draft.command || '').trim() === '') return '命令不能为空';
      const timeout = String(
        draft.timeoutMs === undefined || draft.timeoutMs === null ? '' : draft.timeoutMs,
      ).trim();
      if (timeout !== '' && !(Number.isInteger(Number(timeout)) && Number(timeout) > 0)) {
        return '超时时间必须是正整数';
      }
      const clash = (allServers || []).some((server) => server.id === id && server.id !== editingId);
      if (clash) return '已存在同名 server:「' + id + '」';
      return null;
    }

    /** The buffer the JSON editor should contain for these servers. */
    function formatJsonConfig(servers) {
      const table = {};
      for (const server of servers || []) {
        const config = configOf(server);
        const entry = { type: 'stdio', command: config.command || '', args: config.args || [] };
        if (config.env && Object.keys(config.env).length > 0) entry.env = config.env;
        if (config.cwd) entry.cwd = config.cwd;
        if (config.callTimeoutMs) entry.timeout = config.callTimeoutMs;
        if (config.protocolVersion) entry.protocolVersion = config.protocolVersion;
        if (config.enabled === false) entry.enabled = false;
        table[server.id] = entry;
      }
      return JSON.stringify(table, null, 2);
    }

    /**
     * Parse a pasted config buffer. Accepts a bare `{"name": {...}}` table or one
     * wrapped in `{"mcpServers": {...}}`, which is what other harnesses export.
     */
    function parseJsonConfig(text) {
      let data;
      try {
        data = JSON.parse(String(text === undefined || text === null ? '' : text));
      } catch (error) {
        throw new Error('JSON 解析失败:' + String((error && error.message) || error));
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('JSON 顶层必须是一个对象');
      }
      const wrapped = data.mcpServers;
      const table =
        wrapped !== undefined && wrapped !== null && typeof wrapped === 'object' && !Array.isArray(wrapped)
          ? wrapped
          : data;
      const out = [];
      for (const id of Object.keys(table)) {
        const value = table[id];
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('「' + id + '」的配置必须是一个对象');
        }
        if (value.type !== undefined && value.type !== 'stdio') {
          throw new Error('「' + id + '」只支持 stdio 传输(type 为 "' + String(value.type) + '")');
        }
        const server = { id: id };
        server.command = typeof value.command === 'string' ? value.command : '';
        server.args = Array.isArray(value.args) ? value.args.map((arg) => String(arg)) : [];
        server.env =
          value.env !== null && typeof value.env === 'object' && !Array.isArray(value.env) ? value.env : {};
        if (typeof value.cwd === 'string' && value.cwd !== '') server.cwd = value.cwd;
        const timeout = value.timeout === undefined ? value.callTimeoutMs : value.timeout;
        if (typeof timeout === 'number' && timeout > 0) server.callTimeoutMs = timeout;
        if (typeof value.protocolVersion === 'string' && value.protocolVersion !== '') {
          server.protocolVersion = value.protocolVersion;
        }
        if (value.enabled === false) server.enabled = false;
        out.push(server);
      }
      return out;
    }

    /* ------------------------------------------------------------------ */
    /* Glyphs                                                             */
    /* ------------------------------------------------------------------ */

    const plugPaths = [
      h('path', { d: 'M9 3v5', key: 'a' }),
      h('path', { d: 'M15 3v5', key: 'b' }),
      h('path', { d: 'M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z', key: 'c' }),
      h('path', { d: 'M12 17v4', key: 'd' }),
    ];

    const plugSvg = (size) =>
      h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        plugPaths,
      );

    /** Sidebar rail icon. */
    const PanelGlyph = (props) => plugSvg(props && typeof props.size === 'number' ? props.size : 18);

    /** Avatar glyph in a list row. */
    const ServerGlyph = () => plugSvg(22);

    const SearchGlyph = () =>
      h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-3.5-3.5' }),
      );

    const RefreshGlyph = () =>
      h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.3' }),
        h('path', { d: 'M20 4v7h-7' }),
      );

    /* ------------------------------------------------------------------ */
    /* Components                                                         */
    /* ------------------------------------------------------------------ */

    /** An accessible on/off switch. */
    function Switch(props) {
      const label = props.title || (props.checked ? '点击禁用' : '点击启用');
      return h(
        'label',
        { className: 'mcp-switch', onClick: (event) => event.stopPropagation(), title: label },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          'aria-label': label,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', { className: 'mcp-switch-track' }, h('span', { className: 'mcp-switch-knob' })),
      );
    }

    /** One row in the server list. */
    function ServerRow(props) {
      const server = props.server;
      const meta = statusMeta(server.status);
      return h(
        'div',
        {
          className: 'mcp-row',
          role: 'button',
          tabIndex: 0,
          onClick: () => props.onOpen(server),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              props.onOpen(server);
            }
          },
        },
        h(
          'span',
          { className: 'mcp-avatar is-' + meta.key },
          h(ServerGlyph),
          h('span', { className: 'mcp-dot ' + meta.key, title: meta.text, 'aria-label': meta.text }),
        ),
        h(
          'span',
          { className: 'mcp-rowtext' },
          h('span', { className: 'mcp-rowname' }, server.id),
          h('span', { className: 'mcp-rowsub' }, configCommandLine(server)),
        ),
        h(Switch, {
          checked: server.enabled !== false,
          disabled: props.busy,
          title: server.enabled !== false ? '已启用,点击禁用' : '已禁用,点击启用',
          onChange: (next) => props.onToggle(server, next),
        }),
      );
    }

    /** The 表单 tab. */
    function ServerForm(props) {
      const draft = props.draft;
      const set = (key) => (event) => {
        const value = event && event.target ? event.target.value : event;
        props.onChange(Object.assign({}, draft, { [key]: value }));
      };

      const field = (label, key, options) => {
        const config = options || {};
        const control = config.textarea
          ? h('textarea', {
              className: 'mcp-textarea',
              value: draft[key],
              onChange: set(key),
              spellCheck: false,
              rows: config.rows || 5,
            })
          : config.select
            ? h(
                'select',
                { className: 'mcp-select', value: draft[key], onChange: set(key) },
                config.select.map((option) =>
                  h('option', { key: option.value, value: option.value }, option.label),
                ),
              )
            : h('input', {
                className: 'mcp-input',
                value: draft[key],
                onChange: set(key),
                spellCheck: false,
                placeholder: config.placeholder || '',
              });
        return h(
          'div',
          { className: 'mcp-field' + (config.narrow ? ' mcp-narrow' : '') },
          label === null ? null : h('label', { className: 'mcp-label' }, label),
          control,
          config.hint ? h('span', { className: 'mcp-hint' }, config.hint) : null,
        );
      };

      const disclose = (label, shown, onToggle) =>
        h(
          'button',
          { className: 'mcp-disclose', onClick: onToggle, type: 'button' },
          (shown ? '▾ ' : '▸ ') + label,
        );

      return h(
        'div',
        null,
        field('名称', 'id', {
          narrow: true,
          placeholder: 'my-mcp-server',
          hint: '工具会叫 mcp__<名称>__<工具名>',
        }),
        field('类型', 'transport', {
          narrow: true,
          select: [{ value: 'stdio', label: 'stdio（本地命令）' }],
        }),
        field('超时时间 MS', 'timeoutMs', { narrow: true, placeholder: '默认 60000' }),
        field('协议版本', 'protocolVersion', {
          narrow: true,
          hint:
            draft.protocolVersion === PROTOCOL_AUTO
              ? props.negotiatedProtocolVersion
                ? '自动（当前协商：' + props.negotiatedProtocolVersion + '）'
                : '自动（连接后由服务器协商）'
              : '固定为所选版本',
          select: [
            { value: PROTOCOL_AUTO, label: '自动（推荐）' },
            { value: '2025-06-18', label: '2025-06-18' },
            { value: '2025-03-26', label: '2025-03-26' },
            { value: '2024-11-05', label: '2024-11-05' },
          ],
        }),
        field('命令', 'command', { placeholder: 'npx' }),
        field('参数（空格分隔）', 'argsText', {
          placeholder: '-y @modelcontextprotocol/server-memory',
          hint: '含空格的参数请用引号包起来,例如 "C:\\Program Files\\x.exe"',
        }),
        disclose('环境变量（可选）', props.showEnv, props.onToggleEnv),
        props.showEnv
          ? field(null, 'envText', { textarea: true, rows: 4, hint: '每行一个 KEY=VALUE' })
          : null,
        disclose('工作目录（可选）', props.showAdvanced, props.onToggleAdvanced),
        props.showAdvanced
          ? field(null, 'cwd', { placeholder: '留空则使用 DSH 进程目录' })
          : null,
        h(
          'label',
          { className: 'mcp-check' },
          h('input', {
            type: 'checkbox',
            checked: draft.enabled !== false,
            onChange: (event) => props.onChange(Object.assign({}, draft, { enabled: event.target.checked })),
          }),
          '启用（关闭则保留配置但不启动进程）',
        ),
      );
    }

    /** Live status of an existing server: tools, stderr, actions. */
    function ServerStatus(props) {
      const server = props.server;
      const meta = statusMeta(server.status);
      const tools = Array.isArray(server.tools) ? server.tools : [];
      const stderr = Array.isArray(server.stderr) ? server.stderr : [];
      const [openTools, setOpenTools] = useState(false);
      const [openTool, setOpenTool] = useState(null);
      const [openSchema, setOpenSchema] = useState(null);
      const [openStderr, setOpenStderr] = useState(false);

      return h(
        'div',
        { className: 'mcp-card' },
        h(
          'div',
          { className: 'mcp-status' },
          h('span', { className: 'mcp-dot ' + meta.key }),
          h('span', null, meta.text),
          server.serverInfo
            ? h('span', null, '· ' + server.serverInfo.name + ' ' + server.serverInfo.version)
            : null,
          server.negotiatedProtocolVersion
            ? h('span', null, '· 协商协议 ' + server.negotiatedProtocolVersion)
            : null,
          h('span', null, '· ' + tools.length + ' 个工具'),
        ),
        server.error ? h('div', { className: 'mcp-banner error' }, server.error) : null,
        tools.length > 0
          ? h(
              'div',
              null,
              h(
                'button',
                { className: 'mcp-disclose', onClick: () => setOpenTools((value) => !value), type: 'button' },
                (openTools ? '▾ ' : '▸ ') + '工具列表（' + tools.length + '）',
              ),
              openTools
                ? h(
                    'div',
                    { className: 'mcp-toollist' },
                    tools.map((tool) => {
                      const expandedTool = openTool === tool.name;
                      return h(
                        'div',
                        { className: 'mcp-tool' + (expandedTool ? ' is-open' : ''), key: tool.name },
                        h(
                          'button',
                          {
                            className: 'mcp-tool-head',
                            type: 'button',
                            'aria-expanded': expandedTool,
                            onClick: () => setOpenTool(expandedTool ? null : tool.name),
                          },
                          h('span', { className: 'mcp-tool-caret' }, expandedTool ? '▾' : '▸'),
                          h('span', { className: 'mcp-tool-name' }, tool.name),
                          expandedTool
                            ? null
                            : h('span', { className: 'mcp-tool-summary' }, toolSummary(tool.description)),
                        ),
                        expandedTool
                          ? h(
                              'div',
                              { className: 'mcp-tool-body' },
                              h(
                                'div',
                                { className: 'mcp-tool-desc' },
                                tool.description || '（该工具没有描述）',
                              ),
                              h(
                                'button',
                                {
                                  className: 'mcp-btn mcp-btn-sm',
                                  style: { marginTop: '9px' },
                                  type: 'button',
                                  onClick: () =>
                                    setOpenSchema((current) =>
                                      current === tool.name ? null : tool.name,
                                    ),
                                },
                                openSchema === tool.name ? '隐藏参数 schema' : '查看参数 schema',
                              ),
                              openSchema === tool.name
                                ? h(
                                    'pre',
                                    { className: 'mcp-pre' },
                                    JSON.stringify(tool.parameters, null, 2),
                                  )
                                : null,
                            )
                          : null,
                      );
                    }),
                  )
                : null,
            )
          : null,
        stderr.length > 0
          ? h(
              'div',
              null,
              h(
                'button',
                { className: 'mcp-disclose', onClick: () => setOpenStderr((value) => !value), type: 'button' },
                (openStderr ? '▾ ' : '▸ ') + 'stderr 输出（' + stderr.length + ' 行）',
              ),
              openStderr ? h('pre', { className: 'mcp-pre' }, stderr.join('\n')) : null,
            )
          : null,
        h(
          'div',
          { className: 'mcp-actions' },
          h(
            'button',
            {
              className: 'mcp-btn',
              disabled: props.busy || server.enabled === false,
              onClick: () => props.onReconnect(server.id),
            },
            '重连',
          ),
          h('button', { className: 'mcp-btn', disabled: props.busy, onClick: props.onEdit }, '编辑配置'),
          h(
            'button',
            {
              className: 'mcp-btn mcp-btn-danger',
              disabled: props.busy,
              onClick: () => props.onDelete(server.id),
            },
            props.confirmingDelete ? '确认删除' : '删除',
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Panel                                                              */
    /* ------------------------------------------------------------------ */

    function McpPanel(props) {
      const [servers, setServers] = useState([]);
      const [loadError, setLoadError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [query, setQuery] = useState('');
      const [view, setView] = useState({ kind: 'list' });
      const [draft, setDraft] = useState(null);
      const [tab, setTab] = useState('form');
      const [jsonText, setJsonText] = useState('');
      const [formError, setFormError] = useState(null);
      const [showEnv, setShowEnv] = useState(false);
      const [showAdvanced, setShowAdvanced] = useState(false);
      const [confirmingDelete, setConfirmingDelete] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const data = await fetchStatus();
          setServers(Array.isArray(data && data.servers) ? data.servers : []);
          setLoadError(null);
        } catch (error) {
          setLoadError(String((error && error.message) || error));
        }
      }, []);

      useEffect(() => {
        let alive = true;
        let inflight = false;
        const tick = async () => {
          if (!alive || inflight) return;
          inflight = true;
          try {
            const data = await fetchStatus();
            if (alive) {
              setServers(Array.isArray(data && data.servers) ? data.servers : []);
              setLoadError(null);
            }
          } catch (error) {
            if (alive) setLoadError(String((error && error.message) || error));
          } finally {
            inflight = false;
          }
        };
        void tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      /**
       * Persist a server list, then optionally navigate. `nextView` of
       * `undefined` keeps the caller where it is, which is what a switch toggle
       * from the list or the detail page wants.
       */
      const commit = useCallback(
        async (nextServers, message, nextView) => {
          setBusy(true);
          setFormError(null);
          setNotice(null);
          try {
            await saveServers(nextServers);
            setNotice(message || '已保存,配置正在重新加载');
            if (nextView !== undefined) setView(nextView);
            setDraft(null);
            setConfirmingDelete(false);
            setTimeout(() => void refresh(), 700);
          } catch (error) {
            setFormError(String((error && error.message) || error));
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      /** Clear every piece of form/navigation state that must not leak across views. */
      const resetForm = () => {
        setDraft(null);
        setTab('form');
        setJsonText('');
        setFormError(null);
        setConfirmingDelete(false);
        setShowEnv(false);
        setShowAdvanced(false);
      };

      const openList = () => {
        resetForm();
        setView({ kind: 'list' });
      };

      /** The read-only runtime page for one server. */
      const openDetail = (server) => {
        resetForm();
        setView({ kind: 'detail', id: server.id });
      };

      /** The configuration form: no server means "create a new one". */
      const openForm = (server) => {
        resetForm();
        if (server === undefined || server === null) {
          setDraft({
            id: '',
            transport: 'stdio',
            command: '',
            argsText: '',
            envText: '',
            cwd: '',
            timeoutMs: '',
            protocolVersion: PROTOCOL_AUTO,
            enabled: true,
          });
          setJsonText('');
          setView({ kind: 'form', id: null });
          return;
        }
        setDraft(serverToDraft(server));
        setJsonText(formatJsonConfig([server]));
        setShowEnv(Object.keys(server.env || {}).length > 0);
        setShowAdvanced(Boolean(server.cwd));
        setView({ kind: 'form', id: server.id });
      };

      /** Leave the form for wherever it was opened from. */
      const closeForm = () => {
        const id = view.id;
        resetForm();
        setView(id === null || id === undefined ? { kind: 'list' } : { kind: 'detail', id });
      };

      const submitForm = () => {
        const problem = validateDraft(draft, servers, view.id);
        if (problem !== null) {
          setFormError(problem);
          return;
        }
        const server = withClearedOverrides(draftToServer(draft));
        // Servers that are not being edited are written from their own config,
        // never from the runtime record the status poll returned.
        const rest = servers
          .filter((item) => item.id !== view.id)
          .map((item) => serverToPayload(item));
        void commit(rest.concat([server]), '已保存「' + server.id + '」', {
          kind: 'detail',
          id: server.id,
        });
      };

      const submitJson = () => {
        if (String(jsonText).trim() === '') {
          setFormError('JSON 配置不能为空');
          return;
        }
        let parsed;
        try {
          parsed = parseJsonConfig(jsonText);
        } catch (error) {
          setFormError(String((error && error.message) || error));
          return;
        }
        if (parsed.length === 0) {
          setFormError('没有解析出任何 server');
          return;
        }
        for (const server of parsed) {
          const problem = validateDraft(
            {
              id: server.id,
              command: server.command,
              timeoutMs: server.callTimeoutMs ? String(server.callTimeoutMs) : '',
            },
            servers,
            view.id,
          );
          if (problem !== null) {
            setFormError(problem);
            return;
          }
        }
        const merged = servers
          .filter((item) => item.id !== view.id)
          .map((item) => serverToPayload(item));
        // The JSON buffer is seeded from the full configuration, so a key the
        // user deleted is a deliberate clear rather than an omission.
        for (const server of parsed.map((entry) => withClearedOverrides(entry))) {
          const index = merged.findIndex((item) => item.id === server.id);
          if (index === -1) merged.push(server);
          else merged[index] = server;
        }
        void commit(
          merged,
          '已保存 ' + parsed.length + ' 个 server',
          parsed.length === 1 ? { kind: 'detail', id: parsed[0].id } : { kind: 'list' },
        );
      };

      const onToggle = (server, next) => {
        // Every row is written from its own configuration, so flipping one
        // switch cannot rewrite a neighbour's overrides from runtime state.
        const nextServers = servers.map((item) =>
          item.id === server.id ? serverToPayload(item, { enabled: next }) : serverToPayload(item),
        );
        void commit(nextServers, (next ? '已启用「' : '已禁用「') + server.id + '」');
      };

      const onReconnect = async (id) => {
        setBusy(true);
        setNotice(null);
        try {
          await reconnectServer(id);
          setNotice('已重连「' + id + '」');
          await refresh();
        } catch (error) {
          setLoadError(String((error && error.message) || error));
        } finally {
          setBusy(false);
        }
      };

      const onDelete = (id) => {
        if (!confirmingDelete) {
          setConfirmingDelete(true);
          return;
        }
        void commit(
          servers
            .filter((item) => item.id !== id)
            .map((item) => serverToPayload(item)),
          '已删除「' + id + '」',
          { kind: 'list' },
        );
      };

      const visible = servers.filter((server) => matchesQuery(server, query));
      /** The server a detail or form page is about; `undefined` while creating. */
      const viewedServer =
        view.kind === 'list' || view.id === null
          ? undefined
          : servers.find((server) => server.id === view.id);

      /* ------------------------------ list view ------------------------- */

      const listView = () =>
        h(
          'div',
          null,
          h(
            'div',
            { className: 'mcp-head' },
            h('h1', { className: 'mcp-h1' }, 'MCP 服务器'),
            props.backToConversation
              ? h(
                  'button',
                  { className: 'mcp-btn mcp-btn-sm', onClick: props.backToConversation },
                  '← 返回对话',
                )
              : null,
          ),
          loadError !== null ? h('div', { className: 'mcp-banner error' }, loadError) : null,
          notice !== null ? h('div', { className: 'mcp-banner ok' }, notice) : null,
          h(
            'div',
            { className: 'mcp-toolbar' },
            h(
              'span',
              { className: 'mcp-search' },
              h(SearchGlyph),
              h('input', {
                value: query,
                onChange: (event) => setQuery(event.target.value),
                placeholder: '搜索 MCP 服务器…',
                spellCheck: false,
                'aria-label': '搜索 MCP 服务器',
              }),
            ),
            h(
              'button',
              {
                className: 'mcp-btn mcp-btn-icon',
                onClick: () => void refresh(),
                disabled: busy,
                title: '刷新',
                'aria-label': '刷新',
              },
              h(RefreshGlyph),
            ),
            h(
              'button',
              { className: 'mcp-btn mcp-btn-primary', onClick: () => openForm(null), disabled: busy },
              '+ 新建',
            ),
          ),
          servers.length === 0
            ? h(
                'div',
                { className: 'mcp-empty', style: { marginTop: '18px' } },
                h('div', { className: 'mcp-empty-title' }, '还没有配置任何 MCP server'),
                h('div', { className: 'mcp-hint' }, '点「+ 新建」接一个,例如 uvx blender-mcp'),
              )
            : h(
                'div',
                null,
                h(
                  'div',
                  { className: 'mcp-section' },
                  '已安装',
                  h('span', { className: 'mcp-section-count' }, String(visible.length)),
                ),
                visible.length === 0
                  ? h('div', { className: 'mcp-empty' }, '没有匹配「' + query + '」的 server')
                  : visible.map((server) =>
                      h(ServerRow, {
                        key: server.id,
                        server: server,
                        busy: busy,
                        onOpen: openDetail,
                        onToggle: onToggle,
                      }),
                    ),
              ),
          h(
            'div',
            { className: 'mcp-legend' },
            '写入会通过 configEditor 持久化到本 profile,并走正常 Loader 重载。配置修改只对本机开放。',
          ),
        );

      /* ----------------------------- detail view ------------------------ */

      const detailView = () => {
        if (viewedServer === undefined) {
          return h(
            'div',
            null,
            h(
              'div',
              { className: 'mcp-crumb' },
              h('button', { className: 'mcp-crumb-link', onClick: openList }, 'MCP 服务器'),
            ),
            h(
              'div',
              { className: 'mcp-empty' },
              h('div', { className: 'mcp-empty-title' }, '找不到「' + view.id + '」'),
              h('div', { className: 'mcp-hint' }, '它可能已经在别处被删除了。'),
            ),
          );
        }
        const meta = statusMeta(viewedServer.status);
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'mcp-crumb' },
            h('button', { className: 'mcp-crumb-link', onClick: openList }, 'MCP 服务器'),
            h('span', { className: 'mcp-crumb-sep' }, '›'),
            h('span', null, viewedServer.id),
          ),
          h(
            'div',
            { className: 'mcp-head mcp-head-detail' },
            h(
              'div',
              { className: 'mcp-detail-title' },
              h('span', { className: 'mcp-dot ' + meta.key, title: meta.text, 'aria-label': meta.text }),
              h('h2', { className: 'mcp-h2-inline' }, viewedServer.id),
            ),
            h(Switch, {
              checked: viewedServer.enabled !== false,
              disabled: busy,
              title: viewedServer.enabled !== false ? '已启用,点击禁用' : '已禁用,点击启用',
              onChange: (next) => onToggle(viewedServer, next),
            }),
          ),
          h('div', { className: 'mcp-cmdline' }, configCommandLine(viewedServer)),
          loadError !== null ? h('div', { className: 'mcp-banner error' }, loadError) : null,
          notice !== null ? h('div', { className: 'mcp-banner ok' }, notice) : null,
          h(ServerStatus, {
            server: viewedServer,
            busy: busy,
            confirmingDelete: confirmingDelete,
            onEdit: () => openForm(viewedServer),
            onReconnect: onReconnect,
            onDelete: onDelete,
          }),
        );
      };

      /* ------------------------------ form view ------------------------- */

      const formView = () => {
        // Defensive: the form is only ever entered through openForm(), which
        // always seeds a draft first.
        if (draft === null) return null;
        const isNew = view.id === null;
        // `MCP 服务器 › 新建` or `MCP 服务器 › blender › 编辑配置`.
        const crumbs = [
          h('button', { key: 'root', className: 'mcp-crumb-link', onClick: openList }, 'MCP 服务器'),
        ];
        if (!isNew) {
          crumbs.push(h('span', { key: 'sep-1', className: 'mcp-crumb-sep' }, '›'));
          crumbs.push(
            h(
              'button',
              {
                key: 'server',
                className: 'mcp-crumb-link',
                onClick: () => openDetail({ id: view.id }),
              },
              view.id,
            ),
          );
        }
        crumbs.push(h('span', { key: 'sep-2', className: 'mcp-crumb-sep' }, '›'));
        crumbs.push(h('span', { key: 'leaf' }, isNew ? '新建' : '编辑配置'));

        return h(
          'div',
          null,
          h('div', { className: 'mcp-crumb' }, crumbs),
          h('h2', { className: 'mcp-h2' }, isNew ? '新建 MCP 服务器' : '编辑配置'),
          h(
            'div',
            { className: 'mcp-tabs' },
            h(
              'button',
              {
                className: 'mcp-tab' + (tab === 'form' ? ' is-active' : ''),
                onClick: () => setTab('form'),
                type: 'button',
              },
              '表单',
            ),
            h(
              'button',
              {
                className: 'mcp-tab' + (tab === 'json' ? ' is-active' : ''),
                onClick: () => setTab('json'),
                type: 'button',
              },
              'JSON',
            ),
          ),
          formError !== null ? h('div', { className: 'mcp-banner error' }, formError) : null,
          h(
            'div',
            { className: 'mcp-card' },
            tab === 'form'
              ? h(ServerForm, {
                  draft: draft,
                  showEnv: showEnv,
                  showAdvanced: showAdvanced,
                  negotiatedProtocolVersion:
                    viewedServer === undefined ? undefined : viewedServer.negotiatedProtocolVersion,
                  onChange: setDraft,
                  onToggleEnv: () => setShowEnv((value) => !value),
                  onToggleAdvanced: () => setShowAdvanced((value) => !value),
                })
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'mcp-field' },
                    h('label', { className: 'mcp-label' }, '完整配置'),
                    h('textarea', {
                      className: 'mcp-textarea',
                      style: { minHeight: '260px' },
                      value: jsonText,
                      spellCheck: false,
                      onChange: (event) => setJsonText(event.target.value),
                      placeholder: JSON_TEMPLATE,
                    }),
                  ),
                  h(
                    'div',
                    { className: 'mcp-hint' },
                    '支持直接粘贴 {"server-name": {…}} 或 {"mcpServers": {"server-name": {…}}}。',
                  ),
                ),
            h(
              'div',
              { className: 'mcp-actions' },
              h(
                'button',
                {
                  className: 'mcp-btn mcp-btn-primary',
                  disabled: busy,
                  onClick: () => (tab === 'form' ? submitForm() : submitJson()),
                },
                busy ? '保存中…' : '保存',
              ),
              h('button', { className: 'mcp-btn', onClick: closeForm, disabled: busy }, '取消'),
            ),
          ),
        );
      };

      return h(
        'div',
        { className: 'mcp-scope' },
        h(
          'div',
          { className: 'mcp-shell' },
          view.kind === 'list' ? listView() : view.kind === 'detail' ? detailView() : formView(),
        ),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                        */
    /* ------------------------------------------------------------------ */

    const name = NS;
    const inject = ['slots'];

    function apply(ctx) {
      ensureStyles();

      const backToConversation = () => {
        try {
          const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
          if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(null);
        } catch (error) {
          console.warn('[' + NS + '] back to conversation failed:', error);
        }
      };

      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 2, label: () => 'MCP' },
            PanelGlyph,
          ),
        );
      } catch (error) {
        console.warn('[' + NS + '] sidebar.panellist registration failed:', error);
      }

      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, inject: () => ({ backToConversation }) },
            (props) => h(McpPanel, Object.assign({ backToConversation }, props)),
          ),
        );
      } catch (error) {
        console.warn('[' + NS + '] main panel registration failed:', error);
      }

      console.log('[' + NS + '] panel ready (sidebar entry + main key "' + PANEL_ID + '")');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // node --test entry point: pure helpers only, no runtime behaviour change.
    exports.__test = {
      statusMeta,
      splitArgs,
      joinArgs,
      formatEnvText,
      parseEnvText,
      configCommandLine,
      matchesQuery,
      toolSummary,
      configOf,
      serverToPayload,
      withClearedOverrides,
      serverToDraft,
      draftToServer,
      validateDraft,
      formatJsonConfig,
      parseJsonConfig,
    };
    return module.exports;
  },
});
