import crypto from "node:crypto";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";

const { default: app } = await import("../src/app.js");

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
  });
});

test("rejects a webhook without a signature", async () => {
  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "test webhook" }),
  });

  assert.equal(response.status, 401);
});

test("rejects a webhook with an incorrect signature", async () => {
  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=incorrect",
    },
    body: JSON.stringify({ message: "test webhook" }),
  });

  assert.equal(response.status, 401);
});

test("accepts a webhook with a valid signature", async () => {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: {
      full_name: "test-owner/test-repo",
    },
  });

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "push",
    },
    body,
  });

  assert.equal(response.status, 200);
});

test("rejects a modified body signed with an old signature", async () => {
  const originalBody = JSON.stringify({ message: "original" });
  const modifiedBody = JSON.stringify({ message: "modified" });

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(originalBody)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    },
    body: modifiedBody,
  });

  assert.equal(response.status, 401);
});

test("ignores a signed non-push event", async () => {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: {
      full_name: "test-owner/test-repo",
    },
  });

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "ping",
    },
    body,
  });

  assert.equal(response.status, 202);
});

test("rejects malformed JSON after signature verification", async () => {
  const body = "{invalid-json";

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "push",
    },
    body,
  });

  assert.equal(response.status, 400);
});

test("rejects a push from an unauthorized repository", async () => {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    repository: {
      full_name: "attacker/different-repository",
    },
  });

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "push",
    },
    body,
  });

  assert.equal(response.status, 403);
});
test("ignores a push to a non-deployment branch", async () => {
  const body = JSON.stringify({
    ref: "refs/heads/feature/new-dashboard",
    repository: {
      full_name: "test-owner/test-repo",
    },
  });

  const signature =
    "sha256=" +
    crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(body)
      .digest("hex");

  const response = await fetch(`${baseUrl}/webhook/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "push",
    },
    body,
  });

  assert.equal(response.status, 202);
});
