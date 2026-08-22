import {
  DEPLOY_HOOK_TIMEOUT_MS,
  DEPLOY_HOOK_ROLLBACK_URL,
  DEPLOY_HOOK_URL,
} from "../../config/env.js";

export async function deploy({ job }) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEPLOY_HOOK_TIMEOUT_MS
  );

  try {
    const response = await fetch(DEPLOY_HOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jobId: job.id,
        repository: job.repository,
        branch: job.branch,
        commitSha: job.commitSha,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Deploy hook returned HTTP ${response.status}`
      );
    }

    const responseText = await response.text();
    let responseBody = {};

    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = {};
      }
    }

    return {
      provider: "deploy-hook",
      deploymentId:
        responseBody.id ?? responseBody.job?.id ?? null,
      status: "triggered",
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Deploy hook request timed out");
    }

    if (error.message.startsWith("Deploy hook returned HTTP")) {
      throw error;
    }

    throw new Error("Deploy hook request failed");
  } finally {
    clearTimeout(timeout);
  }
}

export async function rollback({ job, previousRelease }) {
  if (!DEPLOY_HOOK_ROLLBACK_URL) {
    throw new Error("Deploy-hook rollback URL is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DEPLOY_HOOK_TIMEOUT_MS
  );

  try {
    const response = await fetch(DEPLOY_HOOK_ROLLBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        failedJobId: job.id,
        previousJobId: previousRelease.jobId,
        previousCommitSha: previousRelease.commitSha,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Rollback hook returned HTTP ${response.status}`
      );
    }

    return {
      provider: "deploy-hook",
      deploymentId: previousRelease.jobId,
      status: "rollback_triggered",
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Rollback hook request timed out");
    }

    if (error.message.startsWith("Rollback hook returned HTTP")) {
      throw error;
    }

    throw new Error("Rollback hook request failed");
  } finally {
    clearTimeout(timeout);
  }
}
