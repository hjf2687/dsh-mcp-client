/**
 * Guard rails for the plugin's cache-busting reload.
 *
 * `plugin.js` re-imports `host.js?v=<stamp>` when any file in its closure
 * changes. A relative `import './mcp-client.js'` inside host.js does NOT
 * inherit that query string, so the sibling would resolve to its bare URL and
 * Node would serve the cached module — edited sibling code would silently keep
 * running old until a full DSH restart.
 *
 * An end-to-end version of this check (copy lib/, apply, edit a sibling, apply
 * again) was written first but proved non-deterministic under the test runner
 * while a second child process was involved, so it was replaced by these
 * deterministic source-level assertions. They catch the exact regression that
 * motivated the fix: someone turning the dynamic imports back into static ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name) => fs.readFileSync(fileURLToPath(new URL(`../lib/${name}`, import.meta.url)), 'utf8');

/** Every module `plugin.js` stamps; host.js must not import these statically. */
const SIBLINGS = ['mcp-client.js', 'panel.js', 'schema.js'];

test('host.js loads its siblings through the cache-busting stamp', () => {
  const source = read('host.js');

  for (const sibling of SIBLINGS) {
    const staticImport = new RegExp(`^\\s*import\\s[^;]*from\\s['"]\\./${sibling.replace('.', '\\.')}['"]`, 'm');
    assert.ok(
      !staticImport.test(source),
      `host.js must not statically import ./${sibling}: a relative specifier drops the ?v= stamp`,
    );
    assert.ok(
      source.includes(`await import(bust('./${sibling}'))`),
      `host.js should dynamically import ./${sibling} through bust()`,
    );
  }

  // The stamp has to come from this module's own URL, which plugin.js sets.
  assert.match(source, /import\.meta\.url\)\.searchParams\.get\('v'\)/);
});

test('plugin.js stamps every module in its closure', () => {
  const source = read('plugin.js');
  const match = source.match(/const CLOSURE = \[([^\]]+)\]/);
  assert.ok(match !== null, 'plugin.js should declare a CLOSURE list');
  for (const name of ['host.js', ...SIBLINGS]) {
    assert.ok(match[1].includes(`'${name}'`), `CLOSURE should include ${name}`);
  }
  assert.match(source, /searchParams\.set\('v',\s*encodeURIComponent\(stamp\)\)/);
});
