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

const {
  appendPipelineLog,
  findPipelineJobById,
  readPipelineLog,
  savePipelineJob,
} = await import("../src/repositories/pipeline.repository.js");
const { schedulePipelineJob } = await import(
  "../src/services/pipeline-runner.service.js"
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
  await schedulePipelineJob(job);

  const workspace = path.join(workspaceDirectory, job.id);
  const checkedOutContent = await fs.readFile(
    path.join(workspace, "version.txt"),
    "utf8"
  );
  const savedJob = await findPipelineJobById(job.id);
  const savedLog = await readPipelineLog(job.id);

  assert.equal(checkedOutContent, "first version");
  assert.equal(savedJob.status, "build_succeeded");
  assert.ok(savedJob.startedAt);
  assert.ok(savedJob.checkedOutAt);
  assert.ok(savedJob.completedAt);
  assert.equal(savedJob.stageResults.length, 4);
  assert.equal(
    await fs.readFile(path.join(workspace, "client", "built.txt"), "utf8"),
    "built"
  );
  assert.match(savedLog, /Exact commit checkout started/);
  assert.match(savedLog, new RegExp(firstCommit));
  assert.match(savedLog, /client:test succeeded/);
  assert.match(savedLog, /client:build succeeded/);
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
