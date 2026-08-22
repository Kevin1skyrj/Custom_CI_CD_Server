import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";

let healthRequests = 0;
const healthServer = http.createServer((request, response) => {
  healthRequests += 1;

  if (healthRequests === 1) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "starting" }));
    return;
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ status: "healthy" }));
});

await new Promise((resolve) => {
  healthServer.listen(0, "127.0.0.1", resolve);
});

const { port: healthPort } = healthServer.address();

process.env.GITHUB_WEBHOOK_SECRET = "health-test-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
process.env.PIPELINE_DATA_DIR = "./test-data/health-jobs";
process.env.PIPELINE_WORKSPACE_DIR = "./test-data/health-workspaces";
process.env.REPOSITORY_CLONE_URL = "test-repository";
process.env.PIPELINE_EXECUTION_ENABLED = "false";
process.env.DEPLOYMENT_TYPE = "local";
process.env.LOCAL_DEPLOY_DIR = "./test-data/health-deployments";
process.env.HEALTH_CHECK_URL = `http://127.0.0.1:${healthPort}/health`;
process.env.HEALTH_CHECK_ATTEMPTS = "3";
process.env.HEALTH_CHECK_INTERVAL_MS = "1";
process.env.HEALTH_CHECK_TIMEOUT_MS = "1000";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "true";
process.env.SMTP_HOST = "smtp.example.com";
process.env.SMTP_PORT = "587";
process.env.SMTP_SECURE = "false";
process.env.SMTP_USER = "smtp-user";
process.env.SMTP_PASSWORD = "smtp-password";
process.env.EMAIL_FROM = "ci@example.com";
process.env.EMAIL_TO = "owner@example.com";

const { checkDeploymentHealth } = await import(
  "../src/services/health-check.service.js"
);
const { sendPipelineNotification } = await import(
  "../src/services/notification.service.js"
);

after(async () => {
  await new Promise((resolve) => healthServer.close(resolve));
});

test("retries health checks until the deployment becomes healthy", async () => {
  const result = await checkDeploymentHealth();

  assert.equal(result.status, "healthy");
  assert.equal(result.statusCode, 200);
  assert.equal(result.attempts, 2);
});

test("returns safe failure details after health retries are exhausted", async () => {
  await assert.rejects(
    checkDeploymentHealth({
      async fetchImpl() {
        return { ok: false, status: 503 };
      },
      async waitImpl() {},
    }),
    (error) => {
      assert.equal(error.message, "Deployment health check failed");
      assert.equal(error.healthResult.status, "unhealthy");
      assert.equal(error.healthResult.statusCode, 503);
      assert.equal(error.healthResult.attempts, 3);
      return true;
    }
  );
});

test("sends a concise terminal pipeline email", async () => {
  let sentMessage;
  const transporter = {
    async sendMail(message) {
      sentMessage = message;
      return { messageId: "email-message-123" };
    },
  };
  const job = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: "c".repeat(40),
    status: "succeeded",
    healthCheck: {
      status: "healthy",
      attempts: 2,
    },
  };

  const result = await sendPipelineNotification(job, { transporter });

  assert.equal(sentMessage.from, "ci@example.com");
  assert.equal(sentMessage.to, "owner@example.com");
  assert.match(sentMessage.subject, /Deployment succeeded/);
  assert.match(sentMessage.text, /Status: succeeded/);
  assert.match(sentMessage.text, new RegExp(job.commitSha));
  assert.match(sentMessage.text, /Health attempts: 2/);
  assert.equal(sentMessage.text.includes("smtp-password"), false);
  assert.equal(result.status, "sent");
  assert.equal(result.messageId, "email-message-123");
});
