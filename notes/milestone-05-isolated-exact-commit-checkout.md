# Milestone 5: Isolated Checkout of the Exact Commit

## Goal

Run every accepted pipeline job in its own filesystem workspace and check out the exact commit SHA supplied by the authenticated GitHub push—not whatever commit happens to be the latest branch tip when execution begins.

## End-to-end flow

```text
Authorized, non-duplicate webhook
  -> persist queued job
  -> enqueue by repository
  -> return HTTP 202 without waiting for Git
  -> queue starts job
  -> status: checking_out
  -> create data/workspaces/<job-id>
  -> initialize an empty Git repository
  -> fetch only the requested SHA
  -> detached checkout of FETCH_HEAD
  -> verify git rev-parse HEAD equals requested SHA
  -> status: checked_out

Any checkout failure
  -> status: failed
  -> failedStage: checkout
  -> timestamp and safe error log persisted
```

## Why checkout the SHA instead of the branch?

Suppose commit A triggers a webhook and commit B is pushed before job A begins. Running `git clone` or `git pull main` can retrieve B. The system would then report job A while actually testing and deploying B.

The webhook's `after` value identifies the exact commit GitHub says resulted from the push. Persisting, fetching, checking out, and verifying that SHA makes the pipeline reproducible and auditable.

## Workspace isolation

Each job receives:

```text
data/workspaces/<job-uuid>/
```

Benefits:

- Concurrent jobs for different repositories do not overwrite each other's files.
- Old files from an earlier build cannot contaminate a new build.
- A job cannot silently change another job's Git checkout.
- Later install, test, build, and deployment stages receive one explicit working directory.

`fs.mkdir(jobWorkspace)` intentionally does not use `recursive: true`. If that exact job workspace already exists, creation fails instead of silently reusing possibly contaminated files.

## Git commands

The checkout service executes:

```text
git init
git remote add origin <trusted configured clone URL>
git fetch --depth=1 origin <exact commit SHA>
git checkout --detach FETCH_HEAD
git rev-parse HEAD
```

### Why initialize and fetch instead of a normal clone?

A normal clone follows a branch and downloads its current tip. Initializing an empty repository and fetching the requested SHA makes the intended revision explicit. `--depth=1` avoids downloading unnecessary history for the current pipeline stage.

### Why detached HEAD?

The pipeline is building an immutable commit, not developing on a branch. Detached HEAD prevents branch movement and clearly represents a fixed source revision.

### Why verify with `rev-parse`?

Commands can succeed while assumptions are wrong. Comparing `HEAD` with the requested SHA creates an explicit invariant: the files in this workspace must belong to the webhook's commit.

## Safe process execution

Git is launched using Node's `execFile` with an argument array:

```js
execFile("git", args, options)
```

No shell is enabled and no command string is constructed. This matters because repository URLs and commit identifiers must never be interpolated into shell syntax. Argument arrays prevent characters such as `;`, `&&`, `$()`, or PowerShell expressions from becoming additional commands.

The commit SHA must match exactly 40 hexadecimal characters before Git is invoked.

## Protecting credentials in logs

A private repository URL may eventually contain or reference credentials. Raw Git error messages can include the complete command and remote URL. The checkout service therefore converts process failures into stage-only messages such as:

```text
Git fetch failed
```

It does not persist raw command arguments. Operational detail is deliberately balanced against secret protection.

## Status transitions

This milestone introduces persistent execution transitions:

```text
queued -> checking_out -> checked_out
                       -> failed
```

Fields added during execution include:

- `startedAt`: when queue processing begins.
- `checkedOutAt`: when exact-SHA verification succeeds.
- `failedAt`: when the checkout stage fails.
- `failedStage`: currently set to `checkout`.

The `checked_out` status is an intermediate success. It does not mean tests, build, deployment, or health checks succeeded.

## File responsibilities

### `src/config/env.js`

- `PIPELINE_WORKSPACE_DIR`: trusted root for isolated job workspaces.
- `REPOSITORY_CLONE_URL`: trusted source repository configured by the server owner.
- `PIPELINE_EXECUTION_ENABLED`: permits HTTP-focused tests or controlled operation without launching pipeline work. Execution is enabled unless explicitly set to `false`.

The clone URL comes from trusted configuration, never the webhook body.

### `src/services/checkout.service.js`

- Validates the commit SHA.
- Resolves the configured workspace root.
- creates a fresh job directory.
- Executes Git without a command shell.
- Fetches and checks out the requested commit.
- Verifies the resulting `HEAD`.
- Returns the workspace path for later stages.

### `src/services/pipeline-runner.service.js`

- Adds the job to the repository-specific queue.
- Persists status changes and stage timestamps.
- Appends checkout lifecycle logs.
- Converts checkout exceptions into persistent failed job state.
- Rethrows after recording failure so the queue caller still knows the task failed.

### `src/services/project-queue.service.js`

The Milestone 4 queue now receives real checkout work. Same-repository checkouts are serialized while unrelated projects can prepare workspaces concurrently.

### `src/repositories/pipeline.repository.js`

`updatePipelineJob(jobId, updates)` reads existing metadata, merges controlled service-provided fields, persists the result, and returns the updated job.

### `src/controllers/webhook.controller.js`

Only a newly created job is scheduled. Duplicate webhooks return the canonical job ID without scheduling it again.

The promise is intentionally not awaited, so GitHub receives the HTTP response immediately. A rejection handler prevents unhandled promise rejections while the runner has already persisted the failure.

## Configuration used for DataDock

```dotenv
PIPELINE_WORKSPACE_DIR=./data/workspaces
REPOSITORY_CLONE_URL=https://github.com/Kevin1skyrj/DataDock.git
PIPELINE_EXECUTION_ENABLED=true
```

For a private repository, authentication must use a carefully managed credential mechanism such as a read-only deploy key, Git credential helper, or appropriately scoped token. Secrets must not be placed in logs or committed `.env` files.

## Integration tests

The test creates a genuine temporary local Git repository and makes two commits:

```text
first commit  <- requested by pipeline job
second commit <- current source repository HEAD
```

It then runs the real scheduler and checkout service and verifies:

- The workspace contains the first commit's file content.
- The source repository's newer second commit was not accidentally selected.
- Job status becomes `checked_out`.
- Execution timestamps are persisted.
- Checkout lifecycle logs are written.
- An invalid SHA causes a rejected task.
- The failed job records `status: failed` and `failedStage: checkout`.

Temporary repositories and workspaces use the operating system's temporary directory and are removed after testing.

## Current limitations

- Workspaces are retained; a cleanup/retention policy is still needed.
- The current configuration represents one repository. A trusted project registry will later map each allowed project to its clone URL and deployment adapter.
- Private-repository credential setup is not implemented yet.
- A process restart loses the in-memory queue even though job state remains on disk.
- The shallow direct-SHA fetch depends on the Git server allowing the requested reachable commit to be fetched.
- Submodules and Git LFS are not handled.
- Filesystem job updates are not transactional across multiple server processes.
- Checkout success does not yet mean pipeline success. Install, test, and build begin in Milestone 6.

## Interview explanation

> Every job receives a workspace named by its internal UUID. I do not clone the branch tip because it may advance after the webhook arrives. Instead, I initialize an empty repository, fetch the authenticated webhook's exact 40-character commit SHA with shallow history, perform a detached checkout, and verify HEAD with `git rev-parse`. Git runs through `execFile` with argument arrays rather than through a shell, reducing command-injection risk. The runner persists checking-out, checked-out, and failed states and is connected to the per-repository queue, while the webhook still returns 202 immediately.

## Expected interview questions

### Why is `git pull` unsuitable for this pipeline?

It updates an existing working tree to a branch's current state, which may not match the commit that triggered the job. It can also retain untracked or generated files from previous builds.

### Why does every job need a different workspace?

Isolation prevents cross-job contamination and permits safe concurrency between independent repositories. It also makes cleanup and auditing job-specific.

### What is detached HEAD?

HEAD points directly at a commit instead of a movable local branch. This is appropriate for CI because the pipeline consumes an immutable revision and should not create development commits.

### Why validate the SHA if Git will reject an invalid value?

Validation rejects malformed external data before launching a process, documents the accepted format, and reduces the input space passed to Git.

### Why use `execFile` instead of `exec`?

`exec` commonly invokes a shell with a command string. `execFile` launches the executable directly and passes arguments separately, avoiding shell parsing and shell metacharacter injection.

### Why fetch with `--depth=1`?

The current stage needs one commit, not full project history. A shallow fetch reduces network transfer, disk usage, and checkout time.

### Why verify the commit after checkout?

Verification turns an assumption into a checked invariant. The pipeline refuses to continue unless the workspace contains exactly the revision recorded in the job.

### Why does the controller not await checkout?

Webhook handlers must respond quickly. Checkout and later build stages may take minutes, so they run asynchronously after durable job creation.

### What happens when checkout fails?

The runner persists `failed`, `failedAt`, and `failedStage: checkout`, appends a safe log entry, and rejects the task promise. The per-project queue still allows the next job to run.

### How would you support several repositories?

I would introduce a trusted project registry keyed by the validated `owner/repository`. Each entry would define clone URL, allowed branch, stage configuration, workspace policy, and deployment adapter. None of those operational values would come from the webhook payload.

### What about private Git repositories?

I would use least-privilege credentials, preferably a read-only GitHub deploy key or GitHub App token. Credentials would be injected through protected runtime configuration and redacted from errors and logs.

## Completion checklist

- [x] Every job receives a unique workspace.
- [x] Existing workspace reuse fails safely.
- [x] Commit input is validated.
- [x] Git runs without shell interpolation.
- [x] Only the exact SHA is fetched.
- [x] Checkout uses detached HEAD.
- [x] Resulting HEAD is verified.
- [x] Real checkout work uses the per-project queue.
- [x] Duplicate deliveries are not rescheduled.
- [x] Success and failure states are persisted.
- [x] Git errors do not expose raw command arguments in logs.
- [x] A real two-commit Git integration test proves exact checkout.
- [x] All 16 tests pass.

Milestone 5 is complete. Milestone 6 will run configured install, test, and build stages inside the verified workspace.
