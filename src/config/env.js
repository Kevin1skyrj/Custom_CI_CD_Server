export const PORT = Number(process.env.PORT ?? 3000);
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}
export const ALLOWED_REPOSITORY = process.env.ALLOWED_REPOSITORY;
export const ALLOWED_BRANCH = process.env.ALLOWED_BRANCH;
export const PIPELINE_DATA_DIR = process.env.PIPELINE_DATA_DIR;
export const PIPELINE_WORKSPACE_DIR =
  process.env.PIPELINE_WORKSPACE_DIR;
export const REPOSITORY_CLONE_URL =
  process.env.REPOSITORY_CLONE_URL;
export const PIPELINE_EXECUTION_ENABLED =
  process.env.PIPELINE_EXECUTION_ENABLED !== "false";
export const DEPLOYMENT_TYPE = process.env.DEPLOYMENT_TYPE;
export const LOCAL_DEPLOY_DIR = process.env.LOCAL_DEPLOY_DIR;
export const DEPLOY_HOOK_URL = process.env.DEPLOY_HOOK_URL;
export const DEPLOY_HOOK_TIMEOUT_MS = Number(
  process.env.DEPLOY_HOOK_TIMEOUT_MS ?? 10000
);
export const SSH_HOST = process.env.SSH_HOST;
export const SSH_USER = process.env.SSH_USER;
export const SSH_PORT = Number(process.env.SSH_PORT ?? 22);
export const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
export const SSH_KNOWN_HOSTS_FILE = process.env.SSH_KNOWN_HOSTS_FILE;
export const SSH_REMOTE_DEPLOY_DIR = process.env.SSH_REMOTE_DEPLOY_DIR;
export const SSH_REMOTE_DEPLOY_SCRIPT =
  process.env.SSH_REMOTE_DEPLOY_SCRIPT;
export const SSH_TIMEOUT_MS = Number(
  process.env.SSH_TIMEOUT_MS ?? 5 * 60 * 1000
);
export const S3_BUCKET = process.env.S3_BUCKET;
export const S3_REGION = process.env.S3_REGION;
export const S3_BUILD_DIR = process.env.S3_BUILD_DIR;
export const S3_PREFIX = process.env.S3_PREFIX ?? "staging";
export const HEALTH_CHECK_URL = process.env.HEALTH_CHECK_URL;
export const HEALTH_CHECK_ATTEMPTS = Number(
  process.env.HEALTH_CHECK_ATTEMPTS ?? 5
);
export const HEALTH_CHECK_INTERVAL_MS = Number(
  process.env.HEALTH_CHECK_INTERVAL_MS ?? 5000
);
export const HEALTH_CHECK_TIMEOUT_MS = Number(
  process.env.HEALTH_CHECK_TIMEOUT_MS ?? 5000
);
export const EMAIL_NOTIFICATIONS_ENABLED =
  process.env.EMAIL_NOTIFICATIONS_ENABLED === "true";
export const SMTP_HOST = process.env.SMTP_HOST;
export const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
export const SMTP_SECURE = process.env.SMTP_SECURE === "true";
export const SMTP_USER = process.env.SMTP_USER;
export const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
export const EMAIL_FROM = process.env.EMAIL_FROM;
export const EMAIL_TO = process.env.EMAIL_TO;
export const ROLLBACK_ENABLED = process.env.ROLLBACK_ENABLED !== "false";
export const DEPLOY_HOOK_ROLLBACK_URL =
  process.env.DEPLOY_HOOK_ROLLBACK_URL;

const SUPPORTED_DEPLOYMENT_TYPES = new Set([
  "local",
  "ssh",
  "s3-static",
  "deploy-hook",
]);

if (!ALLOWED_REPOSITORY || !ALLOWED_BRANCH) {
  throw new Error("ALLOWED_REPOSITORY and ALLOWED_BRANCH are required");
}

if (
  !PIPELINE_DATA_DIR ||
  !PIPELINE_WORKSPACE_DIR ||
  !REPOSITORY_CLONE_URL
) {
  throw new Error(
    "PIPELINE_DATA_DIR, PIPELINE_WORKSPACE_DIR and REPOSITORY_CLONE_URL are required"
  );
}

if (
  DEPLOYMENT_TYPE === "ssh" &&
  (
    !SSH_HOST ||
    !SSH_USER ||
    !SSH_PRIVATE_KEY_PATH ||
    !SSH_KNOWN_HOSTS_FILE ||
    !SSH_REMOTE_DEPLOY_DIR ||
    !SSH_REMOTE_DEPLOY_SCRIPT
  )
) {
  throw new Error("SSH deployment configuration is incomplete");
}

if (!Number.isInteger(SSH_PORT) || SSH_PORT < 1 || SSH_PORT > 65535) {
  throw new Error("SSH_PORT must be a valid TCP port");
}

if (!Number.isFinite(SSH_TIMEOUT_MS) || SSH_TIMEOUT_MS <= 0) {
  throw new Error("SSH_TIMEOUT_MS must be a positive number");
}

if (
  DEPLOYMENT_TYPE === "s3-static" &&
  (!S3_BUCKET || !S3_REGION || !S3_BUILD_DIR)
) {
  throw new Error("S3 static deployment configuration is incomplete");
}

if (!HEALTH_CHECK_URL) {
  throw new Error("HEALTH_CHECK_URL is required");
}

if (
  !Number.isInteger(HEALTH_CHECK_ATTEMPTS) ||
  HEALTH_CHECK_ATTEMPTS < 1 ||
  !Number.isFinite(HEALTH_CHECK_INTERVAL_MS) ||
  HEALTH_CHECK_INTERVAL_MS < 0 ||
  !Number.isFinite(HEALTH_CHECK_TIMEOUT_MS) ||
  HEALTH_CHECK_TIMEOUT_MS <= 0
) {
  throw new Error("Health-check retry configuration is invalid");
}

if (
  EMAIL_NOTIFICATIONS_ENABLED &&
  (!SMTP_HOST || !EMAIL_FROM || !EMAIL_TO)
) {
  throw new Error("Email notification configuration is incomplete");
}

if (Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)) {
  throw new Error("SMTP_USER and SMTP_PASSWORD must be provided together");
}

if (!Number.isInteger(SMTP_PORT) || SMTP_PORT < 1 || SMTP_PORT > 65535) {
  throw new Error("SMTP_PORT must be a valid TCP port");
}

if (!SUPPORTED_DEPLOYMENT_TYPES.has(DEPLOYMENT_TYPE)) {
  throw new Error(
    "DEPLOYMENT_TYPE must be local, ssh, s3-static or deploy-hook"
  );
}

if (DEPLOYMENT_TYPE === "local" && !LOCAL_DEPLOY_DIR) {
  throw new Error("LOCAL_DEPLOY_DIR is required for local deployment");
}

if (DEPLOYMENT_TYPE === "deploy-hook" && !DEPLOY_HOOK_URL) {
  throw new Error(
    "DEPLOY_HOOK_URL is required for deploy-hook deployment"
  );
}

if (
  !Number.isFinite(DEPLOY_HOOK_TIMEOUT_MS) ||
  DEPLOY_HOOK_TIMEOUT_MS <= 0
) {
  throw new Error("DEPLOY_HOOK_TIMEOUT_MS must be a positive number");
}
