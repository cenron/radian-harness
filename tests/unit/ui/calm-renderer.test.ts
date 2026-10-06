import { test } from "node:test";
import assert from "node:assert/strict";
import { calmResolver } from "../../../src/ui/calm.ts";
import type { HostToolRenderers } from "../../../src/ui/pi-host.ts";

test("Calm preserves Pi's result fallback when a tool has no result renderer", () => {
  let enabled = false;
  const resolve = calmResolver(() => enabled, (text) => ({ text }));
  const bases: HostToolRenderers[] = [{}, { renderCall: () => ({ render: () => ["call"] }) }];
  for (const base of bases) {
    for (const mode of [false, true, false]) {
      enabled = mode;
      const resolved = resolve("ls", () => base);
      assert.equal(resolved, base, "leave missing callbacks absent so Pi uses its built-in fallback");
      assert.equal(resolved?.renderResult, undefined);
    }
  }
  assert.equal(resolve("unknown", () => undefined), undefined);
});
