import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  PIPELINE_WORKSPACE_DIR,
  REPOSITORY_CLONE_URL,
} from "../config/env.js";

const execFileAsync = promisify(execFile);
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

async function runGit(stage, args, workingDirectory) {
  try {
    return await execFileAsync("git", args, {
      cwd: workingDirectory,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(`Git ${stage} failed`);
  }
}

export async function checkoutExactCommit(job) {
  if (!COMMIT_SHA_PATTERN.test(job.commitSha)) {
    throw new Error("Commit SHA must contain 40 hexadecimal characters");
  }

  const workspaceRoot = path.resolve(PIPELINE_WORKSPACE_DIR);
  const jobWorkspace = path.join(workspaceRoot, job.id);

  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(jobWorkspace);

  await runGit("initialization", ["init"], jobWorkspace);
  await runGit(
    "remote configuration",
    ["remote", "add", "origin", REPOSITORY_CLONE_URL],
    jobWorkspace
  );
  await runGit(
    "fetch",
    ["fetch", "--depth=1", "origin", job.commitSha],
    jobWorkspace
  );
  await runGit(
    "checkout",
    ["checkout", "--detach", "FETCH_HEAD"],
    jobWorkspace
  );

  const { stdout } = await runGit(
    "verification",
    ["rev-parse", "HEAD"],
    jobWorkspace
  );
  const checkedOutCommit = stdout.trim();

  if (checkedOutCommit !== job.commitSha.toLowerCase()) {
    throw new Error("Checked-out commit does not match requested commit");
  }

  return jobWorkspace;
}
