import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

import { PIPELINE_COMPONENTS } from "../config/pipeline.config.js";
import {
  appendPipelineLog,
  updatePipelineJob,
} from "../repositories/pipeline.repository.js";
import { runCommand } from "./command-runner.service.js";

function resolveComponentDirectory(workspace, directory) {
  const resolvedWorkspace = path.resolve(workspace);
  const componentDirectory = path.resolve(resolvedWorkspace, directory);
  const relativePath = path.relative(
    resolvedWorkspace,
    componentDirectory
  );

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Component directory escapes the job workspace");
  }

  return componentDirectory;
}

async function appendCommandOutput(jobId, result) {
  if (result.stdout) {
    await appendPipelineLog(jobId, `stdout:\n${result.stdout}`);
  }

  if (result.stderr) {
    await appendPipelineLog(jobId, `stderr:\n${result.stderr}`);
  }
}

async function loadStageEnvironment(envFile) {
  if (!envFile) {
    return {};
  }

  const content = await fs.readFile(path.resolve(envFile), "utf8");
  return parseEnv(content);
}

export async function runPipelineStages(
  job,
  workspace,
  components = PIPELINE_COMPONENTS
) {
  const stageResults = [];

  for (const component of components) {
    let componentDirectory;

    try {
      componentDirectory = resolveComponentDirectory(
        workspace,
        component.directory
      );

      const directoryStats = await fs.stat(componentDirectory);

      if (!directoryStats.isDirectory()) {
        throw new Error(`${component.name} is not a directory`);
      }
    } catch (error) {
      error.pipelineStage = `${component.name}:setup`;
      throw error;
    }

    for (const stage of component.stages) {
      const stageKey = `${component.name}:${stage.name}`;

      await updatePipelineJob(job.id, {
        status: stage.status,
        currentStage: stageKey,
      });
      await appendPipelineLog(job.id, `${stageKey} started`);

      try {
        const stageEnvironment = await loadStageEnvironment(stage.envFile);
        const result = await runCommand({
          command: stage.command,
          args: stage.args,
          cwd: componentDirectory,
          timeoutMs: stage.timeoutMs,
          env: stageEnvironment,
        });

        await appendCommandOutput(job.id, result);

        stageResults.push({
          stage: stageKey,
          status: "succeeded",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });

        await updatePipelineJob(job.id, { stageResults });
        await appendPipelineLog(
          job.id,
          `${stageKey} succeeded in ${result.durationMs}ms`
        );
      } catch (error) {
        if (error.result) {
          await appendCommandOutput(job.id, error.result);
        }

        stageResults.push({
          stage: stageKey,
          status: "failed",
          exitCode: error.result?.exitCode ?? null,
          durationMs: error.result?.durationMs ?? null,
        });
        await updatePipelineJob(job.id, { stageResults });

        error.pipelineStage = stageKey;
        throw error;
      }
    }
  }

  return stageResults;
}
