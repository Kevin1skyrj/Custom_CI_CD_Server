import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PIPELINE_DATA_DIR } from "../config/env.js";

const releasesDirectory = path.resolve(PIPELINE_DATA_DIR, "releases");

function getReleaseFile(repository) {
  const repositoryKey = crypto
    .createHash("sha256")
    .update(repository)
    .digest("hex");

  return path.join(releasesDirectory, `${repositoryKey}.json`);
}

export async function findCurrentHealthyRelease(repository) {
  try {
    const content = await fs.readFile(getReleaseFile(repository), "utf8");
    return JSON.parse(content).current ?? null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function saveHealthyRelease(release) {
  const releaseFile = getReleaseFile(release.repository);
  let history = [];

  try {
    const content = await fs.readFile(releaseFile, "utf8");
    history = JSON.parse(content).history ?? [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const releaseIndex = {
    current: release,
    history: [release, ...history].slice(0, 20),
  };

  await fs.mkdir(releasesDirectory, { recursive: true });
  await fs.writeFile(
    releaseFile,
    JSON.stringify(releaseIndex, null, 2),
    "utf8"
  );

  return release;
}
