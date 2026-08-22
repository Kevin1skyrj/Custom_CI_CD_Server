import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PIPELINE_DATA_DIR } from "../config/env.js";

const pipelineDataDirectory = path.resolve(PIPELINE_DATA_DIR);

function getDeliveryFile(deliveryId) {
  const deliveryKey = crypto
    .createHash("sha256")
    .update(deliveryId)
    .digest("hex");

  return path.join(
    pipelineDataDirectory,
    "deliveries",
    `${deliveryKey}.json`
  );
}

export async function savePipelineJob(job) {
  const jobDirectory = path.join(pipelineDataDirectory, job.id);
  const jobFile = path.join(jobDirectory, "job.json");

  await fs.mkdir(jobDirectory, { recursive: true });
  await fs.writeFile(
    jobFile,
    JSON.stringify(job, null, 2),
    "utf8"
  );

  return job;
}

export async function appendPipelineLog(jobId, message) {
  const jobDirectory = path.join(pipelineDataDirectory, jobId);
  const logFile = path.join(jobDirectory, "pipeline.log");
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;

  await fs.mkdir(jobDirectory, { recursive: true });
  await fs.appendFile(logFile, logEntry, "utf8");
}

export async function findPipelineJobById(jobId) {
  const jobFile = path.join(
    pipelineDataDirectory,
    jobId,
    "job.json"
  );

  try {
    const content = await fs.readFile(jobFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function readPipelineLog(jobId) {
  const logFile = path.join(
    pipelineDataDirectory,
    jobId,
    "pipeline.log"
  );

  try {
    return await fs.readFile(logFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function claimDelivery(deliveryId, jobId) {
  const deliveryFile = getDeliveryFile(deliveryId);

  await fs.mkdir(path.dirname(deliveryFile), {
    recursive: true,
  });

  try {
    await fs.writeFile(
      deliveryFile,
      JSON.stringify({ deliveryId, jobId }, null, 2),
      {
        encoding: "utf8",
        flag: "wx",
      }
    );

    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

export async function updatePipelineJob(jobId, updates) {
  const existingJob = await findPipelineJobById(jobId);

  if (!existingJob) {
    return null;
  }

  const updatedJob = {
    ...existingJob,
    ...updates,
  };

  await savePipelineJob(updatedJob);

  return updatedJob;
}

export async function deletePipelineJob(jobId) {
  const jobDirectory = path.join(pipelineDataDirectory, jobId);

  await fs.rm(jobDirectory, { recursive: true, force: true });
}

export async function findDeliveryClaim(deliveryId) {
  const deliveryFile = getDeliveryFile(deliveryId);

  try {
    const content = await fs.readFile(deliveryFile, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
