import {
  HEALTH_CHECK_ATTEMPTS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_CHECK_URL,
} from "../config/env.js";

function wait(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function checkDeploymentHealth(options = {}) {
  const request = options.fetchImpl ?? fetch;
  const pause = options.waitImpl ?? wait;
  const startedAt = Date.now();
  let lastStatusCode = null;

  for (let attempt = 1; attempt <= HEALTH_CHECK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      HEALTH_CHECK_TIMEOUT_MS
    );

    try {
      const response = await request(HEALTH_CHECK_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      lastStatusCode = response.status;

      if (response.ok) {
        return {
          status: "healthy",
          statusCode: response.status,
          attempts: attempt,
          durationMs: Date.now() - startedAt,
        };
      }
    } catch {
      lastStatusCode = null;
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < HEALTH_CHECK_ATTEMPTS) {
      await pause(HEALTH_CHECK_INTERVAL_MS);
    }
  }

  const error = new Error("Deployment health check failed");
  error.healthResult = {
    status: "unhealthy",
    statusCode: lastStatusCode,
    attempts: HEALTH_CHECK_ATTEMPTS,
    durationMs: Date.now() - startedAt,
  };

  throw error;
}
