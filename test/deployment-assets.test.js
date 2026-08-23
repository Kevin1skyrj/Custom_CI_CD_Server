import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";

const deploymentScript = await fs.readFile(
  new URL("../deploy/datadock/cicd-deploy", import.meta.url),
  "utf8"
);
const ecosystemConfig = await fs.readFile(
  new URL(
    "../deploy/datadock/datadock.ecosystem.config.cjs",
    import.meta.url
  ),
  "utf8"
);

test("DataDock deployment script uses strict and validated releases", () => {
  assert.match(deploymentScript, /set -Eeuo pipefail/);
  assert.match(deploymentScript, /validate_job_id/);
  assert.match(deploymentScript, /validate_commit_sha/);
  assert.match(deploymentScript, /mv -Tf/);
  assert.match(deploymentScript, /startOrReload/);
  assert.match(
    deploymentScript,
    /sudo -u ubuntu "\$PM2_BIN" startOrReload/
  );
  assert.match(deploymentScript, /sudo -u ubuntu "\$PM2_BIN" save/);
  assert.match(deploymentScript, /prepare\)/);
  assert.match(deploymentScript, /activate\)/);
  assert.match(deploymentScript, /rollback\)/);
  assert.doesNotMatch(deploymentScript, /StrictHostKeyChecking=no/);
});

test("DataDock PM2 configuration uses the current release link", () => {
  assert.match(
    ecosystemConfig,
    /\/var\/www\/datadock-deploy\/current\/server/
  );
  assert.match(
    ecosystemConfig,
    /\/var\/www\/datadock-deploy\/current\/client/
  );
  assert.match(ecosystemConfig, /datadock-server/);
  assert.match(ecosystemConfig, /datadock-client/);
});
