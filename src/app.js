import express from "express";

import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

app.use("/webhook", webhookRoutes);

export default app;
