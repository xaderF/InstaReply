import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifySignature } from "../../apps/server/src/utils/verifySignature";

function sign(rawBody: string, appSecret: string): string {
  const digest = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return `sha256=${digest}`;
}

test("verifySignature returns true for valid HMAC signature", () => {
  const appSecret = "secret_123";
  const rawBody = JSON.stringify({ hello: "world" });
  const header = sign(rawBody, appSecret);

  assert.equal(verifySignature(rawBody, header, appSecret), true);
});

test("verifySignature rejects missing and malformed signatures", () => {
  const appSecret = "secret_123";
  const rawBody = JSON.stringify({ hello: "world" });

  assert.equal(verifySignature(rawBody, undefined, appSecret), false);
  assert.equal(verifySignature(rawBody, "abc123", appSecret), false);
  assert.equal(verifySignature(rawBody, "sha256=zzzz", appSecret), false);
});

test("verifySignature rejects mismatched signatures", () => {
  const appSecret = "secret_123";
  const rawBody = JSON.stringify({ hello: "world" });
  const invalid = sign(rawBody, "wrong_secret");

  assert.equal(verifySignature(rawBody, invalid, appSecret), false);
});
