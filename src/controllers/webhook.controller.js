import { createPipelineJob } from "../services/pipeline.service.js";
import { schedulePipelineJob } from "../services/pipeline-runner.service.js";
export async function handleGithubWebhook(req, res) {
  const deliveryId = req.get("x-github-delivery");
  const commitSha = req.body.after;

  if (!deliveryId || !commitSha) {
    return res.status(400).json({
      message: "Delivery ID and commit SHA are required",
    });
  }

  try {
    const { job, duplicate } = await createPipelineJob(
      req.body,
      deliveryId
    );

    if (!duplicate) {
      void schedulePipelineJob(job).catch((error) => {
        console.error(`Pipeline job ${job.id} failed:`, error);
      });
    }

    return res.status(duplicate ? 200 : 202).json({
      message: duplicate
        ? "Pipeline job already queued"
        : "Pipeline job queued",
      jobId: job.id,
      duplicate,
    });
  } catch (error) {
    console.error("Failed to create pipeline job:", error);

    return res.status(500).json({
      message: "Failed to create pipeline job",
    });
  }
}
