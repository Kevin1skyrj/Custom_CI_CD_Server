import crypto from "node:crypto";
import express from "express";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}
function createExpectedSignature(rawBody) {
  const digest = crypto
    .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return `sha256=${digest}`;
}

function signaturesMatch(expectedSignature, receivedSignature){
  const expected = Buffer.from(expectedSignature);
  const recieved = Buffer.from(receivedSignature ?? "");
  return(
    expected.length === revieved.length && crypto.timingSafeEqual(expected, revieved)
  );
}
// route
app.post(
  "/webhook/github",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const receivedSignature = req.get("x-hub-signature-256");
    const expectedSignature = createExpectedSignature(req.body);

    if (!signaturesMatch(expectedSignature, receivedSignature)) {
      return res.status(401).json({ message: "Invalid signature" });
    }

    return res.status(200).json({ message: "Webhook verified" });
  }
);

app.listen(PORT, () => {
  console.log(`CI/CD server listening on port ${PORT}`);
});
