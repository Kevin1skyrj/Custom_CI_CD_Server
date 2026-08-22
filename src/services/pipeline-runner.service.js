import { PIPELINE_EXECUTION_ENABLED } from "../config/env.js";
import {
  appendPipelineLog,
  updatePipelineJob,
} from "../repositories/pipeline.repository.js";
import { checkoutExactCommit } from "./checkout.service.js";
import { runPipelineStages } from "./pipeline-stages.service.js";
import { enqueueProjectTask } from "./project-queue.service.js";

export function schedulePipelineJob(job, components) {
  if (!PIPELINE_EXECUTION_ENABLED) {
    return Promise.resolve();
  }

  return enqueueProjectTask(job.repository, () =>
    runPipeline(job, components)
  );
}

async function runPipeline(job, components) {
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
      completedAt: new Date().toISOString(),
    });
    await appendPipelineLog(job.id, "Install, test and build stages passed");
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
