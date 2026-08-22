import nodemailer from "nodemailer";

import {
  EMAIL_FROM,
  EMAIL_NOTIFICATIONS_ENABLED,
  EMAIL_TO,
  SMTP_HOST,
  SMTP_PASSWORD,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
} from "../config/env.js";

function createTransporter() {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth:
      SMTP_USER && SMTP_PASSWORD
        ? { user: SMTP_USER, pass: SMTP_PASSWORD }
        : undefined,
    connectionTimeout: 10000,
    socketTimeout: 10000,
  });
}

function createMessage(job) {
  const successful = job.status === "succeeded";
  const subject = successful
    ? `[CI/CD] Deployment succeeded: ${job.repository}`
    : `[CI/CD] Pipeline failed: ${job.repository}`;
  const lines = [
    `Status: ${job.status}`,
    `Repository: ${job.repository}`,
    `Branch: ${job.branch}`,
    `Commit: ${job.commitSha}`,
    `Job ID: ${job.id}`,
  ];

  if (job.failedStage) {
    lines.push(`Failed stage: ${job.failedStage}`);
  }

  if (job.healthCheck) {
    lines.push(`Health: ${job.healthCheck.status}`);
    lines.push(`Health attempts: ${job.healthCheck.attempts}`);
  }

  if (job.rollback) {
    lines.push(`Rollback: ${job.rollback.status}`);

    if (job.rollback.targetJobId) {
      lines.push(`Rollback target: ${job.rollback.targetJobId}`);
    }
  }

  return { subject, text: lines.join("\n") };
}

export async function sendPipelineNotification(job, options = {}) {
  if (!EMAIL_NOTIFICATIONS_ENABLED) {
    return { status: "disabled" };
  }

  const transporter = options.transporter ?? createTransporter();
  const message = createMessage(job);
  const info = await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: message.subject,
    text: message.text,
  });

  return {
    status: "sent",
    messageId: info.messageId ?? null,
  };
}
