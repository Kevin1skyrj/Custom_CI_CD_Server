import { getPipelineJobDetails } from "../services/pipeline.service.js";

export async function getPipelineJob(req, res) {
  try {
    const job = await getPipelineJobDetails(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        message: "Pipeline job not found",
      });
    }

    return res.status(200).json({ job });
  } catch (error) {
    console.error("Failed to read pipeline job:", error);

    return res.status(500).json({
      message: "Failed to read pipeline job",
    });
  }
}
