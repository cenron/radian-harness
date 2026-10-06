// Exercise Pi's public interactive component offline, without a running Pi
// session, model, credentials, provider traffic, or Herdr operations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveExecutable } from "../../src/util/proc.ts";
import { removeDir, tempDir } from "../unit/helpers/fixture.ts";

/** Pi's package entry and Node interpreter in the reviewed Homebrew layout (test-only; workers run the Pi CLI). */
function piPackage(): { ok: true; value: { node: string; entry: string } } | undefined {
  const executable = resolveExecutable("pi", process.env.PATH);
  if (!executable) return undefined;
  const root = path.dirname(path.dirname(realpathSync(executable)));
  const entry = path.join(root, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  const launcher = path.join(root, "libexec", "bin", "pi");
  if (!existsSync(entry) || !existsSync(launcher)) return undefined;
  const firstLine = spawnSync("/usr/bin/head", ["-1", launcher], { encoding: "utf8" }).stdout.trim();
  if (!firstLine.startsWith("#!/")) return undefined;
  return { ok: true, value: { node: realpathSync(firstLine.slice(2)), entry } };
}
const layout = piPackage();
const available = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && layout?.ok;

test("Calm: native Pi TUI renders tools without result callbacks in off/on, expanded, partial, and error states", { skip: available ? false : "reviewed Pi layout and macOS sandbox required" }, () => {
  if (!layout?.ok) return;
  const scratch = tempDir("radian-calm-render-");
  try {
    const script = `
      import assert from 'node:assert/strict';
      const { ToolExecutionComponent, initTheme } = await import(process.argv[1]);
      const { calmResolver } = await import(process.argv[2]);
      initTheme('dark', false);
      const ui = { requestRender() {} };
      for (const enabled of [false, true]) {
        const resolve = calmResolver(() => enabled, () => { throw new Error('missing renderer must use Pi fallback'); });
        for (const base of [{}, { renderCall: () => ({ render: () => ['call'], invalidate() {} }) }]) {
          for (const variant of ['success', 'expanded', 'partial', 'error']) {
            const renderers = resolve('ls', () => base);
            const component = new ToolExecutionComponent('ls', 'fixture-call', { path: '.' }, {}, renderers, ui, process.cwd());
            component.setArgsComplete();
            component.markExecutionStarted();
            if (variant === 'expanded') component.setExpanded(true);
            component.updateResult({ content: [{ type: 'text', text: 'fixture output' }], details: undefined, isError: variant === 'error' }, variant === 'partial');
            for (const width of [40, 120]) {
              const lines = component.render(width);
              assert.ok(lines.length > 0);
              assert.ok(lines.some(line => line.includes('fixture output')), enabled + '/' + variant);
            }
          }
        }
      }
      console.log('native renderer regression passed');
    `;
    const out = spawnSync("/usr/bin/sandbox-exec", ["-p", `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(scratch)}))`, layout.value.node, "--input-type=module", "-e", script, pathToFileURL(layout.value.entry).href, new URL("../../src/ui/calm.ts", import.meta.url).href], {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, PI_CODING_AGENT_DIR: path.join(scratch, "agent"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.match(out.stdout, /native renderer regression passed/);
  } finally {
    removeDir(scratch);
  }
});
