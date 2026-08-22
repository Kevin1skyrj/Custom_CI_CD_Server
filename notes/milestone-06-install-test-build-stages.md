# Milestone 6: Install, Test, and Build Stages

## Goal

Execute trusted install, test, and build commands inside the exact-commit workspace created by Milestone 5. Persist stage progress, sanitized output, durations, exit codes, and failures while stopping immediately when a stage fails.

## DataDock pipeline

The configuration matches DataDock's actual repository structure and package scripts:

```text
server/
  install: npm ci
  test:    not configured because no server test script exists
  build:   not required for the current plain Node.js server

client/
  install: npm ci
  test:    npm test
  build:   npm run build
```

The missing server test stage is an explicit current limitation. The CI/CD server does not invent a command that DataDock does not provide.

## Complete pipeline flow

```text
queued
  -> checking_out
  -> checked_out
  -> installing  (server npm ci)
  -> installing  (client npm ci)
  -> testing     (client npm test)
  -> building    (client npm run build)
  -> build_succeeded

Any error -> failed + failedStage
```

`build_succeeded` means source checkout, dependency installation, tests, and build passed. It does not mean deployment or health checks succeeded.

## Trusted stage configuration

`src/config/pipeline.config.js` describes components and stages as data. Each stage contains:

- `name`: stable stage identifier.
- `status`: job status while the stage runs.
- `command`: executable launched directly.
- `args`: separate argument array.
- `timeoutMs`: maximum execution duration.

Configuration is owned by the CI/CD server. Commands, directories, and arguments never come from the webhook payload.

## Why command and argument arrays matter

The runner launches:

```js
spawn(command, args, {
  cwd,
  shell: false
});
```

It does not construct strings such as:

```text
cd <directory> && <webhook-command>
```

With `shell: false`, shell metacharacters are not interpreted as extra commands. The working directory is supplied using the process API rather than a shell `cd` command.

## Windows npm handling

Windows normally exposes npm through `npm.cmd`, and Node cannot directly spawn a `.cmd` file with `shell: false`. Enabling a shell would weaken the execution model.

On Windows, the configuration therefore launches:

```text
node <npm-cli.js> <npm arguments>
```

On Linux, it launches the npm executable directly. Both approaches preserve separated arguments and avoid a command shell.

## Why `npm ci`?

`npm ci` is designed for automated environments:

- Requires the committed lockfile.
- Installs the locked dependency versions.
- Rejects disagreement between `package.json` and the lockfile.
- Starts from a clean dependency tree.
- Produces more reproducible installations than an unconstrained update.

## Component-directory protection

Every component directory is resolved relative to the verified job workspace. `path.relative` checks that the result does not escape the workspace.

This blocks configurations such as `../../another-project`. The runner also verifies that the resolved location exists and is a directory. Setup errors are recorded as `<component>:setup`.

## Command runner

`src/services/command-runner.service.js` is responsible only for executing one configured process.

It:

- Uses `spawn` without a shell.
- Sets an explicit working directory.
- Captures stdout and stderr separately.
- Measures elapsed time.
- Enforces a per-stage timeout.
- Rejects non-zero exit codes.
- Caps captured stdout and stderr at 1 MiB each.
- Redacts values of environment variables whose names indicate secrets, tokens, passwords, private keys, or API keys.

Output limits prevent an excessively noisy process from consuming unbounded memory. For much larger production logs, output should be streamed directly to durable log storage.

## Secret redaction

Before output is persisted, the runner replaces known sensitive environment-variable values with `[REDACTED]`.

This is defense in depth, not a guarantee that arbitrary application output contains no sensitive information. Pipeline commands must still avoid printing credentials, and production systems should use structured secret masking and access-controlled logs.

## Stage execution service

`src/services/pipeline-stages.service.js`:

1. Resolves and validates each component directory.
2. Processes components and stages in configured order.
3. Updates `status` and `currentStage` before execution.
4. Appends a stage-start log.
5. Runs the command with its timeout.
6. Persists sanitized stdout and stderr.
7. Stores a structured stage result.
8. Stops immediately by throwing when a stage fails.

Example stage result:

```json
{
  "stage": "client:test",
  "status": "succeeded",
  "exitCode": 0,
  "durationMs": 842
}
```

Failed commands also store a result when process information is available.

## Fail-fast behavior

Stages are awaited inside ordered loops. If `client:test` rejects, execution exits the loop immediately. `client:build` is never started.

Fail-fast behavior prevents deploying code whose installation, tests, or build failed and avoids wasting compute on invalid work.

## Pipeline runner integration

The runner now owns the whole lifecycle from checkout through build:

- It obtains the isolated workspace from `checkoutExactCommit()`.
- It passes that exact path to `runPipelineStages()`.
- It marks the job `build_succeeded` only after all configured stages pass.
- It records `completedAt` on success.
- It records `failed`, `failedAt`, and the exact `failedStage` on error.
- It rethrows after persistence so queue failure isolation remains effective.

An optional component argument exists for integration testing. Production calls omit it and use the trusted DataDock configuration.

## Persistent observability

Job metadata now exposes:

- Current status.
- Current stage while running.
- Ordered stage results.
- Per-stage exit code and duration.
- Overall completion or failure timestamp.
- Exact failed stage.

The log contains stage starts, sanitized stdout/stderr, stage durations, and the final result.

## Tests

The integration test creates a real two-component Git repository with package lockfiles and two commits. It runs:

```text
exact checkout
server npm ci
client npm ci
client npm test
client npm run build
```

It verifies:

- The requested older commit is used instead of repository HEAD.
- All four configured stages succeed.
- A real build artifact is created in the isolated workspace.
- Job status becomes `build_succeeded`.
- Four structured stage results are stored.
- Timestamps and logs are persisted.

A separate full-runner failure test verifies:

- A command exits with code 2.
- The job becomes `failed`.
- `failedStage` identifies `application:test`.
- The failed exit code is persisted.
- A later build command never runs and creates no marker file.

## Current limitations

- DataDock's backend does not yet have automated tests, so CI currently only installs its dependencies.
- Output is captured and written after each command finishes rather than streamed live.
- Killing a timed-out parent process may not terminate every descendant on every operating system; production process-tree termination may require platform-specific handling.
- Secret redaction only covers known sensitive environment-variable values.
- The stage configuration currently represents DataDock rather than a multi-project registry.
- Cache restoration and dependency caching are not implemented.
- Workspaces and logs have no retention cleanup yet.
- `build_succeeded` is not deployment success. Milestone 7 adds deployment adapters.

## Interview explanation

> After exact-commit checkout, my runner executes a trusted component-and-stage configuration. It uses spawn with shell disabled, explicit argument arrays, validated working directories, timeouts, bounded output, and environment-secret masking. DataDock currently runs npm ci for its server, then npm ci, tests, and build for its Next.js client. Every transition, duration, exit code, and sanitized output is persisted. Execution is fail-fast, so a failed test prevents the build and all deployment work. I tested both the success path with real npm commands and the failure path by proving a later stage never executes.

## Expected interview questions

### Why not accept build commands from the webhook?

The webhook is external input. Executing its command fields would create remote command execution. Commands must come from trusted server-owned project configuration.

### Why disable the shell?

Without a shell, metacharacters cannot create pipelines, redirections, substitutions, or additional commands. Arguments are passed directly to the executable.

### Why use `npm ci` instead of `npm install`?

CI needs deterministic dependency versions and lockfile enforcement. `npm ci` is designed for clean automated installation.

### How is fail-fast implemented?

Each command promise is awaited sequentially. A rejection escapes the loop, so no later stage is scheduled. The outer runner records the exact failure.

### Why record both job status and stage results?

Status answers “where is the pipeline now?” Stage results provide historical detail such as which commands passed, their exit codes, and durations.

### Why have per-stage timeouts?

A hung test or build must not occupy a project queue forever. A timeout converts an indefinite wait into an observable failure and allows later jobs to continue.

### How do you prevent directory traversal?

The configured component path is resolved against the job workspace, then checked with `path.relative`. Any path outside the workspace is rejected before launching a process.

### Does secret redaction make logs completely safe?

No. It masks configured sensitive environment values, but an application could print unrelated confidential data. Logs still require access controls and commands should avoid emitting secrets.

### Why is there no server test stage for DataDock?

The server package currently defines no automated test script. I chose to expose that engineering gap rather than add a fake passing command. Adding backend tests later requires only adding the trusted stage configuration.

### What would you improve for large build logs?

I would stream output incrementally to durable log storage, apply redaction per chunk, support pagination or tailing, and enforce retention limits.

## Completion checklist

- [x] Trusted DataDock stage configuration exists.
- [x] Server and client working directories are separated.
- [x] Commands use executable/argument arrays.
- [x] Shell execution is disabled.
- [x] Windows npm runs without enabling a shell.
- [x] Component paths cannot escape the workspace.
- [x] Commands have timeouts.
- [x] Captured output is bounded.
- [x] Known environment secrets are redacted.
- [x] stdout and stderr are logged.
- [x] Status, stage, exit code, and duration are persisted.
- [x] Failed stages stop later stages.
- [x] Success ends at `build_succeeded`.
- [x] Real install, test, and build integration tests pass.
- [x] All 17 project tests pass.

Milestone 6 is complete. Milestone 7 will consume the verified build through local, SSH/EC2, S3-static, and generic deploy-hook adapters.
