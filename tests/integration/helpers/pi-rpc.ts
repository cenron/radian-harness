// Minimal JSONL client for an isolated, offline `pi --mode rpc` child process.
// Used only by native offline probes: an isolated HOME and agent directory,
// PI_OFFLINE, and a test-only extension that registers pi-ai's public faux
// provider. No credential store, provider endpoint, or existing pane is used.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface RpcRecord {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export type UiResponder = (request: RpcRecord) => Record<string, unknown> | undefined;

export interface PiRpcOptions {
  pi: string;
  cwd: string;
  /** Disposable root holding the isolated HOME and agent directory. */
  sandbox: string;
  args?: string[];
  env?: Record<string, string>;
  /** Answers extension dialogs; default cancels every dialog. */
  ui?: UiResponder;
}

export class PiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly records: RpcRecord[] = [];
  readonly notes: string[] = [];
  readonly stderr: string[] = [];
  private buffer = "";
  private waiters: Array<{ match: (r: RpcRecord) => boolean; resolve: (r: RpcRecord) => void }> = [];
  private nextId = 0;
  ui: UiResponder;

  constructor(options: PiRpcOptions) {
    const home = path.join(options.sandbox, "home");
    const agent = path.join(options.sandbox, "agent");
    mkdirSync(home, { recursive: true });
    mkdirSync(agent, { recursive: true });
    this.ui = options.ui ?? (() => ({ cancelled: true }));
    this.child = spawn(options.pi, ["--mode", "rpc", ...(options.args ?? [])], {
      cwd: options.cwd,
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TERM: "dumb", ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => this.stderr.push(d));
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(line) as RpcRecord;
        } catch {
          continue;
        }
        this.records.push(record);
        if (record.type === "extension_ui_request") this.answer(record);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(record)) {
            this.waiters = this.waiters.filter((w) => w !== waiter);
            waiter.resolve(record);
          }
        }
      }
    });
  }

  private answer(request: RpcRecord): void {
    if (request.method === "notify") {
      this.notes.push(String(request.message ?? ""));
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(String(request.method))) return;
    const reply = this.ui(request) ?? { cancelled: true };
    this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: request.id, ...reply }) + "\n");
  }

  wait(match: (r: RpcRecord) => boolean, timeoutMs = 30_000): Promise<RpcRecord> {
    const found = this.records.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for RPC record; stderr: ${this.stderr.join("").slice(-1500)}`)), timeoutMs);
      this.waiters.push({ match, resolve: (r) => { clearTimeout(timer); resolve(r); } });
    });
  }

  async command(type: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<RpcRecord> {
    const id = `probe-${++this.nextId}`;
    const response = this.wait((r) => r.type === "response" && r.id === id, timeoutMs);
    this.child.stdin.write(JSON.stringify({ id, type, ...payload }) + "\n");
    return response;
  }

  /** Send a prompt and wait until Pi settles (or the prompt was handled by a command). */
  async prompt(message: string, timeoutMs = 30_000): Promise<RpcRecord> {
    const settledBefore = this.records.filter((r) => r.type === "agent_settled").length;
    const response = await this.command("prompt", { message }, timeoutMs);
    if (response.success === true && (response.data as { disposition?: string } | undefined)?.disposition === "started") {
      await this.wait(() => this.records.filter((r) => r.type === "agent_settled").length > settledBefore, timeoutMs);
    }
    return response;
  }

  async close(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    const exited = new Promise<number | null>((resolve) => this.child.once("exit", (code) => resolve(code)));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 15_000);
    const code = await exited;
    clearTimeout(timer);
    return code;
  }
}
