import {
  ALLOWED_BRANCH,
  ALLOWED_REPOSITORY,
} from "../config/env.js";

export function validateGithubWebhook(req, res, next) {
  const event = req.get("x-github-event");

  if (event !== "push") {
    return res.status(202).json({ message: "Event ignored" });
  }

  let payload;

  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ message: "Invalid JSON payload" });
  }

  if (payload.repository?.full_name !== ALLOWED_REPOSITORY) {
    return res.status(403).json({ message: "Repository not allowed" });
  }

  if (payload.ref !== `refs/heads/${ALLOWED_BRANCH}`) {
    return res.status(202).json({ message: "Branch ignored" });
  }

  req.body = payload;
  return next();
}