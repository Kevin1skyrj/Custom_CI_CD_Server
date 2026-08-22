export function handleGithubWebhook(_req, res) {
  return res.status(200).json({ message: "Webhook verified" });
}
