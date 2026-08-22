import crypto from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, before, test } from "node:test";

process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
process.env.PIPELINE_DATA_DIR = "./test-data/pipeline-jobs";
process.env.PIPELINE_WORKSPACE_DIR = "./test-data/workspaces";
process.env.REPOSITORY_CLONE_URL = "./test-data/source-repository";
process.env.PIPELINE_EXECUTION_ENABLED = "false";
process.env.DEPLOYMENT_TYPE = "local";
process.env.LOCAL_DEPLOY_DIR = "./test-data/local-deployments";
process.env.HEALTH_CHECK_URL = "http://127.0.0.1/health-not-used";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";

const { default: app } = await import("../src/app.js");

let server;
let baseUrl;

before(async () => {
  await fs.rm("./test-data", { recursive: true, force: true });
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
  await fs.rm("./test-data", { recursive: true, force: true });
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

test("creates a persistent job for an authorized push", async () => {
  const commitSha = "a".repeat(40);

  const body = JSON.stringify({
    after: commitSha,
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
      "x-github-delivery": "delivery-123",
      "x-github-event": "push",
      "x-hub-signature-256": signature,
    },
    body,
  });

  assert.equal(response.status, 202);

  const responseBody = await response.json();
  assert.ok(responseBody.jobId);

  const jobDirectory =
    `./test-data/pipeline-jobs/${responseBody.jobId}`;

  const savedJob = JSON.parse(
    await fs.readFile(`${jobDirectory}/job.json`, "utf8")
  );

  const savedLog = await fs.readFile(
    `${jobDirectory}/pipeline.log`,
    "utf8"
  );

  assert.equal(savedJob.deliveryId, "delivery-123");
  assert.equal(savedJob.repository, "test-owner/test-repo");
  assert.equal(savedJob.branch, "main");
  assert.equal(savedJob.commitSha, commitSha);
  assert.equal(savedJob.status, "queued");
  assert.match(savedLog, /Pipeline job created and queued/);

  const jobResponse = await fetch(
    `${baseUrl}/pipeline-jobs/${responseBody.jobId}`
  );
  const jobResponseBody = await jobResponse.json();

  assert.equal(jobResponse.status, 200);
  assert.equal(jobResponseBody.job.id, responseBody.jobId);
  assert.equal(jobResponseBody.job.commitSha, commitSha);
  assert.match(
    jobResponseBody.job.log,
    /Pipeline job created and queued/
  );

  const duplicateResponse = await fetch(
    `${baseUrl}/webhook/github`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-123",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      body,
    }
  );
  const duplicateBody = await duplicateResponse.json();

  assert.equal(duplicateResponse.status, 200);
  assert.equal(duplicateBody.jobId, responseBody.jobId);
  assert.equal(duplicateBody.duplicate, true);

  const dataEntries = await fs.readdir(
    "./test-data/pipeline-jobs",
    { withFileTypes: true }
  );
  const jobDirectories = dataEntries.filter(
    (entry) => entry.isDirectory() && entry.name !== "deliveries"
  );

  assert.equal(jobDirectories.length, 1);
});

test("returns 404 for an invalid pipeline job ID", async () => {
  const response = await fetch(
    `${baseUrl}/pipeline-jobs/not-a-valid-job-id`
  );

  assert.equal(response.status, 404);
});

test("returns 404 for a valid but unknown pipeline job ID", async () => {
  const response = await fetch(
    `${baseUrl}/pipeline-jobs/00000000-0000-4000-8000-000000000000`
  );

  assert.equal(response.status, 404);
});

test("deduplicates concurrent deliveries atomically", async () => {
  const body = JSON.stringify({
    after: "b".repeat(40),
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

  const sendDelivery = () =>
    fetch(`${baseUrl}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "concurrent-delivery",
        "x-github-event": "push",
        "x-hub-signature-256": signature,
      },
      body,
    });

  const responses = await Promise.all([
    sendDelivery(),
    sendDelivery(),
  ]);
  const responseBodies = await Promise.all(
    responses.map((response) => response.json())
  );

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 202]
  );
  assert.equal(responseBodies[0].jobId, responseBodies[1].jobId);
  assert.deepEqual(
    responseBodies.map((response) => response.duplicate).sort(),
    [false, true]
  );
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
