import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERIC_RULES, isNeutralEmail, isPrivateIPv4, looksLikeSecretValue } from "../../../src/publication/rules.ts";
import { scanLine } from "../../../src/publication/scanner.ts";
import { planted } from "../helpers/fixture.ts";

function rulesFor(line: string): string[] {
  return scanLine(line, []).map((m) => m.rule);
}

test("every generic rule detects its planted example", () => {
  const cases: Array<[string, string]> = [
    [planted.homePath(), "RH-HOME-PATH"],
    [planted.windowsHome(), "RH-HOME-PATH"],
    [planted.macTemp(), "RH-MACOS-TEMP-PATH"],
    [`contact ${planted.email()} today`, "RH-EMAIL"],
    [`host ${planted.privateIp()}:8080`, "RH-PRIVATE-IPV4"],
    [planted.privateKey(), "RH-PRIVATE-KEY"],
    [planted.githubToken(), "RH-TOKEN"],
    [planted.awsKey(), "RH-TOKEN"],
    [planted.skKey(), "RH-TOKEN"],
    [planted.secretAssignment(), "RH-SECRET-ASSIGNMENT"],
    [planted.envAssignment(), "RH-SECRET-ASSIGNMENT"],
  ];
  for (const [line, rule] of cases) assert.ok(rulesFor(line).includes(rule), `${rule} missed a planted example`);
});

test("safe neutral examples are not findings", () => {
  const safe = [
    "~/Documents/radian-harness/",
    "/Users/example/project and /home/user/x",
    "contact someone@example.com or 123+name@users.noreply.github.com",
    "remote git@github.com:owner/repo.git",
    "loopback 127.0.0.1 and public 8.8.8.8 and version 1.0.2",
    "const token: string = readToken();",
    'password = "<your-password>"',
    'api_key: "${API_KEY}"',
    'const tokenKey = "accessToken";',
    "@types/node@22.20.5 typescript@7.0.2",
  ];
  for (const line of safe) assert.deepEqual(rulesFor(line), [], `false positive on: ${line}`);
});

test("rule helper predicates", () => {
  assert.equal(isNeutralEmail("a@example.org"), true);
  assert.equal(isNeutralEmail("a@corp.invalid"), true);
  assert.equal(isNeutralEmail(planted.email()), false);
  assert.equal(isPrivateIPv4([10, 1, 2, 3]), true);
  assert.equal(isPrivateIPv4([172, 32, 0, 1]), false);
  assert.equal(isPrivateIPv4([300, 1, 1, 1]), false);
  assert.equal(looksLikeSecretValue("placeholder-value"), false);
  assert.equal(looksLikeSecretValue("Zq81mmP0x"), true);
});

test("rule IDs are stable and unique", () => {
  const ids = GENERIC_RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^RH-[A-Z0-9-]+$/);
});
