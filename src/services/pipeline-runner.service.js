import {
  DEPLOYMENT_TYPE,
  PIPELINE_EXECUTION_ENABLED,
} from "../config/env.js";
import { deployToStaging } from "../deployments/deployment.service.js";
import {
  appendPipelineLog,
  updatePipelineJob,
} from "../repositories/pipeline.repository.js";
import { checkoutExactCommit } from "./checkout.service.js";
import { runPipelineStages } from "./pipeline-stages.service.js";
import { enqueueProjectTask } from "./project-queue.service.js";

export function schedulePipelineJob(job, components, adapters) {
  if (!PIPELINE_EXECUTION_ENABLED) {
    return Promise.resolve();
  }

  return enqueueProjectTask(job.repository, () =>
    runPipeline(job, components, adapters)
  );
}

async function runPipeline(job, components, adapters) {
  let currentStage = "checkout";

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
      adapters
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
            completedAt: new Date().toISOString(),
          }),
    });
    await appendPipelineLog(
      job.id,
      deploymentTriggered
        ? `${currentStage} accepted by provider`
        : `${currentStage} completed`
    );
  } catch (error) {
    currentStage = error.pipelineStage ?? currentStage;

    await updatePipelineJob(job.id, {
      status: "failed",
      failedAt: new Date().toISOString(),
      failedStage: currentStage,
      currentStage: null,
    });
    await appendPipelineLog(
      job.id,
      `Pipeline failed during ${currentStage}: ${error.message}`
    );

    throw error;
  }
}
