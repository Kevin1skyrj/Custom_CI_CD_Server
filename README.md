# Custom CI/CD Server

A small, security-focused CI/CD orchestrator built with Node.js to demonstrate what happens behind managed CI/CD platforms.

The server authenticates GitHub webhooks, validates the event and project, creates durable jobs, prevents duplicate execution, serializes deployments per repository, checks out the exact commit, runs install/test/build stages, deploys through adapters, verifies health, rolls back unhealthy releases, and sends terminal email notifications.

## Why this project exists

GitHub Actions, Vercel, Netlify, and Render hide much of the pipeline lifecycle. This project implements the core mechanics directly so each trust boundary, state transition, process, and failure mode can be explained in an interview.

It is intentionally a single-node educational/self-hosted system rather than a replacement for a distributed enterprise CI platform.

## Pipeline

```text
GitHub push
  -> raw-body HMAC verification
  -> event/repository/branch validation
  -> persistent queued job
  -> duplicate-delivery protection
  -> per-repository queue
  -> isolated exact-SHA checkout
  -> install -> test -> build
  -> deployment adapter
  -> retrying health check
  -> success or versioned rollback
  -> best-effort email notification
```

## Implemented features

- Correct GitHub `X-Hub-Signature-256` verification over the raw request bytes.
- Constant-time signature comparison.
- Push-event, repository, and branch allowlisting.
- Filesystem-persisted job metadata and timestamped logs.
- Atomic GitHub delivery claims using exclusive file creation.
- Concurrent duplicate protection.
- Promise-based queue keyed by repository.
- One isolated workspace per UUID job.
- Shallow fetch and detached checkout of the exact 40-character commit SHA.
- Post-checkout `HEAD` verification.
- Trusted component/stage configuration.
- Shell-free command execution with argument arrays, timeouts, bounded output, and secret redaction.
- DataDock server install plus client install, test, and build stages.
- Stage-specific protected environment-file injection.
- Local, SSH/EC2, S3-static, and generic deploy-hook adapters.
- Retryable public health verification.
- SMTP success/failure notifications that cannot change pipeline outcome.
- Persistent known-healthy release registry.
- Adapter rollback followed by rollback health verification.
- DataDock PM2 versioned-release automation assets.

## Architecture

```text
routes -> middleware -> controllers -> services -> repositories
                                      |
                                      -> deployment adapters
```

- Routes define HTTP endpoints.
- Middleware authenticates and validates external input.
- Controllers translate HTTP requests and responses.
- Services own pipeline rules and orchestration.
- Repositories isolate persistent filesystem access.
- Adapters isolate provider-specific deployment behavior.

## API

### GitHub webhook

```http
POST /webhook/github
```

New accepted job:

```json
{
  "message": "Pipeline job queued",
  "jobId": "uuid",
  "duplicate": false
}
```

A duplicate delivery returns HTTP `200` with the original job ID. A new job returns HTTP `202`.

### Job details

```http
GET /pipeline-jobs/:jobId
```

This endpoint is intended for a trusted/private network. The supplied Nginx public configuration exposes only the exact webhook route because job authentication has not been added.

## Setup

Requirements:

- Node.js 22+
- Git
- npm

Install:

```bash
npm ci
cp .env.example .env
```

Fill `.env` with trusted values. Never commit `.env`, SSH private keys, SMTP credentials, hook URLs, AWS keys, or production application environment files.

Run locally:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

## Configuration groups

- GitHub authentication and allowlist
- Pipeline data/workspace locations
- DataDock stage-specific client build environment
- Deployment adapter selection
- Local deployment target
- SSH key, known hosts, remote release directory, and trusted script
- S3 static bucket/build directory
- Generic deploy and rollback hooks
- Health retry policy
- SMTP notification transport
- Rollback enablement

See [.env.example](.env.example) for the complete list.

## Deployment adapters

### Local

Copies the verified workspace to an immutable UUID release directory and updates a local activation manifest.

### SSH/EC2

Uses strict host verification and direct `ssh`/`scp` argument arrays. It calls only a preinstalled remote script with fixed actions:

```text
prepare <job-id>
activate <job-id> <commit-sha>
rollback <failed-job-id> <previous-job-id>
```

### S3 static

Streams a configured static build directory under a versioned prefix. It never sets public ACLs. DataDock does not use this adapter; its private S3 bucket stores user files.

### Deploy hook

Triggers managed providers through a secret HTTP hook. Hook acceptance is stored as `deployment_triggered`, not falsely reported as completed deployment.

## DataDock production model

```text
GitHub -> Ubuntu CI server -> private SSH -> DataDock EC2
                                            |
                                            -> versioned release
                                            -> atomic current link
                                            -> PM2 reload
                                            -> Nginx :3000/:4000
                                            -> public health check
```

Production assets:

- `deploy/datadock/cicd-deploy`
- `deploy/datadock/datadock.ecosystem.config.cjs`
- `deploy/ci-server/custom-cicd.service`
- `deploy/ci-server/nginx-webhook.conf`

The current DataDock deployment at `/var/www/datadock` should remain untouched as a recoverable legacy installation until the first versioned release is verified.

## Security decisions

- Verify raw bytes before JSON parsing.
- Do not trust repository, branch, command, path, host, bucket, or hook values from webhooks.
- Use UUID validation before filesystem path construction.
- Use atomic exclusive delivery claims.
- Run Git and build commands without a local shell.
- Restrict paths to job workspaces.
- Keep strict SSH host-key verification enabled.
- Keep application environment files outside releases.
- Use AWS credential-provider chains instead of source-code keys.
- Reject S3 symlinks and public ACLs.
- Persist terminal state before attempting notifications.
- Roll back only to a previously health-verified release.
- Recheck health after rollback.

## State model

Typical success:

```text
queued -> checking_out -> checked_out
-> installing -> testing -> building -> build_succeeded
-> deploying -> checking_health -> succeeded
```

Recovery:

```text
checking_health -> failed -> rolling_back
-> checking_rollback_health -> rolled_back | rollback_failed
```

## Tests

The suite includes real HTTP servers, real local Git repositories, real npm stages, concurrent webhook delivery, queue-order tests, fake SMTP, captured SSH commands, and fake S3 clients. No production deployment is performed by tests.

## Known limitations

- Single Node.js process and local filesystem persistence.
- In-memory execution queue is not restart-recovered.
- No dashboard or job API authentication.
- No distributed locks or workers.
- No workspace/log/release retention worker.
- DataDock backend currently has no automated test script.
- Managed-provider terminal polling is not implemented.
- S3 `current.json` requires a compatible traffic-switching layer.
- Initial host provisioning and the first production cutover require human review; subsequent `main` pushes are automated.

## Production validation

The complete workflow is running for DataDock. GitHub sends signed push events to `https://cicd.datadock.me/webhook/github`; the dedicated CI host builds the exact commit and deploys through private VPC SSH to versioned EC2 release directories. Two healthy releases were activated, public API and frontend checks passed, failure and success emails were delivered, and an atomic rollback plus forward reactivation were verified against production.

## Interview summary

> I built and productionized a custom CI/CD orchestrator in Node.js to understand the complete delivery lifecycle. It securely authenticates GitHub raw webhooks, validates project policy, persists idempotent jobs, queues work per repository, checks out the exact commit in an isolated workspace, executes trusted stages without shell interpolation, deploys through infrastructure adapters, verifies application health, records known-good releases, automatically rolls back unhealthy versions, and sends failure-isolated SMTP notifications. Beyond automated tests, I deployed it on a dedicated Ubuntu host and verified versioned DataDock releases, private-network SSH, PM2 activation, public health checks, email delivery, rollback, and forward recovery against production.

Detailed implementation and interview questions for every milestone are available in [notes](notes).
