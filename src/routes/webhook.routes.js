import { Router, raw } from "express";

import { handleGithubWebhook } from "../controllers/webhook.controller.js";
import { verifyGithubSignature } from "../middlewares/verifyGithubSignature.js";

const router = Router();

router.post(
  "/github",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  handleGithubWebhook
);

export default router;
