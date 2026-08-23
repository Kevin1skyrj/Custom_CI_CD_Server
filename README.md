# Custom CI/CD Server

A production-tested, self-hosted CI/CD orchestrator built with Node.js.

It receives signed GitHub push events, validates deployment policy, builds the exact commit in an isolated workspace, deploys an immutable release, verifies application health, sends email status notifications, and can roll back to a known-good version.

> This is an educational and portfolio project for understanding CI/CD internals. It is not intended to replace distributed platforms such as GitHub Actions, Jenkins, or GitLab CI.

## Pipeline

```text
GitHub push
  -> verify raw-body HMAC signature
  -> validate event, repository, and branch
  -> create persistent idempotent job
  -> enter per-project queue
  -> checkout exact commit SHA
  -> install -> test -> build
  -> deploy through selected adapter
  -> retry public health check
  -> record healthy release or roll back
  -> send success/failure email
```

## Highlights

- Correct GitHub `X-Hub-Signature-256` verification with constant-time comparison
- Repository and branch allowlisting
- Persistent jobs and timestamped pipeline logs
- Atomic duplicate-delivery protection
- One-at-a-time deployment queue per project
- Isolated checkout of the exact pushed commit
- Shell-free command execution with timeouts and secret redaction
- Local, SSH/EC2, S3-static, and generic deploy-hook adapters
- Retrying health checks and known-good release tracking
- Automatic rollback orchestration and rollback health verification
- SMTP success and failure notifications
- Production assets for Nginx, systemd, PM2, and versioned EC2 releases
- 33 automated tests

## Architecture

```text
GitHub
   |
   | HTTPS webhook
   v
Nginx -> Express routes -> security middleware -> controller
                                                   |
                                                   v
                                            pipeline services
                                      /            |             \
                              repositories      queue       deploy adapters
                                                   |
                                                   v
                                      target host / provider
```

The code follows a route → middleware → controller → service → repository structure. Provider-specific behavior stays behind deployment adapters.

## Quick start

### Requirements

- Node.js 22+
- npm
- Git

### Install

```bash
git clone https://github.com/Kevin1skyrj/Custom_CI_CD_Server.git
cd Custom_CI_CD_Server
npm ci
cp .env.example .env
```

Generate a webhook secret:

```bash
openssl rand -hex 32
```

Set at least these values in `.env`:

```dotenv
GITHUB_WEBHOOK_SECRET=your-random-secret
ALLOWED_REPOSITORY=owner/repository
ALLOWED_BRANCH=main
REPOSITORY_CLONE_URL=https://github.com/owner/repository.git
```

The included stage configuration models DataDock's `server/` and `client/` directories. Adapt [`src/config/pipeline.config.js`](src/config/pipeline.config.js) to the trusted commands and directory layout of your application.

Choose and configure one deployment adapter. For a safe local experiment:

```dotenv
DEPLOYMENT_TYPE=local
LOCAL_DEPLOY_DIR=./data/local-releases
PIPELINE_DATA_DIR=./data/pipeline-jobs
PIPELINE_WORKSPACE_DIR=./data/workspaces
```

Run the server:

```bash
npm run dev
```

Run the tests:

```bash
npm test
```

## GitHub webhook

In the repository, open **Settings → Webhooks → Add webhook** and configure:

```text
Payload URL:  https://your-ci-domain.example/webhook/github
Content type: application/json
Secret:       same value as GITHUB_WEBHOOK_SECRET
Events:       push only
SSL:          enabled
```

A new delivery returns HTTP `202`; a duplicate delivery returns HTTP `200` with the original job ID.

## API

```http
POST /webhook/github
GET  /pipeline-jobs/:jobId
```

The included Nginx configuration exposes only the exact webhook path. Keep the job-details endpoint private until authentication is added.

## Deployment adapters

| Adapter | Use case | Activation model |
|---|---|---|
| `local` | Learning and same-host deployments | Immutable local directory plus activation manifest |
| `ssh` | Linux servers and AWS EC2 | `scp`, trusted remote script, atomic release symlink |
| `s3-static` | Static sites | Versioned S3 prefix and `current.json` manifest |
| `deploy-hook` | Vercel, Netlify, Render, or custom providers | Secret provider hook; acceptance is not reported as completion |

Select the adapter with:

```dotenv
DEPLOYMENT_TYPE=local|ssh|s3-static|deploy-hook
```

The full configuration reference is documented in [.env.example](.env.example).

## Production model used for DataDock

```text
GitHub
  -> HTTPS webhook on dedicated Ubuntu CI host
  -> exact-SHA test and build
  -> private VPC SSH
  -> /var/www/datadock-deploy/releases/<job-id>
  -> atomic current symlink
  -> PM2 reload
  -> Nginx
  -> public API health check
  -> email result
```

The production workflow activated two healthy releases, delivered failure and success emails, rolled back to the previous release, verified API/frontend health, and reactivated the latest release.

Deployment assets are in [`deploy/`](deploy). The human-reviewed production procedure and evidence are in [Milestone 10 notes](notes/milestone-10-datadock-production-readiness.md).

## Security model

- Verify the signature over untouched request bytes before JSON parsing.
- Never trust commands, hosts, paths, branches, or repositories from webhook payloads.
- Validate job IDs and commit SHAs before using them in paths or commands.
- Spawn commands without a shell and pass arguments separately.
- Use dedicated deployment credentials and strict SSH host-key checking.
- Keep build/runtime secrets outside Git workspaces and versioned releases.
- Expose only the webhook route publicly.
- Record only health-verified releases as rollback targets.
- Persist pipeline outcome before sending best-effort notifications.

Never commit `.env`, private keys, SMTP credentials, AWS credentials, or production application environment files.

## Tests

```bash
npm test
```

The 33-test suite covers webhook authentication, tamper detection, validation, persistence, duplicate deliveries, queue ordering, exact commit checkout, stage failures, deployment adapters, health retries, notifications, and rollback behavior.

## Known limitations

- One Node.js process with filesystem persistence
- In-memory queue is not reconstructed after restart
- No dashboard or authentication for the job-details API
- No distributed workers or locks
- No automatic workspace, log, or release retention policy
- Deploy-hook adapters do not poll managed providers to terminal status
- S3 activation requires a consumer for the `current.json` manifest

These boundaries are deliberate: the project focuses on the core CI/CD lifecycle while keeping the implementation explainable.

## Author

Built by Rajat Pandey as a hands-on study of secure CI/CD design and production deployment.
