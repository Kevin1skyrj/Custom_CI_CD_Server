import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const testRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "custom-cicd-deployment-")
);
let receivedHookPayload;
const hookServer = http.createServer((request, response) => {
  let body = "";

  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    receivedHookPayload = JSON.parse(body);
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "provider-deployment-123" }));
  });
});

await new Promise((resolve) => {
  hookServer.listen(0, "127.0.0.1", resolve);
});

const { port: hookPort } = hookServer.address();

process.env.GITHUB_WEBHOOK_SECRET = "deployment-test-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
process.env.PIPELINE_DATA_DIR = "./test-data/deployment-jobs";
process.env.PIPELINE_WORKSPACE_DIR = "./test-data/deployment-workspaces";
process.env.REPOSITORY_CLONE_URL = "test-repository";
process.env.PIPELINE_EXECUTION_ENABLED = "false";
process.env.DEPLOYMENT_TYPE = "local";
process.env.LOCAL_DEPLOY_DIR = path.join(testRoot, "deployments");
process.env.DEPLOY_HOOK_URL = `http://127.0.0.1:${hookPort}/deploy`;
process.env.DEPLOY_HOOK_TIMEOUT_MS = "5000";
process.env.SSH_HOST = "staging.example.com";
process.env.SSH_USER = "deployer";
process.env.SSH_PORT = "22";
process.env.SSH_PRIVATE_KEY_PATH = path.join(testRoot, "deploy-key");
process.env.SSH_KNOWN_HOSTS_FILE = path.join(testRoot, "known-hosts");
process.env.SSH_REMOTE_DEPLOY_DIR = "/srv/releases";
process.env.SSH_REMOTE_DEPLOY_SCRIPT = "/usr/local/bin/cicd-deploy";
process.env.SSH_TIMEOUT_MS = "5000";
process.env.S3_BUCKET = "static-staging-example";
process.env.S3_REGION = "ap-south-1";
process.env.S3_BUILD_DIR = "static-site";
process.env.S3_PREFIX = "staging";
process.env.HEALTH_CHECK_URL = "http://127.0.0.1/health-not-used";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";

const { deployToStaging } = await import(
  "../src/deployments/deployment.service.js"
);
const deployHookAdapter = await import(
  "../src/deployments/adapters/deploy-hook.adapter.js"
);
const sshAdapter = await import(
  "../src/deployments/adapters/ssh.adapter.js"
);
const s3StaticAdapter = await import(
  "../src/deployments/adapters/s3-static.adapter.js"
);

after(async () => {
  await new Promise((resolve) => hookServer.close(resolve));
  await fs.rm(testRoot, { recursive: true, force: true });
});

test("selects the configured deployment adapter", async () => {
  const context = {
    job: { id: "test-job" },
    workspace: "test-workspace",
  };
  let receivedContext;

  const result = await deployToStaging(context, {
    local: {
      async deploy(adapterContext) {
        receivedContext = adapterContext;

        return {
          provider: "local",
          deploymentId: "local-test-job",
        };
      },
    },
  });

  assert.equal(receivedContext, context);
  assert.equal(result.provider, "local");
  assert.equal(result.deploymentId, "local-test-job");
});

test("rejects a missing configured adapter", async () => {
  await assert.rejects(
    deployToStaging({}, {}),
    /Deployment adapter is unavailable: local/
  );
});

test("rejects an invalid adapter result", async () => {
  await assert.rejects(
    deployToStaging({}, { local: { async deploy() {} } }),
    /Deployment adapter must return a result object/
  );
});

test("copies a workspace into an isolated local staging directory", async () => {
  const workspace = path.join(testRoot, "workspace");
  const job = {
    id: "44444444-4444-4444-8444-444444444444",
  };

  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  await fs.writeFile(path.join(workspace, "artifact.txt"), "built", "utf8");
  await fs.writeFile(path.join(workspace, ".git", "config"), "git", "utf8");

  const result = await deployToStaging({ job, workspace });

  assert.equal(result.provider, "local");
  assert.equal(result.status, "deployed");
  assert.equal(
    await fs.readFile(path.join(result.deploymentPath, "artifact.txt"), "utf8"),
    "built"
  );
  await assert.rejects(
    fs.access(path.join(result.deploymentPath, ".git"))
  );
});

test("refuses to overwrite an existing local deployment", async () => {
  const workspace = path.join(testRoot, "second-workspace");
  const job = {
    id: "55555555-5555-4555-8555-555555555555",
  };

  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "artifact.txt"), "built", "utf8");

  await deployToStaging({ job, workspace });

  await assert.rejects(
    deployToStaging({ job, workspace }),
    /Local deployment target already exists/
  );
});

test("triggers a deployment hook without claiming completion", async () => {
  const job = {
    id: "66666666-6666-4666-8666-666666666666",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: "a".repeat(40),
  };

  const result = await deployHookAdapter.deploy({ job });

  assert.deepEqual(receivedHookPayload, {
    jobId: job.id,
    repository: job.repository,
    branch: job.branch,
    commitSha: job.commitSha,
  });
  assert.equal(result.provider, "deploy-hook");
  assert.equal(result.deploymentId, "provider-deployment-123");
  assert.equal(result.status, "triggered");
  assert.equal("deploymentUrl" in result, false);
});

test("prepares, uploads and activates an SSH staging release", async () => {
  const workspace = path.join(testRoot, "ssh-workspace");
  const job = {
    id: "77777777-7777-4777-8777-777777777777",
    commitSha: "b".repeat(40),
  };
  const commands = [];

  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "artifact.txt"), "built", "utf8");
  await fs.writeFile(process.env.SSH_PRIVATE_KEY_PATH, "test-key", "utf8");
  await fs.writeFile(
    process.env.SSH_KNOWN_HOSTS_FILE,
    "staging.example.com test-host-key",
    "utf8"
  );

  const result = await sshAdapter.deploy(
    { job, workspace },
    async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    }
  );

  assert.deepEqual(
    commands.map((command) => command.command),
    ["ssh", "scp", "ssh"]
  );
  assert.ok(commands[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(commands[0].args.includes("prepare"));
  assert.ok(commands[1].args.includes("-r"));
  assert.ok(commands[2].args.includes("activate"));
  assert.ok(commands[2].args.includes(job.commitSha));
  assert.equal(result.provider, "ssh");
  assert.equal(result.status, "deployed");
});

test("uploads static build files under a versioned S3 prefix", async () => {
  const workspace = path.join(testRoot, "s3-workspace");
  const buildDirectory = path.join(workspace, "static-site");
  const job = {
    id: "88888888-8888-4888-8888-888888888888",
  };
  const uploadedObjects = [];
  const s3Client = {
    async send(command) {
      uploadedObjects.push(command.input);
      return {};
    },
  };

  await fs.mkdir(path.join(buildDirectory, "assets"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(buildDirectory, "index.html"),
    "<h1>Staging</h1>",
    "utf8"
  );
  await fs.writeFile(
    path.join(buildDirectory, "assets", "app.js"),
    "console.log('built')",
    "utf8"
  );

  const result = await s3StaticAdapter.deploy(
    { job, workspace },
    { s3Client }
  );

  assert.deepEqual(
    uploadedObjects.map((object) => object.Key).sort(),
    [
      `staging/${job.id}/assets/app.js`,
      `staging/${job.id}/index.html`,
    ]
  );
  assert.equal(
    uploadedObjects.find((object) => object.Key.endsWith("index.html"))
      .ContentType,
    "text/html; charset=utf-8"
  );
  assert.equal(
    uploadedObjects.some((object) => "ACL" in object),
    false
  );
  assert.equal(result.provider, "s3-static");
  assert.equal(result.uploadedFiles, 2);
  assert.equal(result.status, "deployed");
});
