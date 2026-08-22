import crypto from "node:crypto";

import {
  appendPipelineLog,
  findPipelineJobById,
  readPipelineLog,
  savePipelineJob,
} from "../repositories/pipeline.repository.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createPipelineJob(payload, deliveryId) {
  const job = {
    id: crypto.randomUUID(),
    deliveryId,
    repository: payload.repository.full_name,
    branch: payload.ref.slice("refs/heads/".length),
    commitSha: payload.after,
    status: "queued",
    createdAt: new Date().toISOString(),
  };

  await savePipelineJob(job);
  await appendPipelineLog(job.id, "Pipeline job created and queued");

  return job;
}

export async function getPipelineJobDetails(jobId) {
  if (!UUID_V4_PATTERN.test(jobId)) {
    return null;
  }

  const job = await findPipelineJobById(jobId);

  if (!job) {
    return null;
  }

  const log = await readPipelineLog(jobId);

  return {
    ...job,
    log: log ?? "",
  };
}
