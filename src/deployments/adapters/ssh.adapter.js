import fs from "node:fs/promises";
import path from "node:path";

import {
  SSH_HOST,
  SSH_KNOWN_HOSTS_FILE,
  SSH_PORT,
  SSH_PRIVATE_KEY_PATH,
  SSH_REMOTE_DEPLOY_DIR,
  SSH_REMOTE_DEPLOY_SCRIPT,
  SSH_TIMEOUT_MS,
  SSH_USER,
} from "../../config/env.js";
import { runCommand } from "../../services/command-runner.service.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SSH_USER_PATTERN = /^[a-z_][a-z0-9_-]*$/i;
const SSH_HOST_PATTERN = /^[a-z0-9.-]+$/i;
const REMOTE_PATH_PATTERN = /^\/[a-z0-9._/-]+$/i;

function validateConfiguration(job) {
  if (!UUID_V4_PATTERN.test(job.id)) {
    throw new Error("SSH deployment requires a valid job ID");
  }

  if (!COMMIT_SHA_PATTERN.test(job.commitSha)) {
    throw new Error("SSH deployment requires a valid commit SHA");
  }

  if (!SSH_USER_PATTERN.test(SSH_USER)) {
    throw new Error("SSH_USER contains unsupported characters");
  }

  if (!SSH_HOST_PATTERN.test(SSH_HOST)) {
    throw new Error("SSH_HOST contains unsupported characters");
  }

  if (
    !REMOTE_PATH_PATTERN.test(SSH_REMOTE_DEPLOY_DIR) ||
    !REMOTE_PATH_PATTERN.test(SSH_REMOTE_DEPLOY_SCRIPT)
  ) {
    throw new Error("SSH remote paths must be safe absolute paths");
  }
}

function createSshOptions() {
  return [
    "-i",
    path.resolve(SSH_PRIVATE_KEY_PATH),
    "-p",
    String(SSH_PORT),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${path.resolve(SSH_KNOWN_HOSTS_FILE)}`,
  ];
}

export async function deploy({ job, workspace }, execute = runCommand) {
  validateConfiguration(job);

  const sourceDirectory = path.resolve(workspace);
  const sourceStats = await fs.stat(sourceDirectory);

  if (!sourceStats.isDirectory()) {
    throw new Error("SSH deployment source must be a directory");
  }

  await fs.access(path.resolve(SSH_PRIVATE_KEY_PATH));
  await fs.access(path.resolve(SSH_KNOWN_HOSTS_FILE));

  const sshTarget = `${SSH_USER}@${SSH_HOST}`;
  const remoteReleaseDirectory = path.posix.join(
    SSH_REMOTE_DEPLOY_DIR,
    job.id
  );
  const sshOptions = createSshOptions();

  await execute({
    command: "ssh",
    args: [
      ...sshOptions,
      sshTarget,
      SSH_REMOTE_DEPLOY_SCRIPT,
      "prepare",
      job.id,
    ],
    cwd: sourceDirectory,
    timeoutMs: SSH_TIMEOUT_MS,
  });

  const scpOptions = [...sshOptions];
  scpOptions[scpOptions.indexOf("-p")] = "-P";

  await execute({
    command: "scp",
    args: [
      ...scpOptions,
      "-r",
      `${sourceDirectory}${path.sep}.`,
      `${sshTarget}:${remoteReleaseDirectory}`,
    ],
    cwd: sourceDirectory,
    timeoutMs: SSH_TIMEOUT_MS,
  });

  await execute({
    command: "ssh",
    args: [
      ...sshOptions,
      sshTarget,
      SSH_REMOTE_DEPLOY_SCRIPT,
      "activate",
      job.id,
      job.commitSha,
    ],
    cwd: sourceDirectory,
    timeoutMs: SSH_TIMEOUT_MS,
  });

  return {
    provider: "ssh",
    deploymentId: job.id,
    status: "deployed",
  };
}

export async function rollback(
  { job, previousRelease, workspace },
  execute = runCommand
) {
  validateConfiguration(job);

  if (!UUID_V4_PATTERN.test(previousRelease?.jobId)) {
    throw new Error("SSH rollback requires a previous healthy release");
  }

  const sourceDirectory = path.resolve(workspace);
  const sshTarget = `${SSH_USER}@${SSH_HOST}`;

  await execute({
    command: "ssh",
    args: [
      ...createSshOptions(),
      sshTarget,
      SSH_REMOTE_DEPLOY_SCRIPT,
      "rollback",
      job.id,
      previousRelease.jobId,
    ],
    cwd: sourceDirectory,
    timeoutMs: SSH_TIMEOUT_MS,
  });

  return {
    provider: "ssh",
    deploymentId: previousRelease.jobId,
    status: "rolled_back",
  };
}
