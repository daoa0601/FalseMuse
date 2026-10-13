import test from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../src/redact.ts";

// The cases of tests/test_normalize.py, which the Python rules pass.
test("thread text loses keys, passwords and credential values, and keeps prose", () => {
  const key = "ghp_" + "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4";
  const password = "local" + "-password-123";
  const value = "opaque-credential-value-123";
  const credential = Buffer.from("reader:local-password-123").toString("base64");
  const prose = "Prime and Pi share the same basic token-budget-triggered compaction design.";
  assert.equal(redactText(`Use this key ${key}`), "Use this key [REDACTED]");
  assert.equal(
    redactText(`DB_PASSWORD=${password}\nhttps://reader:${password}@example.test/path`),
    "DB_PASSWORD=[REDACTED]\nhttps://reader:[REDACTED]@example.test/path",
  );
  assert.equal(redactText(`cursorAuth/openAIKey → ${value}`), "cursorAuth/openAIKey → [REDACTED]");
  assert.equal(redactText(`{"accessToken": "${value}"}`), '{"accessToken": "[REDACTED]"}');
  assert.equal(redactText(`Header: Basic ${credential}`), "Header: [REDACTED]");
  assert.equal(redactText(prose), prose);
  assert.equal(
    redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"),
    "Authorization: [REDACTED]",
  );
  assert.equal(
    // Assembled so the repository's own secret scan does not flag this fixture.
    redactText(
      ["BEGIN", "END"].map((edge) => `-----${edge} PRIVATE ${"KEY"}-----`).join("\nMIIE\n"),
    ),
    "[REDACTED]",
  );
  assert.equal(
    redactText(`Saved it:\n-----BEGIN RSA PRIVATE ${"KEY"}-----\nMIIEowIBAAKCAQEA`),
    "Saved it:\n[REDACTED]",
  );
  assert.equal(redactText("The tests pass: 44 of 44."), "The tests pass: 44 of 44.");
});
