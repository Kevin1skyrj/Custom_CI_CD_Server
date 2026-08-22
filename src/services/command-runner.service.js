import { spawn } from "node:child_process";

const MAX_CAPTURED_OUTPUT_LENGTH = 1024 * 1024;

function captureOutput(currentOutput, chunk) {
  if (currentOutput.length >= MAX_CAPTURED_OUTPUT_LENGTH) {
    return currentOutput;
  }

  return (currentOutput + chunk.toString()).slice(
    0,
    MAX_CAPTURED_OUTPUT_LENGTH
  );
}

function redactSecrets(output) {
  let redactedOutput = output;

  for (const [name, value] of Object.entries(process.env)) {
    if (
      /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY/i.test(name) &&
      value &&
      value.length >= 4
    ) {
      redactedOutput = redactedOutput.replaceAll(value, "[REDACTED]");
    }
  }

  return redactedOutput.trim();
}

export function runCommand({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = captureOutput(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = captureOutput(stderr, chunk);
    });

    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Stage command could not be started"));
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);

      const result = {
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
      };

      if (timedOut) {
        const error = new Error("Stage command timed out");
        error.result = result;
        reject(error);
        return;
      }

      if (exitCode !== 0) {
        const error = new Error(`Stage command exited with code ${exitCode}`);
        error.result = result;
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}
