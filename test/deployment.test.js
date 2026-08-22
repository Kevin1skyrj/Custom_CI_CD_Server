import assert from "node:assert/strict";
import { test } from "node:test";

process.env.GITHUB_WEBHOOK_SECRET = "deployment-test-secret";
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
process.env.PIPELINE_DATA_DIR = "./test-data/deployment-jobs";
process.env.PIPELINE_WORKSPACE_DIR = "./test-data/deployment-workspaces";
process.env.REPOSITORY_CLONE_URL = "test-repository";
process.env.PIPELINE_EXECUTION_ENABLED = "false";
process.env.DEPLOYMENT_TYPE = "local";

const { deployToStaging } = await import(
  "../src/deployments/deployment.service.js"
);

test("selects the configured deployment adapter", async () => {
  const context = {
    job: { id: "test-job" },
    workspace: "test-workspace",
  };
  let receivedContext;

  const result = await deployToStaging(context, {
    local: {
      async deploy(adapterContext) {
        receivedContext = adapterContext;

        return {
          provider: "local",
          deploymentId: "local-test-job",
        };
      },
    },
  });

  assert.equal(receivedContext, context);
  assert.equal(result.provider, "local");
  assert.equal(result.deploymentId, "local-test-job");
});

test("rejects a missing configured adapter", async () => {
  await assert.rejects(
    deployToStaging({}, {}),
    /Deployment adapter is unavailable: local/
  );
});

test("rejects an invalid adapter result", async () => {
  await assert.rejects(
    deployToStaging({}, { local: { async deploy() {} } }),
    /Deployment adapter must return a result object/
  );
});
