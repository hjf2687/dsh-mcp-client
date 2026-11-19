/**
 * dsh-mcp-client — loader bootstrap.
 *
 * The Harness loader keeps the plugin entry module in the ESM registry
 * permanently, so a plain `import` would keep serving stale host code after an
 * edit. This entry therefore does only two things:
 *
 *   1. `name` / `inject` stay pure constants the loader can read without
 *      executing anything else.
 *   2. `apply()` re-imports the host closure with an `mtime:size` cache-busting
 *      query, so editing host code takes effect on the next load instead of
 *      requiring a restart. Unchanged content yields the same URL and therefore
 *      the same cached module.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-mcp-client';

// Only the two services this plugin cannot function without. `webServer` and
// friends are deliberately absent so the plugin stays usable in a headless
// profile.
export const inject = ['tools', 'subprocess'];

const HOST_URL = new URL('./host.js', import.meta.url);

/** Modules that participate in cache-busting. */
const CLOSURE = ['host.js', 'mcp-client.js', 'schema.js', 'panel.js'];

let lastStamp = '';

/** `mtime:size` for every module in the closure; missing files count as 0. */
function closureStamp() {
  const parts = [];
  for (const relative of CLOSURE) {
    try {
      const stat = fs.statSync(fileURLToPath(new URL(`./${relative}`, import.meta.url)));
      parts.push(`${relative}:${Math.round(stat.mtimeMs)}:${stat.size}`);
    } catch {
      parts.push(`${relative}:missing`);
    }
  }
  return parts.join('|');
}

export async function apply(ctx, config) {
  const stamp = closureStamp();
  const target = new URL(HOST_URL.href);
  target.searchParams.set('v', encodeURIComponent(stamp));
  if (stamp !== lastStamp) {
    lastStamp = stamp;
    console.log('[mcp-client] host closure changed — reloading it from disk');
  }
  const host = await import(target.href);
  if (typeof host.activate !== 'function') {
    throw new Error('dsh-mcp-client: lib/host.js did not export activate()');
  }
  return host.activate(ctx, config);
}
