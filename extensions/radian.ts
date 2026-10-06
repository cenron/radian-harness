// Radian's Pi package entry point: a thin integration layer. All behavior lives
// in src/ (controller, session composition, coordinator services). Host
// packages are provided by Pi at runtime and are not bundled.

import { CustomEditor, createFindToolDefinition, createGrepToolDefinition, createLocalBashOperations, getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerRadian } from "../src/ui/controller.ts";
import type { PiHost } from "../src/ui/pi-host.ts";
import { openProjectSession, startRun } from "../src/ui/session.ts";

export default function radian(pi: PiHost): void {
  registerRadian(pi, {
    loadRuntime: async () => ({ CustomEditor, matchesKey, Text, Type, getAgentDir, loadProjectContextFiles, createGrepToolDefinition, createFindToolDefinition, createLocalBashOperations }),
    openSession: openProjectSession,
    startRun,
  });
}
