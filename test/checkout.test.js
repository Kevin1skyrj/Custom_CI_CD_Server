import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "custom-cicd-checkout-")
);
const sourceRepository = path.join(testRoot, "source");
const pipelineDataDirectory = path.join(testRoot, "jobs");
const workspaceDirectory = path.join(testRoot, "workspaces");

process.env.GITHUB_WEBHOOK_SECRET = "checkout-test-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
process.env.PIPELINE_DATA_DIR = pipelineDataDirectory;
process.env.PIPELINE_WORKSPACE_DIR = workspaceDirectory;
process.env.REPOSITORY_CLONE_URL = sourceRepository;
process.env.PIPELINE_EXECUTION_ENABLED = "true";
process.env.DEPLOYMENT_TYPE = "local";
process.env.LOCAL_DEPLOY_DIR = path.join(testRoot, "local-deployments");
process.env.HEALTH_CHECK_URL = "http://127.0.0.1/health-not-used";
process.env.EMAIL_NOTIFICATIONS_ENABLED = "false";

const {
  appendPipelineLog,
  findPipelineJobById,
  readPipelineLog,
  savePipelineJob,
} = await import("../src/repositories/pipeline.repository.js");
const { schedulePipelineJob } = await import(
  "../src/services/pipeline-runner.service.js"
);
const { findCurrentHealthyRelease } = await import(
  "../src/repositories/release.repository.js"
);

after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function runGit(args, cwd) {
  return execFileAsync("git", args, { cwd, windowsHide: true });
}

test("checks out and verifies the exact requested commit", async () => {
  await fs.mkdir(sourceRepository);
  await runGit(["init"], sourceRepository);
  await runGit(["config", "user.name", "CI Test"], sourceRepository);
  await runGit(
    ["config", "user.email", "ci-test@example.com"],
    sourceRepository
  );

  const versionFile = path.join(sourceRepository, "version.txt");

  await fs.mkdir(path.join(sourceRepository, "server"));
  await fs.mkdir(path.join(sourceRepository, "client"));

  const serverPackage = {
    name: "server",
    version: "1.0.0",
  };
  const clientPackage = {
    name: "client",
    version: "1.0.0",
    scripts: {
      test: "node -e \"console.log('tests passed')\"",
      build:
        "node -e \"require('node:fs').writeFileSync('built.txt','built')\"",
    },
  };

  for (const [directory, packageFile] of [
    ["server", serverPackage],
    ["client", clientPackage],
  ]) {
    await fs.writeFile(
      path.join(sourceRepository, directory, "package.json"),
      JSON.stringify(packageFile),
      "utf8"
    );
    await fs.writeFile(
      path.join(sourceRepository, directory, "package-lock.json"),
      JSON.stringify({
        name: packageFile.name,
        version: packageFile.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: packageFile.name,
            version: packageFile.version,
          },
        },
      }),
      "utf8"
    );
  }

  await fs.writeFile(versionFile, "first version", "utf8");
  await runGit(["add", "."], sourceRepository);
  await runGit(["commit", "-m", "first commit"], sourceRepository);

  const { stdout: firstCommitOutput } = await runGit(
    ["rev-parse", "HEAD"],
    sourceRepository
  );
  const firstCommit = firstCommitOutput.trim();

  await fs.writeFile(versionFile, "second version", "utf8");
  await runGit(["add", "version.txt"], sourceRepository);
  await runGit(["commit", "-m", "second commit"], sourceRepository);

  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    deliveryId: "checkout-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: firstCommit,
    status: "queued",
    createdAt: new Date().toISOString(),
  };

  await savePipelineJob(job);
  await appendPipelineLog(job.id, "Pipeline job created and queued");
  await schedulePipelineJob(job, undefined, {
    async healthCheck() {
      return {
        status: "healthy",
        statusCode: 200,
        attempts: 1,
        durationMs: 1,
      };
    },
    async notify() {
      throw new Error("Expected notification failure");
    },
  });

  const workspace = path.join(workspaceDirectory, job.id);
  const checkedOutContent = await fs.readFile(
    path.join(workspace, "version.txt"),
    "utf8"
  );
  const savedJob = await findPipelineJobById(job.id);
  const savedLog = await readPipelineLog(job.id);
  const currentRelease = await findCurrentHealthyRelease(job.repository);

  assert.equal(checkedOutContent, "first version");
  assert.equal(savedJob.status, "succeeded");
  assert.ok(savedJob.startedAt);
  assert.ok(savedJob.checkedOutAt);
  assert.ok(savedJob.buildCompletedAt);
  assert.ok(savedJob.deployedAt);
  assert.ok(savedJob.completedAt);
  assert.equal(savedJob.deployment.provider, "local");
  assert.equal(savedJob.healthCheck.status, "healthy");
  assert.equal(currentRelease.jobId, job.id);
  assert.equal(currentRelease.commitSha, firstCommit);
  assert.equal(savedJob.stageResults.length, 4);
  assert.equal(
    await fs.readFile(path.join(workspace, "client", "built.txt"), "utf8"),
    "built"
  );
  assert.match(savedLog, /Exact commit checkout started/);
  assert.match(savedLog, new RegExp(firstCommit));
  assert.match(savedLog, /client:test succeeded/);
  assert.match(savedLog, /client:build succeeded/);
  assert.match(savedLog, /deployment:local completed/);
  assert.match(savedLog, /Deployment is healthy/);
  assert.match(
    savedLog,
    /Email notification failed; pipeline result was not changed/
  );
});

test("persists a failed status when checkout cannot start", async () => {
  const job = {
    id: "22222222-2222-4222-8222-222222222222",
    deliveryId: "invalid-checkout-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: "not-a-commit-sha",
    status: "queued",
    createdAt: new Date().toISOString(),
  };

  await savePipelineJob(job);
  await appendPipelineLog(job.id, "Pipeline job created and queued");

  await assert.rejects(
    schedulePipelineJob(job),
    /Commit SHA must contain 40 hexadecimal characters/
  );

  const savedJob = await findPipelineJobById(job.id);
  const savedLog = await readPipelineLog(job.id);

  assert.equal(savedJob.status, "failed");
  assert.equal(savedJob.failedStage, "checkout");
  assert.ok(savedJob.failedAt);
  assert.match(savedLog, /Pipeline failed during checkout/);
});

test("persists the failed stage and skips later stages", async () => {
  const { stdout: firstCommitOutput } = await runGit(
    ["rev-list", "--max-parents=0", "HEAD"],
    sourceRepository
  );
  const job = {
    id: "33333333-3333-4333-8333-333333333333",
    deliveryId: "failed-stage-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: firstCommitOutput.trim(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  const workspace = path.join(workspaceDirectory, job.id);
  const markerFile = path.join(workspace, "should-not-exist.txt");

  await savePipelineJob(job);

  const components = [
    {
      name: "application",
      directory: ".",
      stages: [
        {
          name: "test",
          status: "testing",
          command: process.execPath,
          args: ["-e", "process.exit(2)"],
          timeoutMs: 5000,
        },
        {
          name: "build",
          status: "building",
          command: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync('should-not-exist.txt','ran')",
          ],
          timeoutMs: 5000,
        },
      ],
    },
  ];

  await assert.rejects(
    schedulePipelineJob(job, components),
    /Stage command exited with code 2/
  );

  const savedJob = await findPipelineJobById(job.id);

  assert.equal(savedJob.status, "failed");
  assert.equal(savedJob.failedStage, "application:test");
  assert.equal(savedJob.stageResults[0].status, "failed");
  assert.equal(savedJob.stageResults[0].exitCode, 2);
  await assert.rejects(fs.access(markerFile));
});

test("persists deployment adapter failures", async () => {
  const { stdout: firstCommitOutput } = await runGit(
    ["rev-list", "--max-parents=0", "HEAD"],
    sourceRepository
  );
  const job = {
    id: "99999999-9999-4999-8999-999999999999",
    deliveryId: "failed-deployment-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: firstCommitOutput.trim(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  const adapters = {
    local: {
      async deploy() {
        throw new Error("Expected staging failure");
      },
    },
  };

  await savePipelineJob(job);

  await assert.rejects(
    schedulePipelineJob(job, [], { adapters }),
    /Expected staging failure/
  );

  const savedJob = await findPipelineJobById(job.id);
  const savedLog = await readPipelineLog(job.id);

  assert.equal(savedJob.status, "failed");
  assert.equal(savedJob.failedStage, "deployment:local");
  assert.match(savedLog, /Pipeline failed during deployment:local/);
});

test("rolls back an unhealthy deployment and notifies recovered state", async () => {
  const { stdout: firstCommitOutput } = await runGit(
    ["rev-list", "--max-parents=0", "HEAD"],
    sourceRepository
  );
  const job = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    deliveryId: "unhealthy-deployment-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: firstCommitOutput.trim(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  let notifiedJob;
  let healthChecks = 0;
  const healthError = new Error("Deployment health check failed");
  healthError.healthResult = {
    status: "unhealthy",
    statusCode: 503,
    attempts: 3,
    durationMs: 10,
  };

  await savePipelineJob(job);

  await assert.rejects(
    schedulePipelineJob(job, [], {
      adapters: {
        local: {
          async deploy() {
            return {
              provider: "local",
              deploymentId: job.id,
              status: "deployed",
            };
          },
          async rollback({ previousRelease }) {
            return {
              provider: "local",
              deploymentId: previousRelease.jobId,
              status: "rolled_back",
            };
          },
        },
      },
      async healthCheck() {
        healthChecks += 1;

        if (healthChecks === 1) {
          throw healthError;
        }

        return {
          status: "healthy",
          statusCode: 200,
          attempts: 1,
          durationMs: 1,
        };
      },
      async notify(completedJob) {
        notifiedJob = completedJob;
        return { status: "sent", messageId: "failed-email" };
      },
    }),
    /Deployment health check failed/
  );

  const savedJob = await findPipelineJobById(job.id);

  assert.equal(savedJob.status, "rolled_back");
  assert.equal(savedJob.failedStage, "health-check");
  assert.equal(savedJob.healthCheck.status, "unhealthy");
  assert.equal(savedJob.healthCheck.statusCode, 503);
  assert.equal(savedJob.rollback.status, "succeeded");
  assert.equal(
    savedJob.rollback.targetJobId,
    "11111111-1111-4111-8111-111111111111"
  );
  assert.equal(notifiedJob.status, "rolled_back");
});

test("persists rollback failure after an unhealthy deployment", async () => {
  const { stdout: firstCommitOutput } = await runGit(
    ["rev-list", "--max-parents=0", "HEAD"],
    sourceRepository
  );
  const job = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    deliveryId: "rollback-failure-delivery",
    repository: "test-owner/test-repo",
    branch: "main",
    commitSha: firstCommitOutput.trim(),
    status: "queued",
    createdAt: new Date().toISOString(),
  };
  const healthError = new Error("Deployment health check failed");
  healthError.healthResult = {
    status: "unhealthy",
    statusCode: 503,
    attempts: 3,
    durationMs: 10,
  };
  let notifiedJob;

  await savePipelineJob(job);

  await assert.rejects(
    schedulePipelineJob(job, [], {
      adapters: {
        local: {
          async deploy() {
            return {
              provider: "local",
              deploymentId: job.id,
              status: "deployed",
            };
          },
        },
      },
      async healthCheck() {
        throw healthError;
      },
      async rollback() {
        throw new Error("Expected rollback failure");
      },
      async notify(completedJob) {
        notifiedJob = completedJob;
        return { status: "sent", messageId: "rollback-failed-email" };
      },
    }),
    /Deployment health check failed/
  );

  const savedJob = await findPipelineJobById(job.id);

  assert.equal(savedJob.status, "rollback_failed");
  assert.equal(savedJob.failedStage, "rollback");
  assert.equal(savedJob.rollback.status, "failed");
  assert.equal(notifiedJob.status, "rollback_failed");
});
