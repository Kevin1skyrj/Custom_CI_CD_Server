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
