import type { HerdrResult, HerdrRunner } from "../../src/io/herdr.ts";

export interface FakeHerdr {
  run: HerdrRunner;
  calls: string[][];
  /** Agent status per open pane, as `pane get` reports it; delete an entry to simulate a closed pane. */
  panes: Map<string, string>;
  /** Makes `agent start` report a startup prompt (such as folder trust), as real Herdr does. */
  options: { isStartupBlocked: boolean };
}

// The exact output Herdr 0.9.1 gives when the agent shows a prompt before it is ready.
const STARTUP_BLOCKED = JSON.stringify({
  error: {
    code: "agent_not_ready",
    message: "agent demo-developer-1 is blocked during startup and is not ready for prompts",
  },
  id: "cli:agent:start",
});

/** Records every herdr call and answers the ones Radian reads. */
export function createFakeHerdr(): FakeHerdr {
  const calls: string[][] = [];
  const panes = new Map<string, string>();
  const options = { isStartupBlocked: false };
  let paneCount = 0;
  const run: HerdrRunner = async (args) => {
    calls.push([...args]);
    const [group, command, target] = args;
    if (group === "pane" && command === "split") {
      paneCount += 1;
      panes.set(`w9:p${paneCount}`, "unknown");
      return ok({ result: { pane: { pane_id: `w9:p${paneCount}` } } });
    }
    if (group === "agent" && command === "start") {
      panes.set(
        args[args.indexOf("--pane") + 1] ?? "",
        options.isStartupBlocked ? "blocked" : "idle",
      );
      if (options.isStartupBlocked) return { stdout: STARTUP_BLOCKED, stderr: "", exitCode: 1 };
    }
    if (group === "pane" && command === "get") {
      const status = panes.get(target ?? "");
      if (status === undefined) return { stdout: "", stderr: "pane not found", exitCode: 1 };
      return ok({ result: { pane: { pane_id: target, agent_status: status } } });
    }
    if (group === "pane" && command === "close") panes.delete(target ?? "");
    return ok({ result: {} });
  };
  return { run, calls, panes, options };
}

function ok(value: unknown): HerdrResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}
