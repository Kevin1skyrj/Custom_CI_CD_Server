import express from "express";

import webhookRoutes from "./routes/webhook.routes.js";
import pipelineRoutes from "./routes/pipeline.routes.js";

const app = express();

app.use("/webhook", webhookRoutes);
app.use("/pipeline-jobs", pipelineRoutes);

export default app;
