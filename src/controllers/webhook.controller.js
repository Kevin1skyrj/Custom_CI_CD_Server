import { createPipelineJob } from "../services/pipeline.service.js";
export async function handleGithubWebhook(req, res) {
  const deliveryId = req.get("x-github-delivery");
  const commitSha = req.body.after;

  if (!deliveryId || !commitSha) {
    return res.status(400).json({
      message: "Delivery ID and commit SHA are required",
    });
  }

  try {
    const job = await createPipelineJob(req.body, deliveryId);

    return res.status(202).json({
      message: "Pipeline job queued",
      jobId: job.id,
    });
  } catch (error) {
    console.error("Failed to create pipeline job:", error);

    return res.status(500).json({
      message: "Failed to create pipeline job",
    });
  }
}
