import fs from "node:fs/promises";
import path from "node:path";

import { PIPELINE_DATA_DIR } from "../config/env.js";

const pipelineDataDirectory = path.resolve(PIPELINE_DATA_DIR);

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