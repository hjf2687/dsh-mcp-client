/**
 * Manual diagnostic (NOT part of `npm test`).
 *
 * Captures the raw bytes an MCP server writes to stderr and runs them through
 * the plugin's decoder, to answer "why is the stderr output mojibake?" with
 * evidence instead of a guess. On Windows the usual answer is a Python server
 * writing the ANSI codepage (GBK/CP936), which shows up as two U+FFFD
 * replacement characters per non-ASCII character.
 *
 * Usage:
 *   node test/fixtures/check-stderr-bytes.mjs
 *   node test/fixtures/check-stderr-bytes.mjs uvx blender-mcp
 *   node test/fixtures/check-stderr-bytes.mjs npx -y @modelcontextprotocol/server-memory
 */
import { spawn } from 'node:child_process';
import { decodeStderrLine } from '../../lib/mcp-client.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'uvx';
const args = argv.length > 0 ? argv.slice(1) : ['blender-mcp'];

const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });

const chunks = [];
child.stderr.on('data', (chunk) => chunks.push(chunk));

setTimeout(() => {
  child.kill();
  const raw = Buffer.concat(chunks);
  console.log(`captured ${raw.length} stderr bytes from: ${[command, ...args].join(' ')}`);

  let start = 0;
  let firstNonAscii = null;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i !== raw.length && raw[i] !== 0x0a) continue;
    const line = raw.subarray(start, i);
    start = i + 1;
    if (line.length === 0 || firstNonAscii !== null) continue;
    // Skip lines that are pure ASCII: only an encoding problem is interesting.
    if (!line.some((byte) => byte > 0x7f)) continue;
    firstNonAscii = line;
  }

  if (firstNonAscii === null) {
    console.log('no non-ASCII stderr line captured — nothing to diagnose');
    process.exit(0);
  }

  const decoded = decodeStderrLine(firstNonAscii);
  console.log('first non-ASCII line, raw hex :', firstNonAscii.subarray(0, 64).toString('hex').replace(/(..)/g, '$1 '));
  console.log('decoded                      :', JSON.stringify(decoded.slice(0, 200)));
  console.log('contains U+FFFD (mojibake)   :', decoded.includes('\uFFFD'));
  process.exit(0);
}, 7000);

