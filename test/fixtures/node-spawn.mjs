/**
 * Adapt `node:child_process.spawn` to the `SubprocessHandle` shape that
 * dsh-mcp-client consumes, so tests can drive the real client without a DSH
 * runtime. Mirrors the production contract: streams, `done`, `terminate`.
 */

import { spawn } from 'node:child_process';

/**
 * @param spec `{ argv, cwd, stdio, graceMs, env }` — the DSH spawn spec
 * @returns a handle with `{ stdin, stdout, stderr, done, terminate }`
 */
export function nodeSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const done = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
    child.once('error', () => resolve({ exitCode: null, signal: null }));
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    // Test-only extras: let a test prove the child is really gone.
    child,
    pid: child.pid,
    terminate() {
      child.kill();
    },
    /** Mirrors `SubprocessHandle.waitForExit`: resolves once the child is gone. */
    waitForExit() {
      return done.then(() => true);
    },
  };
}
