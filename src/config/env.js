export const PORT = Number(process.env.PORT ?? 3000);
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}
export const ALLOWED_REPOSITORY = process.env.ALLOWED_REPOSITORY;
export const ALLOWED_BRANCH = process.env.ALLOWED_BRANCH;
export const PIPELINE_DATA_DIR = process.env.PIPELINE_DATA_DIR;

if (!ALLOWED_REPOSITORY || !ALLOWED_BRANCH) {
  throw new Error("ALLOWED_REPOSITORY and ALLOWED_BRANCH are required");
}

if (!PIPELINE_DATA_DIR) {
  throw new Error("PIPELINE_DATA_DIR is required");
}
