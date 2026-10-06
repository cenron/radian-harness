// `otool -L` prints one unindented header per architecture for universal
// binaries (for example Godot); only the indented lines are libraries. The
// headers were parsed as missing libraries, refusing such tools.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoadCommands } from "../../../src/isolation/dependencies.ts";

test("universal-binary architecture headers are not libraries", () => {
  const output = [
    "/Applications/Tool.app/Contents/MacOS/Tool (architecture x86_64):",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)",
    "\t@rpath/libtool.dylib (compatibility version 1.0.0, current version 1.0.0)",
    "/Applications/Tool.app/Contents/MacOS/Tool (architecture arm64):",
    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)",
    "",
  ].join("\n");
  assert.deepEqual([...new Set(parseLoadCommands(output).libraries)], ["/usr/lib/libSystem.B.dylib", "@rpath/libtool.dylib"]);
  const single = "/usr/local/bin/x:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1.0.0)\n";
  assert.deepEqual(parseLoadCommands(single).libraries, ["/usr/lib/libc++.1.dylib"]);
});
