import fs from "node:fs/promises";
import path from "node:path";

import { PIPELINE_WORKSPACE_DIR } from "../config/env.js";

export async function removePipelineWorkspace(jobId) {
  const workspaceRoot = path.resolve(PIPELINE_WORKSPACE_DIR);
  const jobWorkspace = path.resolve(workspaceRoot, jobId);

  if (path.dirname(jobWorkspace) !== workspaceRoot) {
    throw new Error("Workspace cleanup target escapes the workspace directory");
  }

  await fs.rm(jobWorkspace, { recursive: true, force: true });
}
