import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdrRunner } from "../src/io/herdr.ts";
import { RegisterRadian } from "../src/pi/register.ts";

/** Pi package entry: wires Radian to the real Herdr and this checkout's config and roles. */
export default function radian(pi: ExtensionAPI): void {
  const registerRadian = new RegisterRadian(pi, {
    harnessRoot: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    herdr: createHerdrRunner(),
    paneId: process.env.HERDR_PANE_ID,
  });

  registerRadian.initialize();
}
