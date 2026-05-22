/**
 * P0 / T4 — End-to-end MCP initialize handshake carries the watch
 * health diagnostic.
 *
 * The unit suite (`p0-watch-health-instructions.test.ts`) covers the
 * pure `buildServerInstructions` builder. This integration suite spawns
 * the real `codegraph serve --mcp` child process, sends a real
 * `initialize` JSON-RPC request, and asserts that the `instructions`
 * field in the response reflects the actual watch policy:
 *
 *   • Healthy default project → instructions match the static playbook
 *   • CODEGRAPH_NO_WATCH=1     → instructions carry the "## ⚠️ Index
 *                                  Sync Status" warning section
 *
 * Closes the dev-baseline red-line #12 ("tests pass ≠ application
 * works") gap that the unit suite alone could not cover — proves the
 * builder is actually wired into the transport layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(
  cwd: string,
  envOverrides: NodeJS.ProcessEnv = {}
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, 'serve', '--mcp'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...envOverrides },
  }) as ChildProcessWithoutNullStreams;
}

function sendInitialize(
  child: ChildProcessWithoutNullStreams,
  projectPath: string
): void {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'p0-t4-test', version: '0.0.0' },
      rootUri: `file://${projectPath}`,
    },
  });
  child.stdin.write(msg + '\n');
}

function readFirstStdoutLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        child.stdout.off('data', onData);
        resolve(buf.slice(0, idx));
      }
    };
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`Timed out waiting for stdout. Buffered: ${buf}`));
    }, timeoutMs);
    child.stdout.on('data', onData);
    void timer;
  });
}

describe('P0/T4 integration — initialize response carries watch health diagnostic', () => {
  let tempDir: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p0-t4-int-'));
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill('SIGKILL');
      child = null;
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('healthy project: instructions field matches the static playbook (no warning section)', async () => {
    const cg = await CodeGraph.init(tempDir);
    cg.close();

    child = spawnServer(tempDir);
    sendInitialize(child, tempDir);

    const line = await readFirstStdoutLine(child, 10000);
    const json = JSON.parse(line);
    const instructions: string = json.result.instructions;

    expect(typeof instructions).toBe('string');
    expect(instructions.length).toBeGreaterThan(0);
    // Static playbook anchors must be present.
    expect(instructions).toContain('codegraph_search');
    expect(instructions).toContain('codegraph_context');
    // No watch warning when the project is healthy.
    // Note: we only assert absence of the section header here. The
    // string "codegraph sync" alone now appears inside Mandatory Rules
    // (T5: "Ask the user to run `codegraph sync` first"), so a bare
    // substring match would over-trigger. The header is unique to the
    // dynamic warning path and is the right anchor.
    expect(instructions).not.toContain('## ⚠️ Index Sync Status');
  }, 20000);

  it('CODEGRAPH_NO_WATCH=1: instructions carry the ⚠️ Index Sync Status section with the disabled reason', async () => {
    const cg = await CodeGraph.init(tempDir);
    cg.close();

    child = spawnServer(tempDir, { CODEGRAPH_NO_WATCH: '1' });
    sendInitialize(child, tempDir);

    const line = await readFirstStdoutLine(child, 10000);
    const json = JSON.parse(line);
    const instructions: string = json.result.instructions;

    expect(typeof instructions).toBe('string');
    // Static playbook still on top.
    expect(instructions).toContain('codegraph_search');
    // Dynamic warning section appended.
    expect(instructions).toContain('## ⚠️ Index Sync Status');
    // Exact disabled reason quoted so the agent can act on it.
    expect(instructions).toContain('CODEGRAPH_NO_WATCH=1');
    // Action items present.
    expect(instructions).toContain('codegraph sync');
    expect(instructions).toContain('codegraph_status');
    // The warning must come AFTER the static playbook (cache-friendly
    // prefix property — see buildServerInstructions docstring).
    const warningIdx = instructions.indexOf('## ⚠️ Index Sync Status');
    const playbookIdx = instructions.indexOf('codegraph_search');
    expect(playbookIdx).toBeLessThan(warningIdx);
  }, 20000);
});
