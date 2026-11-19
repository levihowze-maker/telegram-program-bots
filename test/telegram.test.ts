import test from "node:test";
import assert from "node:assert/strict";
import { classifyTelegramResponse } from "../src/platform/telegram.ts";
import { redact } from "../src/platform/redact.ts";

test("429 honours retry_after", () => {
  const out = classifyTelegramResponse(429, JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 7 } }));
  assert.deepEqual(out, { kind: "retry", retryAfterSec: 7 });
});

test("5xx is unknown, never auto-retried", () => {
  assert.equal(classifyTelegramResponse(502, "bad gateway").kind, "unknown");
});

test("403 is a definitive stop", () => {
  const out = classifyTelegramResponse(403, JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
  assert.equal(out.kind, "forbidden");
});

test("success returns the message id", () => {
  assert.deepEqual(classifyTelegramResponse(200, JSON.stringify({ ok: true, result: { message_id: 42 } })), { kind: "sent", messageId: 42 });
});

test("redact masks secret-named fields and token-shaped strings", () => {
  const fake = "123456789:" + "A".repeat(30);
  const out = redact({ apiToken: "x", note: `sent with ${fake}` }) as Record<string, string>;
  assert.equal(out.apiToken, "[redacted]");
  assert.equal(out.note, "sent with [redacted-token]");
});
