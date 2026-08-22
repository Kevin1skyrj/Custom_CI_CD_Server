import { PIPELINE_EXECUTION_ENABLED } from "../config/env.js";
import {
  appendPipelineLog,
  updatePipelineJob,
} from "../repositories/pipeline.repository.js";
import { checkoutExactCommit } from "./checkout.service.js";
import { enqueueProjectTask } from "./project-queue.service.js";

export function schedulePipelineJob(job) {
  if (!PIPELINE_EXECUTION_ENABLED) {
    return Promise.resolve();
  }

  return enqueueProjectTask(job.repository, () => runCheckoutStage(job));
}

async function runCheckoutStage(job) {
  try {
    await updatePipelineJob(job.id, {
      status: "checking_out",
      startedAt: new Date().toISOString(),
    });
    await appendPipelineLog(job.id, "Exact commit checkout started");

    await checkoutExactCommit(job);

    await updatePipelineJob(job.id, {
      status: "checked_out",
      checkedOutAt: new Date().toISOString(),
    });
    await appendPipelineLog(
      job.id,
      `Exact commit checkout completed: ${job.commitSha}`
    );
  } catch (error) {
    await updatePipelineJob(job.id, {
      status: "failed",
      failedAt: new Date().toISOString(),
      failedStage: "checkout",
    });
    await appendPipelineLog(
      job.id,
      `Exact commit checkout failed: ${error.message}`
    );

    throw error;
  }
}
