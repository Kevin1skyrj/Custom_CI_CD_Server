import fs from "node:fs/promises";
import path from "node:path";

import { LOCAL_DEPLOY_DIR } from "../../config/env.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isInside(parentDirectory, childDirectory) {
  const relativePath = path.relative(parentDirectory, childDirectory);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export async function deploy({ job, workspace }) {
  if (!UUID_V4_PATTERN.test(job.id)) {
    throw new Error("Local deployment requires a valid job ID");
  }

  const sourceDirectory = path.resolve(workspace);
  const deploymentRoot = path.resolve(LOCAL_DEPLOY_DIR);
  const deploymentDirectory = path.join(deploymentRoot, job.id);
  const sourceStats = await fs.stat(sourceDirectory);

  if (!sourceStats.isDirectory()) {
    throw new Error("Local deployment source must be a directory");
  }

  if (isInside(sourceDirectory, deploymentDirectory)) {
    throw new Error("Local deployment target cannot be inside the workspace");
  }

  await fs.mkdir(deploymentRoot, { recursive: true });

  try {
    await fs.access(deploymentDirectory);
    throw new Error("Local deployment target already exists");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.cp(sourceDirectory, deploymentDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => path.basename(source) !== ".git",
  });

  return {
    provider: "local",
    deploymentId: job.id,
    deploymentPath: deploymentDirectory,
    status: "deployed",
  };
}
