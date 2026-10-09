// A minimal JSONL client for an offline `pi --mode rpc` child: isolated HOME and agent
// directory, no credentials, and a faux model, so no provider is ever contacted.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface RpcRecord {
  type: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Answers a dialog request; return undefined to cancel it, or null to leave it unanswered so a
 * dialog with a timeout resolves on its own, as when the user is away.
 */
export type DialogAnswer = (request: RpcRecord) => Record<string, unknown> | undefined | null;

export interface PiProcess {
  records: RpcRecord[];
  notes: () => string[];
  answerDialogs: (answer: DialogAnswer) => void;
  wait: (match: (record: RpcRecord) => boolean, timeoutMs?: number) => Promise<RpcRecord>;
  command: (type: string, payload?: Record<string, unknown>) => Promise<RpcRecord>;
  prompt: (message: string) => Promise<void>;
  close: () => Promise<void>;
}

const PI_BIN = path.resolve(import.meta.dirname, "../../../node_modules/.bin/pi");
const FAUX_PROVIDER = "radian-test";
const TIMEOUT_MS = 30_000;

export function startPi(options: {
  cwd: string;
  sandbox: string;
  env?: Record<string, string>;
}): PiProcess {
  const home = path.join(options.sandbox, "home");
  const agentDir = path.join(options.sandbox, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const faux = path.resolve(import.meta.dirname, "../fixtures/faux-model.ts");
  const child = spawn(PI_BIN, ["--mode", "rpc", "--approve", "-e", faux], {
    cwd: options.cwd,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      TERM: "dumb",
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records: RpcRecord[] = [];
  const stderr: string[] = [];
  let waiters: Array<{
    match: (record: RpcRecord) => boolean;
    resolve: (record: RpcRecord) => void;
  }> = [];
  let answer: DialogAnswer = () => undefined;
  let buffer = "";
  let nextId = 0;

  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const receive = (record: RpcRecord) => {
    records.push(record);
    if (
      record.type === "extension_ui_request" &&
      ["select", "confirm", "input", "editor"].includes(String(record.method))
    ) {
      const reply = answer(record);
      if (reply !== null) {
        send({ type: "extension_ui_response", id: record.id, ...(reply ?? { cancelled: true }) });
      }
    }
    for (const waiter of waiters.filter((candidate) => candidate.match(record))) {
      waiters = waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(record);
    }
  };
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((candidate) => candidate.trim()))
      receive(JSON.parse(line) as RpcRecord);
  });

  const wait = (match: (record: RpcRecord) => boolean, timeoutMs = TIMEOUT_MS) => {
    const found = records.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Timed out waiting for Pi. stderr: ${stderr.join("").slice(-1500)}`)),
        timeoutMs,
      );
      waiters.push({ match, resolve: (record) => (clearTimeout(timer), resolve(record)) });
    });
  };

  const command = (type: string, payload: Record<string, unknown> = {}) => {
    const id = `test-${++nextId}`;
    const response = wait((record) => record.type === "response" && record.id === id);
    send({ id, type, ...payload });
    return response;
  };

  // The faux model is selected asynchronously at session start; a prompt sent before
  // that would go to Pi's default model, which has no credentials here.
  const waitForFauxModel = async () => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await command("get_state");
      const model = (state.data as { model?: { provider?: string } } | undefined)?.model;
      if (model?.provider === FAUX_PROVIDER) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The faux model was never selected.");
  };

  const prompt = async (message: string) => {
    if (!message.startsWith("/")) await waitForFauxModel();
    const settledBefore = records.filter((record) => record.type === "agent_settled").length;
    const response = await command("prompt", { message });
    if (response.success !== true)
      throw new Error(`Pi rejected ${message}: ${String(response.error)}`);
    if ((response.data as { disposition?: string } | undefined)?.disposition === "started") {
      await wait(
        () => records.filter((record) => record.type === "agent_settled").length > settledBefore,
      );
    }
  };

  const close = async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killTimer);
  };

  const notes = () =>
    records
      .filter((record) => record.type === "extension_ui_request" && record.method === "notify")
      .map((record) => String(record.message));

  return { records, notes, answerDialogs: (next) => (answer = next), wait, command, prompt, close };
}
