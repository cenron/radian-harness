// Child process for cross-process capacity contention tests.
import { CapacityLedger } from "../../../src/state/capacity.ts";

const [dir, ceiling, assignment] = process.argv.slice(2);
const ledger = new CapacityLedger(dir!);
const result = await ledger.reserve(Number(ceiling), { project: "prj_fixture1", run: "run_fixture1", assignment: assignment!, role: "developer" });
process.stdout.write(result.ok ? "ok" : result.blocker.code);
