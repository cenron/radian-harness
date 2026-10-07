import type { HerdrResult, HerdrRunner } from "../../src/io/herdr.ts";

export interface FakeHerdr {
  run: HerdrRunner;
  calls: string[][];
  /** Agent status reported by `agent get`; delete an entry to simulate a closed pane. */
  agents: Map<string, string>;
}

/** Records every herdr call and answers the ones Radian reads. */
export function createFakeHerdr(): FakeHerdr {
  const calls: string[][] = [];
  const agents = new Map<string, string>();
  let paneCount = 0;
  const panes = new Map<string, string>();
  const run: HerdrRunner = async (args) => {
    calls.push([...args]);
    const [group, command, target] = args;
    if (group === "pane" && command === "split") {
      paneCount += 1;
      return ok({ result: { pane: { pane_id: `w9:p${paneCount}` } } });
    }
    if (group === "agent" && command === "start") {
      const name = target ?? "";
      agents.set(name, "idle");
      panes.set(name, args[args.indexOf("--pane") + 1] ?? "");
      return ok({ result: {} });
    }
    if (group === "agent" && command === "get") {
      const status = agents.get(target ?? "");
      if (status === undefined) return { stdout: "", stderr: "agent not found", exitCode: 1 };
      return ok({ result: { agent: { agent_status: status, pane_id: panes.get(target ?? "") } } });
    }
    if (group === "pane" && command === "close") {
      for (const [name, pane] of panes) if (pane === target) agents.delete(name);
    }
    return ok({ result: {} });
  };
  return { run, calls, agents };
}

function ok(value: unknown): HerdrResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}
