import {
  DEPLOYMENT_TYPE,
  PIPELINE_EXECUTION_ENABLED,
} from "../config/env.js";
import { deployToStaging } from "../deployments/deployment.service.js";
import {
  appendPipelineLog,
  findPipelineJobById,
  updatePipelineJob,
} from "../repositories/pipeline.repository.js";
import { checkoutExactCommit } from "./checkout.service.js";
import { checkDeploymentHealth } from "./health-check.service.js";
import { sendPipelineNotification } from "./notification.service.js";
import { runPipelineStages } from "./pipeline-stages.service.js";
import { enqueueProjectTask } from "./project-queue.service.js";

export function schedulePipelineJob(job, components, options = {}) {
  if (!PIPELINE_EXECUTION_ENABLED) {
    return Promise.resolve();
  }

  return enqueueProjectTask(job.repository, () =>
    runPipeline(job, components, options)
  );
}

async function runPipeline(job, components, options) {
  let currentStage = "checkout";
  let pipelineError;

  try {
    await updatePipelineJob(job.id, {
      status: "checking_out",
      startedAt: new Date().toISOString(),
    });
    await appendPipelineLog(job.id, "Exact commit checkout started");

    const workspace = await checkoutExactCommit(job);

    await updatePipelineJob(job.id, {
      status: "checked_out",
      checkedOutAt: new Date().toISOString(),
    });
    await appendPipelineLog(
      job.id,
      `Exact commit checkout completed: ${job.commitSha}`
    );

    await runPipelineStages(job, workspace, components);

    await updatePipelineJob(job.id, {
      status: "build_succeeded",
      currentStage: null,
      buildCompletedAt: new Date().toISOString(),
    });
    await appendPipelineLog(job.id, "Install, test and build stages passed");

    currentStage = `deployment:${DEPLOYMENT_TYPE}`;

    await updatePipelineJob(job.id, {
      status: "deploying",
      currentStage,
    });
    await appendPipelineLog(job.id, `${currentStage} started`);

    const deployment = await deployToStaging(
      { job, workspace },
      options.adapters
    );
    const deploymentTriggered = deployment.status === "triggered";

    await updatePipelineJob(job.id, {
      status: deploymentTriggered
        ? "deployment_triggered"
        : "staging_deployed",
      currentStage: null,
      deployment,
      ...(deploymentTriggered
        ? { deploymentTriggeredAt: new Date().toISOString() }
        : {
            deployedAt: new Date().toISOString(),
          }),
    });
    await appendPipelineLog(
      job.id,
      deploymentTriggered
        ? `${currentStage} accepted by provider`
        : `${currentStage} completed`
    );

    currentStage = "health-check";

    await updatePipelineJob(job.id, {
      status: "checking_health",
      currentStage,
    });
    await appendPipelineLog(job.id, "Deployment health check started");

    const healthCheck = await (options.healthCheck ??
      checkDeploymentHealth)();

    await updatePipelineJob(job.id, {
      status: "succeeded",
      currentStage: null,
      healthCheck,
      completedAt: new Date().toISOString(),
    });
    await appendPipelineLog(
      job.id,
      `Deployment is healthy after ${healthCheck.attempts} attempt(s)`
    );
  } catch (error) {
    currentStage = error.pipelineStage ?? currentStage;

    await updatePipelineJob(job.id, {
      status: "failed",
      failedAt: new Date().toISOString(),
      failedStage: currentStage,
      currentStage: null,
      ...(error.healthResult
        ? { healthCheck: error.healthResult }
        : {}),
    });
    await appendPipelineLog(
      job.id,
      `Pipeline failed during ${currentStage}: ${error.message}`
    );

    pipelineError = error;
  }

  const completedJob = await findPipelineJobById(job.id);

  try {
    const notification = await (options.notify ??
      sendPipelineNotification)(completedJob);

    if (notification.status === "sent") {
      await appendPipelineLog(job.id, "Email notification sent");
    }
  } catch {
    await appendPipelineLog(
      job.id,
      "Email notification failed; pipeline result was not changed"
    );
  }

  if (pipelineError) {
    throw pipelineError;
  }
}
