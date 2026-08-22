import { DEPLOYMENT_TYPE } from "../config/env.js";
import * as localAdapter from "./adapters/local.adapter.js";
import * as deployHookAdapter from "./adapters/deploy-hook.adapter.js";
import * as sshAdapter from "./adapters/ssh.adapter.js";
import * as s3StaticAdapter from "./adapters/s3-static.adapter.js";

const defaultAdapters = {
  local: localAdapter,
  "deploy-hook": deployHookAdapter,
  ssh: sshAdapter,
  "s3-static": s3StaticAdapter,
};

function validateDeploymentResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Deployment adapter must return a result object");
  }

  if (!result.provider) {
    throw new Error("Deployment result must include a provider");
  }
}

export async function deployToStaging(
  context,
  adapters = defaultAdapters
) {
  const adapter = adapters[DEPLOYMENT_TYPE];

  if (!adapter || typeof adapter.deploy !== "function") {
    throw new Error(
      `Deployment adapter is unavailable: ${DEPLOYMENT_TYPE}`
    );
  }

  const result = await adapter.deploy(context);

  validateDeploymentResult(result);

  return result;
}

export async function rollbackStaging(context, adapters = defaultAdapters) {
  const adapter = adapters[DEPLOYMENT_TYPE];

  if (!adapter || typeof adapter.rollback !== "function") {
    throw new Error(
      `Rollback is unsupported for deployment type: ${DEPLOYMENT_TYPE}`
    );
  }

  const result = await adapter.rollback(context);

  validateDeploymentResult(result);

  return result;
}
