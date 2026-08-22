import { Router, raw } from "express";

import { handleGithubWebhook } from "../controllers/webhook.controller.js";
import { verifyGithubSignature } from "../middlewares/verifyGithubSignature.js";
import { validateGithubWebhook } from "../middlewares/validateGithubWebhook.js";
const router = Router();

router.post(
  "/github",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  validateGithubWebhook,
  handleGithubWebhook
);

export default router;
