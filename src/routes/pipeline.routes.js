import { Router } from "express";

import { getPipelineJob } from "../controllers/pipeline.controller.js";

const router = Router();

router.get("/:jobId", getPipelineJob);

export default router;
