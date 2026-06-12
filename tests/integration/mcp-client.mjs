// Minimal raw JSON-RPC client for the ProofKit MCP stdio server.
// No SDK dependency by design (test instructions): newline-delimited
// JSON-RPC 2.0 over the child's stdin/stdout, per the MCP stdio transport.
import { spawn } from 'node:child_process';
import { CLI, baseEnv } from './helpers.mjs';

export class McpClient {
  /**
   * Defaults to the repo build (`node dist/cli/index.js mcp start`); pass
   * `command`/`args` to drive a different artifact, e.g. the npm-installed
   * bin in the tarball smoke (scripts/tarball-smoke.mjs).
   * @param {{cwd?: string, env?: object, command?: string, args?: string[]}} opts
   */
  constructor({
    cwd,
    env = {},
    command = process.execPath,
    args = [CLI, 'mcp', 'start'],
  } = {}) {
    this.child = spawn(command, args, {
      cwd,
      env: { ...baseEnv, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buffer = '';
    this.stderr = '';
    this.rawStdout = ''; // verbatim stdout, for NDJSON-purity assertions
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    this.child.stderr.on('data', (d) => {
      this.stderr += d.toString();
    });
    this.child.stdout.on('data', (d) => this.#onData(d.toString()));
    this.child.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.rawStdout += chunk;
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // tolerate non-JSON noise on stdout (logged, not fatal)
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(
            `JSON-RPC error ${msg.error.code}: ${msg.error.message}`,
          );
          err.rpcError = msg.error;
          reject(err);
        } else {
          resolve(msg.result);
        }
      }
      // server-initiated requests/notifications are ignored by this client
    }
  }

  #send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request ${method} (id=${id}) timed out after ${timeoutMs}ms.` +
              ` stderr so far:\n${this.stderr}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  /** MCP initialize handshake. Returns the server's initialize result. */
  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'proofkit-integration-tests', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  /**
   * Extract the JSON payload of a tools/call result, handling both
   * `structuredContent` and `content[0].text`-encoded JSON.
   */
  static toolPayload(result) {
    if (result && typeof result === 'object') {
      if (result.structuredContent) return result.structuredContent;
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      try {
        return JSON.parse(text);
      } catch {
        return { _rawText: text, _isError: result.isError ?? false };
      }
    }
    return result;
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const finished = await Promise.race([
      this.exited,
      new Promise((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (finished === null) this.child.kill('SIGKILL');
  }
}
