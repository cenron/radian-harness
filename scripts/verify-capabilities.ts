// Capability verification runner. Prints PASS/FAIL per capability on this
// machine. It records nothing: evidence is recorded only by the user with the
// interactive `/radian capabilities verify` command in Pi.
//
//   node scripts/verify-capabilities.ts --tier 1

import { nativeAvailable } from "../src/verification/harness.ts";
import { TIER1 } from "../src/verification/tier1.ts";
import { runTier2 } from "../src/verification/tier2.ts";
import { runTier3 } from "../src/verification/tier3.ts";
import type { CheckResult } from "../src/verification/harness.ts";

const tierArg = process.argv.indexOf("--tier");
const tier = tierArg >= 0 ? process.argv[tierArg + 1] : "1";
if (tier !== "1" && tier !== "2" && tier !== "3") {
  console.error(`tier ${tier} is not available yet`);
  process.exit(2);
}
if (!nativeAvailable()) {
  console.error("SKIP: requires macOS with /usr/bin/sandbox-exec");
  process.exit(77);
}
const results: CheckResult[] = [];
if (tier === "1") {
  for (const check of TIER1) {
    try {
      results.push(await check());
    } catch (error) {
      results.push({ capability: check.name as CheckResult["capability"], passed: false, details: [`FAIL check error: ${(error as Error).message}`] });
    }
  }
} else if (tier === "3") {
  results.push(...(await runTier3()));
} else {
  const report = await runTier2();
  results.push(...report.results);
  if (Object.keys(report.login).length) console.log(`Claude Code login (non-secret fields): ${JSON.stringify(report.login)}\n`);
}
let failed = 0;
for (const result of results) {
  if (!result.passed) failed += 1;
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.capability}`);
  for (const line of result.details) console.log(`     ${line}`);
}
console.log(`\n${results.length - failed}/${results.length} passed. Nothing was recorded.`);
process.exit(failed ? 1 : 0);
