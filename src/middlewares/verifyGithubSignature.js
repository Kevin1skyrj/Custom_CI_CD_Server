import crypto from "node:crypto";

import { GITHUB_WEBHOOK_SECRET } from "../config/env.js";

function createExpectedSignature(rawBody) {
  const digest = crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  return `sha256=${digest}`;
}

function signaturesMatch(expectedSignature, receivedSignature) {
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(receivedSignature ?? "");

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

export function verifyGithubSignature(req, res, next) {
  const receivedSignature = req.get("x-hub-signature-256");
  const expectedSignature = createExpectedSignature(req.body);

  if (!signaturesMatch(expectedSignature, receivedSignature)) {
    return res.status(401).json({ message: "Invalid signature" });
  }

  return next();
}
