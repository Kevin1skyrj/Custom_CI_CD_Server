import { DEPLOYMENT_TYPE } from "../config/env.js";
import * as localAdapter from "./adapters/local.adapter.js";
import * as deployHookAdapter from "./adapters/deploy-hook.adapter.js";

const defaultAdapters = {
  local: localAdapter,
  "deploy-hook": deployHookAdapter,
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
