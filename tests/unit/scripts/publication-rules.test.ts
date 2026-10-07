import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedEmail, parseDenylist, scanLine } from "../../../scripts/publication-rules.ts";

// Secrets are assembled at runtime so this file stays clean under its own scanner.
const homePath = "/Us" + "ers/jane/project";
const linuxHomePath = "/ho" + "me/jane/.config";
const privateEmail = ["jane.doe", "company.com"].join("@");
const githubToken = "gh" + "p_" + "a".repeat(36);
const githubFineGrained = "github" + "_pat_" + "B".repeat(30);
const anthropicKey = "sk" + "-ant-" + "c".repeat(30);
const openaiKey = "sk" + "-" + "d".repeat(24);
const awsKey = "AK" + "IA" + "E".repeat(16);
const slackToken = "xo" + "xb-" + "1234567890-abcdef";
const privateKeyHeader = "-----BEGIN " + "RSA PRIVATE " + "KEY-----";

function rulesIn(line: string, denylist: string[] = []): string[] {
  return scanLine(line, denylist).map((finding) => finding.rule);
}

test("home-path matches user home directories and masks the name", () => {
  assert.deepEqual(rulesIn(`see ${homePath}/src`), ["home-path"]);
  assert.deepEqual(rulesIn(linuxHomePath), ["home-path"]);
  assert.equal(scanLine(homePath)[0]?.excerpt, "/Users/***");
});

test("home-path ignores paths without a name segment", () => {
  assert.deepEqual(rulesIn("macOS keeps homes under /Users/ and Linux under /home/"), []);
  assert.deepEqual(rulesIn("~/projects and $HOME/projects"), []);
  assert.deepEqual(rulesIn("/opt/Users/jane is not a home"), []);
});

test("email matches private addresses and masks the local part", () => {
  assert.deepEqual(rulesIn(`contact ${privateEmail}`), ["email"]);
  assert.equal(scanLine(privateEmail)[0]?.excerpt, "j***@company.com");
});

test("email ignores the allowed addresses", () => {
  for (const address of [
    "noreply@anthropic.com",
    "someone@example.com",
    "test@example.invalid",
    "12345+jane@users.noreply.github.com",
  ]) {
    assert.ok(isAllowedEmail(address), address);
    assert.deepEqual(rulesIn(`Author: ${address}`), [], address);
  }
});

test("token matches each supported family and keeps only the prefix", () => {
  for (const token of [
    githubToken,
    githubFineGrained,
    anthropicKey,
    openaiKey,
    awsKey,
    slackToken,
  ]) {
    assert.deepEqual(rulesIn(`key=${token}`), ["token"], token.slice(0, 4));
  }
  assert.equal(scanLine(githubToken)[0]?.excerpt, "ghp_***");
  assert.equal(scanLine(anthropicKey)[0]?.excerpt, "sk-ant-***");
});

test("token ignores near-misses", () => {
  assert.deepEqual(rulesIn("sk-short and sk-1234567890"), []);
  assert.deepEqual(rulesIn("risk-assessment-for-the-whole-project"), []);
  assert.deepEqual(rulesIn("ghp_tooshort AKIA123"), []);
});

test("private-key matches PEM private key headers only", () => {
  assert.deepEqual(rulesIn(privateKeyHeader), ["private-key"]);
  assert.deepEqual(rulesIn("-----BEGIN " + "PUBLIC KEY-----"), []);
});

test("denylist matches literals case-insensitively without echoing them", () => {
  const findings = scanLine("Built for Acme Corp", ["unused", "acme corp"]);
  assert.deepEqual(findings, [{ rule: "denylist", column: 11, excerpt: "entry 2" }]);
});

test("parseDenylist skips blank lines and comments", () => {
  assert.deepEqual(parseDenylist("# private\nAcme\n\n  secret-project  \n"), [
    "Acme",
    "secret-project",
  ]);
});
