/**
 * Loads the real client bundle with a stubbed module loader.
 *
 * `lib/client.js` is a plain module-loader bundle, not an ES module with
 * exports: at load time it registers itself on `window.__ModuleLoader__`. The
 * stub below captures that registration, then invokes the factory with a fake
 * `require` so the pure helpers can be tested without a browser or React.
 *
 * The fake `require` throws for anything but `react`, which also enforces the
 * client bundle's purity gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeServersForWrite } from '../lib/host.js';

let captured = null;

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

const fakeReact = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

await import('../lib/client.js');

assert.ok(captured !== null, 'lib/client.js did not call window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-mcp-client');

const exported = captured.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require("${name}") — the client bundle must stay pure`);
});
const t = exported.__test;

test('the client bundle exports a name, inject and apply', () => {
  assert.equal(exported.name, 'dsh-mcp-client');
  assert.deepEqual(exported.inject, ['slots']);
  assert.equal(typeof exported.apply, 'function');
});

test('statusMeta maps every lifecycle status to display text', () => {
  assert.equal(t.statusMeta('connected').text, '已连接');
  assert.equal(t.statusMeta('connecting').text, '连接中');
  assert.equal(t.statusMeta('error').text, '错误');
  assert.equal(t.statusMeta('disabled').text, '已禁用');
  // Unknown or missing statuses fall back instead of rendering "undefined".
  assert.equal(t.statusMeta(undefined).key, 'idle');
  assert.equal(t.statusMeta('nonsense').key, 'idle');
});

test('splitArgs honours whitespace and quotes', () => {
  assert.deepEqual(t.splitArgs('-y @modelcontextprotocol/server-memory'), [
    '-y',
    '@modelcontextprotocol/server-memory',
  ]);
  assert.deepEqual(t.splitArgs('   '), []);
  assert.deepEqual(t.splitArgs(''), []);
  assert.deepEqual(t.splitArgs(undefined), []);
  // A quoted path keeps its space.
  assert.deepEqual(t.splitArgs('"C:\\Program Files\\x.exe" --flag'), ['C:\\Program Files\\x.exe', '--flag']);
  assert.deepEqual(t.splitArgs("'single quoted'"), ['single quoted']);
  // An empty quoted argument is meaningful and must survive.
  assert.deepEqual(t.splitArgs('""'), ['']);
});

test('joinArgs quotes only what needs it, and round-trips', () => {
  assert.equal(t.joinArgs(['-y', 'pkg']), '-y pkg');
  assert.equal(t.joinArgs(['a b']), '"a b"');
  assert.equal(t.joinArgs(['']), '""');
  const args = ['-y', 'C:\\Program Files\\x.exe', 'plain'];
  assert.deepEqual(t.splitArgs(t.joinArgs(args)), args);
});

test('env round-trips through KEY=VALUE lines', () => {
  assert.equal(t.formatEnvText({ A: '1', B: 'x' }), 'A=1\nB=x');
  assert.equal(t.formatEnvText(null), '');
  assert.deepEqual(t.parseEnvText('A=1\nB=two=three'), { A: '1', B: 'two=three' });
  // Blank lines, comments and lines without '=' are ignored.
  assert.deepEqual(t.parseEnvText('\n# note\nNOPE\n=bad\nB=2\n'), { B: '2' });
});

test('configCommandLine renders the list subtitle', () => {
  assert.equal(t.configCommandLine({ command: 'uvx', args: ['blender-mcp'] }), 'stdio · uvx blender-mcp');
  assert.equal(t.configCommandLine({ command: 'npx', args: [] }), 'stdio · npx');
  assert.equal(t.configCommandLine({}), 'stdio · ');
});

test('matchesQuery searches id, command and args case-insensitively', () => {
  const server = { id: 'blender', command: 'D:\\tools\\uvx.exe', args: ['blender-mcp'] };
  assert.equal(t.matchesQuery(server, ''), true);
  assert.equal(t.matchesQuery(server, '   '), true);
  assert.equal(t.matchesQuery(server, 'BLEND'), true);
  assert.equal(t.matchesQuery(server, 'mcp'), true);
  assert.equal(t.matchesQuery(server, 'comfy'), false);
});

test('toolSummary clamps a description to one dense line', () => {
  assert.equal(t.toolSummary('One line.'), 'One line.');
  // Only the first non-empty line survives, with its inner whitespace squeezed.
  assert.equal(t.toolSummary('\n\n  First   real line  \nsecond\n'), 'First real line');
  assert.equal(t.toolSummary(undefined), '');
  assert.equal(t.toolSummary(null), '');
  assert.equal(t.toolSummary('x', 5), 'x');
  assert.equal(t.toolSummary('abcdefghij', 5), 'abcd…');
  const long = t.toolSummary('a'.repeat(200));
  assert.equal(long.length, 90);
  assert.ok(long.endsWith('…'));
});

test('serverToDraft / draftToServer round-trip a full server', () => {
  const server = {
    id: 'blender',
    command: 'D:\\tools\\miniconda3\\Scripts\\uvx.exe',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost', BLENDER_PORT: '9876' },
    cwd: 'D:\\work',
    callTimeoutMs: 45000,
    protocolVersion: '2025-03-26',
    enabled: false,
  };
  const draft = t.serverToDraft(server);
  assert.equal(draft.id, 'blender');
  assert.equal(draft.transport, 'stdio');
  assert.equal(draft.argsText, 'blender-mcp');
  assert.equal(draft.envText, 'BLENDER_HOST=localhost\nBLENDER_PORT=9876');
  assert.equal(draft.timeoutMs, '45000');
  assert.equal(draft.protocolVersion, '2025-03-26');
  assert.equal(draft.enabled, false);

  assert.deepEqual(t.draftToServer(draft), server);
});

test('draftToServer omits empty optionals and defaults enabled to true', () => {
  const server = t.draftToServer({
    id: 'x',
    command: 'node',
    argsText: '',
    envText: '',
    cwd: '   ',
    timeoutMs: '',
    protocolVersion: '',
  });
  assert.deepEqual(server, { id: 'x', command: 'node', args: [], env: {}, enabled: true });
  assert.equal('cwd' in server, false);
  assert.equal('callTimeoutMs' in server, false);
  assert.equal('protocolVersion' in server, false);
});

test('validateDraft reports the first blocking problem', () => {
  const existing = [{ id: 'blender', command: 'uvx' }];
  assert.match(t.validateDraft({ id: '', command: 'x' }, existing, null), /名称不能为空/);
  assert.match(t.validateDraft({ id: 'a b', command: 'x' }, existing, null), /只能包含/);
  assert.match(t.validateDraft({ id: 'ok', command: '' }, existing, null), /命令不能为空/);
  assert.match(t.validateDraft({ id: 'ok', command: 'x', timeoutMs: '0' }, existing, null), /超时时间/);
  assert.match(t.validateDraft({ id: 'ok', command: 'x', timeoutMs: 'abc' }, existing, null), /超时时间/);
  assert.match(t.validateDraft({ id: 'blender', command: 'uvx' }, existing, null), /已存在同名/);
  // Editing the same server must not clash with itself.
  assert.equal(t.validateDraft({ id: 'blender', command: 'uvx' }, existing, 'blender'), null);
  assert.equal(t.validateDraft({ id: 'fresh', command: 'uvx' }, existing, null), null);
});

test('formatJsonConfig emits a portable stdio table', () => {
  const text = t.formatJsonConfig([
    { id: 'blender', command: 'uvx', args: ['blender-mcp'], env: { PORT: '9876' }, callTimeoutMs: 30000, enabled: false },
    { id: 'plain', command: 'node', args: [] },
  ]);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.blender, {
    type: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { PORT: '9876' },
    timeout: 30000,
    enabled: false,
  });
  // Absent optionals are omitted rather than emitted as null/empty.
  assert.deepEqual(parsed.plain, { type: 'stdio', command: 'node', args: [] });
});

test('parseJsonConfig accepts a bare table and an mcpServers wrapper', () => {
  const direct = t.parseJsonConfig('{"blender":{"type":"stdio","command":"uvx","args":["blender-mcp"]}}');
  assert.deepEqual(direct, [{ id: 'blender', command: 'uvx', args: ['blender-mcp'], env: {} }]);

  const wrapped = t.parseJsonConfig('{"mcpServers":{"a":{"command":"node"}}}');
  assert.deepEqual(wrapped, [{ id: 'a', command: 'node', args: [], env: {} }]);

  // `timeout` and `callTimeoutMs` both map to the per-server timeout.
  const withTimeout = t.parseJsonConfig('{"a":{"command":"node","timeout":45000,"protocolVersion":"2024-11-05","enabled":false}}');
  assert.equal(withTimeout[0].callTimeoutMs, 45000);
  assert.equal(withTimeout[0].protocolVersion, '2024-11-05');
  assert.equal(withTimeout[0].enabled, false);
});

test('parseJsonConfig rejects malformed and unsupported input', () => {
  assert.throws(() => t.parseJsonConfig('{oops'), /JSON 解析失败/);
  assert.throws(() => t.parseJsonConfig('[1,2]'), /顶层必须是一个对象/);
  assert.throws(() => t.parseJsonConfig('{"a":"nope"}'), /必须是一个对象/);
  assert.throws(() => t.parseJsonConfig('{"a":{"type":"http","url":"x"}}'), /只支持 stdio/);
});

test('a formatted config round-trips through the parser', () => {
  const servers = [
    { id: 'blender', command: 'uvx', args: ['blender-mcp'], env: { HOST: 'localhost' }, callTimeoutMs: 45000 },
  ];
  assert.deepEqual(t.parseJsonConfig(t.formatJsonConfig(servers)), servers);
});

/* -------------------------------------------------------------------------- */
/* Configuration vs. runtime state                                            */
/*                                                                            */
/* A host record carries both. Writing the runtime half back as configuration */
/* silently replaces per-server overrides and pins the protocol version to    */
/* whatever happened to be negotiated.                                        */
/* -------------------------------------------------------------------------- */

/** A panel record shaped exactly like the host's `/status.json` entry. */
function panelRecord() {
  return {
    id: 'blender',
    enabled: true,
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost' },
    cwd: null,
    toolCount: 3,
    status: 'connected',
    error: null,
    serverInfo: { name: 'blender', version: '1.0.0' },
    // The negotiated value, which is NOT configuration.
    protocolVersion: '2025-06-18',
    negotiatedProtocolVersion: '2025-06-18',
    connectedAt: '2026-01-01T00:00:00.000Z',
    tools: [],
    stderr: [],
    config: {
      command: 'uvx',
      args: ['blender-mcp'],
      env: { BLENDER_HOST: 'localhost' },
      enabled: true,
      callTimeoutMs: 45000,
      startupTimeoutMs: 2000,
      graceMs: 500,
      // protocolVersion is deliberately absent: this server auto-negotiates.
    },
  };
}

test('a write payload is built from config, never from runtime state', () => {
  const record = panelRecord();

  // The list switch: exactly the configured values plus identity and the new flag.
  const toggled = t.serverToPayload(record, { enabled: false });
  assert.deepEqual(toggled, {
    id: 'blender',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost' },
    enabled: false,
    callTimeoutMs: 45000,
    startupTimeoutMs: 2000,
    graceMs: 500,
  });
  // An auto-negotiated server must not be pinned to the negotiated version.
  assert.equal('protocolVersion' in toggled, false);
  assert.equal('status' in toggled, false);
  assert.equal('tools' in toggled, false);
  assert.equal('negotiatedProtocolVersion' in toggled, false);

  // A record with nothing enabled overrides still keeps its own enabled flag.
  assert.equal(t.serverToPayload(record).enabled, true);
  const disabled = t.serverToPayload({ ...record, config: { ...record.config, enabled: false } });
  assert.equal(disabled.enabled, false);

  // A host that predates `config` still yields a usable payload.
  const legacy = { id: 'x', command: 'node', args: ['a'], env: {}, enabled: false, protocolVersion: '2024-11-05' };
  assert.deepEqual(t.serverToPayload(legacy), {
    id: 'x',
    command: 'node',
    args: ['a'],
    env: {},
    enabled: false,
    protocolVersion: '2024-11-05',
  });
});

test('the form reads configuration, not the negotiated protocol version', () => {
  const draft = t.serverToDraft(panelRecord());
  assert.equal(draft.command, 'uvx');
  assert.equal(draft.argsText, 'blender-mcp');
  assert.equal(draft.envText, 'BLENDER_HOST=localhost');
  assert.equal(draft.timeoutMs, '45000');
  assert.equal(draft.enabled, true);
  // Auto-negotiation stays auto, so saving the form cannot pin it either.
  assert.equal(draft.protocolVersion, '');
  assert.deepEqual(t.draftToServer(draft), {
    id: 'blender',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost' },
    enabled: true,
    callTimeoutMs: 45000,
  });

  // A configured version still round-trips.
  const pinned = panelRecord();
  pinned.config = { ...pinned.config, protocolVersion: '2025-03-26' };
  assert.equal(t.serverToDraft(pinned).protocolVersion, '2025-03-26');

  // The JSON tab shows the configuration, not the negotiated version.
  const json = JSON.parse(t.formatJsonConfig([panelRecord()]));
  assert.deepEqual(json.blender, {
    type: 'stdio',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost' },
    timeout: 45000,
  });
});

test('an emptied form field clears the override instead of inheriting it', () => {
  const draft = t.serverToDraft(panelRecord());
  assert.equal(draft.timeoutMs, '45000');
  assert.equal(draft.protocolVersion, '');

  // The host keeps an override a payload omits, so the editors must be able to
  // say "none" for the two fields they show. Keys they never show stay absent
  // (and therefore keep their configured value).
  const cleared = t.withClearedOverrides(t.draftToServer({ ...draft, timeoutMs: '' }));
  assert.deepEqual(cleared, {
    id: 'blender',
    command: 'uvx',
    args: ['blender-mcp'],
    env: { BLENDER_HOST: 'localhost' },
    enabled: true,
    callTimeoutMs: null,
    protocolVersion: null,
  });
  assert.deepEqual(sanitizeServersForWrite([cleared], [
    { id: 'blender', command: 'uvx', args: ['blender-mcp'], env: { BLENDER_HOST: 'localhost' }, callTimeoutMs: 45000, protocolVersion: '2025-03-26', graceMs: 500 },
  ]), [
    {
      id: 'blender',
      command: 'uvx',
      args: ['blender-mcp'],
      env: { BLENDER_HOST: 'localhost' },
      graceMs: 500,
    },
  ]);

  // A value the user typed is still written through.
  const pinned = t.withClearedOverrides(
    t.draftToServer({ ...draft, timeoutMs: '30000', protocolVersion: '2024-11-05' }),
  );
  assert.equal(pinned.callTimeoutMs, 30000);
  assert.equal(pinned.protocolVersion, '2024-11-05');
});

test('a panel switch cannot erase overrides the host still has configured', () => {
  // End-to-end across the seam: the client builds the payload, the host merges
  // it over the configuration in force.
  const current = [
    {
      id: 'blender',
      command: 'uvx',
      args: ['blender-mcp'],
      env: { BLENDER_HOST: 'localhost' },
      callTimeoutMs: 45000,
      startupTimeoutMs: 2000,
      graceMs: 500,
      protocolVersion: '2025-03-26',
    },
  ];
  const payload = [t.serverToPayload(panelRecord(), { enabled: false })];
  assert.deepEqual(sanitizeServersForWrite(payload, current), [
    {
      id: 'blender',
      command: 'uvx',
      args: ['blender-mcp'],
      env: { BLENDER_HOST: 'localhost' },
      enabled: false,
      callTimeoutMs: 45000,
      startupTimeoutMs: 2000,
      graceMs: 500,
      protocolVersion: '2025-03-26',
    },
  ]);
});
