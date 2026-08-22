# Milestone 7: Staging Deployment Adapters

## Goal

Deploy a verified build through one trusted, configurable interface without coupling pipeline orchestration to a specific hosting platform.

Supported adapters:

- Local staging directory
- SSH/EC2 remote server
- S3 static-site artifact upload
- Generic HTTP deploy hook for providers such as Vercel, Netlify, or Render

## Architecture

```text
build_succeeded
  -> status: deploying
  -> deployment.service selects DEPLOYMENT_TYPE
  -> selected adapter deploys
  -> adapter result is validated and persisted
  -> staging_deployed | deployment_triggered | failed
```

The pipeline runner knows only `deployToStaging(context)`. Provider-specific behavior remains inside adapters.

## Common adapter contract

Every adapter exposes:

```js
export async function deploy(context) {
  return {
    provider: "adapter-name",
    deploymentId: "provider-or-job-id",
    status: "deployed-or-triggered"
  };
}
```

The context contains the trusted persisted job and its isolated workspace. The deployment service validates that the adapter returns an object with a provider.

## Deployment selection

`DEPLOYMENT_TYPE` must be exactly one of:

```text
local
ssh
s3-static
deploy-hook
```

The deployment service maps this configured value to an adapter. The webhook cannot choose an adapter, host, bucket, path, script, or URL.

## Local adapter

The local adapter copies the verified workspace into:

```text
LOCAL_DEPLOY_DIR/<job-id>/
```

It:

- Requires a valid internal UUID.
- Verifies the source is a directory.
- Rejects a deployment target located inside the source workspace.
- Refuses to overwrite an existing job deployment.
- Excludes `.git` metadata.
- Returns the deployed path as internal deployment metadata.

This prepares an isolated local staging release. It does not automatically start a web server.

## Deploy-hook adapter

The generic hook adapter sends an HTTP POST containing:

```json
{
  "jobId": "...",
  "repository": "owner/repository",
  "branch": "main",
  "commitSha": "..."
}
```

It:

- Uses a secret configured hook URL.
- Enforces a request timeout.
- Rejects non-success HTTP responses.
- Accepts JSON and non-JSON success responses.
- Extracts a provider ID when returned.
- Never includes the secret URL in its result or controlled errors.
- Returns `status: triggered`.

`triggered` is intentionally different from `deployed`. An accepted hook proves only that the provider accepted the request. Milestone 8 must confirm terminal provider state or run a health check before claiming success.

## SSH/EC2 adapter

The SSH adapter performs:

```text
ssh remote-script prepare <job-id>
scp workspace to remote release directory
ssh remote-script activate <job-id> <commit-sha>
```

It requires a preinstalled, trusted remote script. For DataDock, that script will be finalized during Milestone 10.

Security controls:

- Batch mode disables interactive password prompts.
- Strict host-key checking remains enabled.
- A specific `known_hosts` file is required.
- A specific private-key path is required.
- SSH username and hostname characters are restricted.
- Remote release and script paths must be safe absolute POSIX paths.
- Job UUID and commit SHA are validated.
- `ssh` and `scp` launch through argument arrays with no local command shell.
- Only the trusted remote script receives fixed actions: `prepare` and `activate`.
- Operations have a timeout.

The remote script is responsible for validating its own arguments, permissions, release path, activation, and service management.

## S3 static adapter

The S3 adapter uploads an explicitly configured static build directory to:

```text
S3_PREFIX/<job-id>/<relative-file-path>
```

It:

- Uses the official AWS SDK.
- Uses the normal AWS credential provider chain.
- Does not store access keys in source code.
- Requires a build directory relative to the workspace.
- Rejects directory traversal and absolute build paths.
- Rejects symbolic links that could expose files outside the build directory.
- Rejects empty build output.
- Preserves nested object paths using `/` separators.
- Streams file bodies instead of loading every file into memory.
- Sets content length and common MIME types.
- Uses `Cache-Control: no-cache` for staging correctness.
- Does not set public ACLs.
- Returns the job-specific object prefix and uploaded-file count.

The bucket must use bucket policy, CloudFront, or another deliberate delivery configuration. This adapter does not make objects public.

## DataDock S3 boundary

DataDock's existing private S3 bucket stores user-uploaded files. It is not an application deployment bucket and must never be supplied to this adapter.

DataDock will use the SSH/EC2 adapter because its Next.js frontend and Express backend run as PM2 processes behind Nginx on EC2.

The S3 adapter exists for other projects that produce genuine static output, such as an exported static site.

## Pipeline statuses

After build:

```text
build_succeeded
  -> deploying
     -> staging_deployed
     -> deployment_triggered
     -> failed
```

- `staging_deployed`: a synchronous adapter completed its work.
- `deployment_triggered`: an asynchronous provider accepted a hook but has not confirmed completion.
- `failed`: adapter selection or execution failed.

Persisted metadata includes:

- `buildCompletedAt`
- `deployment`
- `deployedAt` and `completedAt` for synchronous staging deployment
- `deploymentTriggeredAt` for asynchronous hooks
- `failedAt` and `failedStage` on errors

## Failure behavior

Before adapter execution, the runner sets:

```text
currentStage = deployment:<configured-type>
```

If the adapter throws, the existing pipeline failure handler persists:

```text
status: failed
failedStage: deployment:<configured-type>
```

A failed deployment never becomes `staging_deployed`.

## Configuration examples

### Local

```dotenv
DEPLOYMENT_TYPE=local
LOCAL_DEPLOY_DIR=./data/staging/local
```

### Deploy hook

```dotenv
DEPLOYMENT_TYPE=deploy-hook
DEPLOY_HOOK_URL=<secret-url>
DEPLOY_HOOK_TIMEOUT_MS=10000
```

### SSH/EC2

```dotenv
DEPLOYMENT_TYPE=ssh
SSH_HOST=staging.example.com
SSH_USER=deployer
SSH_PORT=22
SSH_PRIVATE_KEY_PATH=/secure/keys/deploy-key
SSH_KNOWN_HOSTS_FILE=/secure/ssh/known_hosts
SSH_REMOTE_DEPLOY_DIR=/srv/releases
SSH_REMOTE_DEPLOY_SCRIPT=/usr/local/bin/cicd-deploy
SSH_TIMEOUT_MS=300000
```

### S3 static

```dotenv
DEPLOYMENT_TYPE=s3-static
S3_BUCKET=dedicated-static-staging-bucket
S3_REGION=ap-south-1
S3_BUILD_DIR=client/out
S3_PREFIX=staging
```

## Tests

Tests prove:

- The configured adapter is selected.
- Missing adapters and invalid results are rejected.
- Local workspaces are copied without `.git`.
- Local releases cannot be overwritten.
- A real temporary HTTP server receives the expected hook payload.
- Hook acceptance produces `triggered`, not false deployment success.
- SSH commands execute in prepare, upload, activate order.
- SSH strict host-key checking is present.
- No real SSH connection is made.
- S3 object keys, content types, and file count are correct.
- S3 uploads do not include ACL fields.
- No real AWS request is made.
- A successful full pipeline persists local staging deployment metadata.
- A failing adapter persists the exact deployment failure stage.
- All earlier webhook, queue, checkout, test, and build behavior still passes.

## Current limitations

- The local adapter copies the full workspace except `.git`; large `node_modules` directories can make it expensive. Artifact manifests can optimize this later.
- Local staging prepares files but does not manage a running service.
- The deploy-hook adapter does not poll provider status yet.
- SSH currently transfers the whole workspace and depends on a separately installed remote script.
- SSH hostname validation currently targets DNS names and IPv4-style hosts, not raw IPv6 notation.
- S3 uploads are sequential; bounded parallel uploads could improve large-site performance.
- S3 cache behavior is conservative and does not yet distinguish hashed immutable assets.
- S3 does not invalidate CloudFront.
- Deployment metadata retrieval has no user authentication yet.
- Health verification begins in Milestone 8.
- Production version activation and rollback begin in Milestone 9.

## Interview explanation

> I implemented deployment through an adapter pattern so pipeline orchestration is independent of infrastructure. A trusted environment value selects local, SSH/EC2, S3-static, or generic deploy-hook behavior. Local creates an isolated staging copy; SSH uses strict host verification and a preinstalled remote script; S3 streams only an approved static directory under a job-specific prefix without public ACLs; and deploy-hook reports triggered rather than falsely claiming provider success. The runner persists deployment state and the exact failure stage. DataDock uses SSH because it runs dynamic Node processes on EC2, while its private user-file S3 bucket remains completely separate.

## Expected interview questions

### Why use an adapter pattern?

The pipeline should express “deploy this verified build,” not contain provider-specific branches. Adapters isolate infrastructure details and allow new targets without rewriting checkout, testing, or orchestration.

### Why can the webhook not provide deployment settings?

Deployment settings control command execution and privileged infrastructure access. Accepting them from external input could enable remote command execution, arbitrary uploads, or secret exfiltration.

### Why is a successful hook only `deployment_triggered`?

The HTTP response confirms request acceptance, not build or rollout completion on the provider. Terminal success requires provider-status polling, a callback, or an independent health check.

### Why require strict SSH host-key checking?

It verifies that the connection reaches the expected server and reduces man-in-the-middle risk. Disabling it would make automated deployment trust any presented host key.

### Why use a remote deployment script?

It keeps privileged server behavior preinstalled, reviewable, permission-controlled, and independent from webhook data. The CI server sends only validated release identifiers and fixed actions.

### Why not use DataDock's current S3 bucket?

That bucket contains private user objects and has a different security boundary. Mixing deploy artifacts with user data risks accidental exposure and destructive synchronization. DataDock application code is deployed to EC2.

### Why reject S3 symbolic links?

A symlink inside the build directory could point outside it and upload host files or secrets. Rejecting symlinks preserves the intended artifact boundary.

### Why avoid S3 public ACLs?

Modern S3 deployments should use centralized bucket policies and CloudFront controls. Per-object public ACLs weaken governance and may conflict with blocked-public-access settings.

### What is the difference between deployment and health?

Deployment means the artifact or release operation completed. Health means the running application responds correctly after deployment. Milestone 8 verifies that separate outcome.

### How would you add another provider?

Create an adapter implementing `deploy(context)`, validate its result, register it under a trusted deployment type, and add contract and integration tests. Pipeline orchestration remains unchanged.

## Completion checklist

- [x] Common adapter contract exists.
- [x] Deployment type is validated.
- [x] Local staging adapter exists.
- [x] Generic deploy-hook adapter exists.
- [x] SSH/EC2 adapter exists.
- [x] S3 static-site adapter exists.
- [x] DataDock user-file bucket is excluded from deployment design.
- [x] Deployment runs only after successful build.
- [x] Deployment results and timestamps are persisted.
- [x] Hook acceptance is distinguished from completed deployment.
- [x] Deployment failures identify the exact adapter stage.
- [x] External infrastructure is mocked or locally simulated in tests.
- [x] All 26 tests pass.

Milestone 7 is complete. Milestone 8 will add health checks and email notifications without allowing notification failure to change a successful deployment result.
