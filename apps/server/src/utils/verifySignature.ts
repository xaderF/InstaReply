import crypto from "node:crypto";

export function verifySignature(
  rawBody: string,
  headerSignature: string | undefined,
  appSecret: string
): boolean {
  if (!headerSignature || !headerSignature.startsWith("sha256=")) {
    return false;
  }

  const received = headerSignature.slice("sha256=".length).trim();
  const expected = crypto
    .createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("hex");

  const receivedBuffer = Buffer.from(received, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
