import type { HerdrResult, HerdrRunner } from "../../src/io/herdr.ts";

export interface FakeHerdr {
  run: HerdrRunner;
  calls: string[][];
  /** Agent status per open pane, as `pane get` reports it; delete an entry to simulate a closed pane. */
  panes: Map<string, string>;
}

/** Records every herdr call and answers the ones Radian reads. */
export function createFakeHerdr(): FakeHerdr {
  const calls: string[][] = [];
  const panes = new Map<string, string>();
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
      panes.set(args[args.indexOf("--pane") + 1] ?? "", "idle");
    }
    if (group === "pane" && command === "get") {
      const status = panes.get(target ?? "");
      if (status === undefined) return { stdout: "", stderr: "pane not found", exitCode: 1 };
      return ok({ result: { pane: { pane_id: target, agent_status: status } } });
    }
    if (group === "pane" && command === "close") panes.delete(target ?? "");
    return ok({ result: {} });
  };
  return { run, calls, panes };
}

function ok(value: unknown): HerdrResult {
  return { stdout: JSON.stringify(value), stderr: "", exitCode: 0 };
}
