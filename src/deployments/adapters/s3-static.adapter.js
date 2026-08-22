import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  S3_BUCKET,
  S3_BUILD_DIR,
  S3_PREFIX,
  S3_REGION,
} from "../../config/env.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveBuildDirectory(workspace) {
  if (path.isAbsolute(S3_BUILD_DIR)) {
    throw new Error("S3_BUILD_DIR must be relative to the workspace");
  }

  const resolvedWorkspace = path.resolve(workspace);
  const buildDirectory = path.resolve(resolvedWorkspace, S3_BUILD_DIR);
  const relativePath = path.relative(resolvedWorkspace, buildDirectory);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("S3 build directory escapes the workspace");
  }

  return buildDirectory;
}

function validateConfiguration(job) {
  if (!UUID_V4_PATTERN.test(job.id)) {
    throw new Error("S3 deployment requires a valid job ID");
  }

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(S3_BUCKET)) {
    throw new Error("S3_BUCKET is not a valid bucket name");
  }

  if (
    S3_PREFIX.includes("..") ||
    S3_PREFIX.includes("\\") ||
    S3_PREFIX.startsWith("/")
  ) {
    throw new Error("S3_PREFIX contains unsupported path segments");
  }
}

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error("S3 build directory cannot contain symbolic links");
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function createObjectKey(jobId, buildDirectory, file) {
  const relativeFile = path
    .relative(buildDirectory, file)
    .split(path.sep)
    .join("/");

  return [S3_PREFIX, jobId, relativeFile].filter(Boolean).join("/");
}

export async function deploy({ job, workspace }, options = {}) {
  validateConfiguration(job);

  const buildDirectory = resolveBuildDirectory(workspace);
  const buildStats = await fs.stat(buildDirectory);

  if (!buildStats.isDirectory()) {
    throw new Error("S3 build source must be a directory");
  }

  const files = await collectFiles(buildDirectory);

  if (files.length === 0) {
    throw new Error("S3 build directory is empty");
  }

  const s3Client = options.s3Client ?? new S3Client({ region: S3_REGION });

  for (const file of files) {
    const fileStats = await fs.stat(file);
    const objectKey = createObjectKey(job.id, buildDirectory, file);
    const contentType =
      CONTENT_TYPES.get(path.extname(file).toLowerCase()) ??
      "application/octet-stream";

    await s3Client.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        Body: createReadStream(file),
        ContentLength: fileStats.size,
        ContentType: contentType,
        CacheControl: "no-cache",
      })
    );
  }

  const deploymentPrefix = [S3_PREFIX, job.id]
    .filter(Boolean)
    .join("/");

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: [S3_PREFIX, "current.json"].filter(Boolean).join("/"),
      Body: JSON.stringify({ jobId: job.id, deploymentPrefix }),
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );

  return {
    provider: "s3-static",
    deploymentId: job.id,
    deploymentPrefix,
    uploadedFiles: files.length,
    status: "deployed",
  };
}

export async function rollback({ previousRelease }, options = {}) {
  const previousJobId = previousRelease?.jobId;

  if (!UUID_V4_PATTERN.test(previousJobId)) {
    throw new Error("S3 rollback requires a previous healthy release");
  }

  const s3Client = options.s3Client ?? new S3Client({ region: S3_REGION });
  const deploymentPrefix = [S3_PREFIX, previousJobId]
    .filter(Boolean)
    .join("/");

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: [S3_PREFIX, "current.json"].filter(Boolean).join("/"),
      Body: JSON.stringify({
        jobId: previousJobId,
        deploymentPrefix,
      }),
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store",
    })
  );

  return {
    provider: "s3-static",
    deploymentId: previousJobId,
    deploymentPrefix,
    status: "rolled_back",
  };
}
