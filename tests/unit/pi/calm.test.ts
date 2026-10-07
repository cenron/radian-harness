import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { makeTempDir } from "../../helpers/git-fixtures.ts";
import { calmResolver, readCalm, writeCalm } from "../../../src/pi/calm.ts";

initTheme("dark", false);
const ui = { requestRender() {} } as never;

function render(options: {
  isCalm: boolean;
  variant: "success" | "expanded" | "partial" | "error";
  base: ToolRenderers;
}) {
  const renderers = calmResolver(() => options.isCalm)("ls", () => options.base);
  const component = new ToolExecutionComponent(
    "ls",
    "call-1",
    { path: "." },
    {},
    renderers,
    ui,
    process.cwd(),
  );
  component.setArgsComplete();
  component.markExecutionStarted();
  if (options.variant === "expanded") component.setExpanded(true);
  component.updateResult(
    {
      content: [{ type: "text", text: "fixture output" }],
      details: undefined,
      isError: options.variant === "error",
    },
    options.variant === "partial",
  );
  return component.render(100).join("\n");
}

test("Calm keeps Pi's own renderer when a tool has no result renderer", () => {
  for (const isCalm of [false, true]) {
    for (const variant of ["success", "expanded", "partial", "error"] as const) {
      assert.match(render({ isCalm, variant, base: {} }), /fixture output/, `${isCalm}/${variant}`);
    }
  }
});

test("Calm hides successful results and shows expanded, partial, and error ones", () => {
  assert.equal(
    calmResolver(() => true)("ls", () => undefined),
    undefined,
  );
  const base: ToolRenderers = {
    renderResult: (result) => ({
      render: () => [(result.content[0] as { text: string }).text],
      invalidate() {},
    }),
  };
  assert.match(render({ isCalm: true, variant: "success", base }), /output hidden by Calm/);
  assert.match(render({ isCalm: false, variant: "success", base }), /fixture output/);
  for (const variant of ["expanded", "partial", "error"] as const) {
    assert.match(render({ isCalm: true, variant, base }), /fixture output/, variant);
  }
});

test("the Calm preference persists per workspace", () => {
  const root = makeTempDir();
  assert.equal(readCalm(root, false), false);
  writeCalm(root, true);
  assert.equal(readCalm(root, false), true);
});
