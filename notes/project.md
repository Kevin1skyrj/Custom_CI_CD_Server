# Custom CI/CD Server — Project and Interview Guide

## One-line description

A self-hosted Node.js CI/CD orchestrator that converts verified GitHub pushes into isolated, tested, health-checked, versioned deployments with notifications and rollback.

## Two-minute interview explanation

I built this project to understand what a managed CI/CD product does behind the scenes. A push to an allowed GitHub repository sends an HTTPS webhook to my server. I verify GitHub's HMAC signature against the untouched request bytes, then validate the event type, repository, and branch.

For an accepted push, the server persists a UUID pipeline job and uses the GitHub delivery ID as an idempotency key. A per-project queue prevents two deployments of the same application from modifying production simultaneously. The runner creates an isolated workspace, fetches only the required Git commit, checks it out in detached mode, and verifies that `HEAD` exactly matches the webhook SHA.

Trusted server-side configuration defines install, test, and build commands. Commands are spawned without a shell, have timeouts and bounded output, and redact recognized secrets. After a successful build, a selected adapter deploys the workspace locally, over SSH, to S3, or through a generic provider hook.

For DataDock, the CI server uploads each release to a UUID directory on AWS EC2. A strict remote Bash script validates the release and commit, links protected shared environment files, atomically switches a `current` symlink, and reloads the client and server through PM2. The CI server checks the public API through DNS, TLS, Nginx, and the application. A healthy deployment is recorded as a rollback target; an unhealthy deployment attempts to restore the previous healthy release. Finally, success or failure is emailed without allowing notification problems to change the pipeline result.

I deployed the orchestrator on a dedicated Ubuntu EC2 instance, exposed only its webhook route through Nginx and HTTPS, connected it to production over private VPC SSH, activated multiple releases, verified health, tested rollback, and reactivated the latest release.

## Problem being solved

The old DataDock deployment flow was manual:

```text
change and test code locally
-> push to GitHub
-> open the production terminal
-> pull the repository
-> install/build when required
-> restart PM2
-> check the website manually
```

This was repetitive and had weak traceability. It was possible to deploy the wrong commit, forget a command, overlap two changes, or discover a failure only after production changed.

The automated workflow is:

```text
push main
-> authenticated pipeline job
-> exact commit build
-> immutable versioned deployment
-> health verification
-> success/failure email
-> rollback path
```

## Scope

The project is small enough to explain line by line, but implements the important trust boundaries and state transitions of a real delivery system.

It supports local Linux deployment, SSH/EC2 deployment, static S3 deployment, generic provider hooks, health checks, email notifications, release history, and rollback.

It deliberately does not reproduce enterprise features such as distributed workers, autoscaling, container orchestration, a visual workflow editor, or a hosted multi-tenant control plane.

## Architecture

```text
routes
  -> middleware
      -> controllers
          -> services
              -> repositories
              -> deployment adapters
```

### Routes

Routes map URLs and HTTP methods. They contain no pipeline business logic.

```http
POST /webhook/github
GET  /pipeline-jobs/:jobId
```

### Middleware

Middleware protects the external boundary before the controller runs:

- Signature middleware authenticates GitHub using the raw body.
- Validation middleware checks the event, repository, branch, and payload.

### Controllers

Controllers translate HTTP input into service calls and choose HTTP responses. A new job returns `202 Accepted` because execution continues asynchronously.

### Services

Services own job creation, scheduling, checkout, stages, deployment, health checks, releases, rollback, and notifications.

### Repositories

Repositories isolate filesystem persistence for jobs, logs, delivery claims, and known-healthy releases. Storage details do not leak into orchestration rules.

### Deployment adapters

Adapters expose a consistent deployment contract while isolating provider-specific behavior.

## End-to-end lifecycle

### 1. GitHub creates a signed delivery

GitHub calculates an HMAC-SHA256 digest using the webhook secret and raw JSON bytes. It sends the digest in `X-Hub-Signature-256` and a unique delivery ID in `X-GitHub-Delivery`.

### 2. The server authenticates raw bytes

The body stays a `Buffer` until verification completes. Parsing and re-stringifying JSON could change its bytes. The server calculates its own digest and compares equal-length buffers with `timingSafeEqual`.

### 3. Policy validation runs

A valid signature proves who sent the event; it does not authorize every deployment. The server separately verifies:

- Event is `push`
- Repository matches the allowlist
- Ref matches the deployment branch
- Delivery ID and commit SHA are present

### 4. A durable idempotent job is created

The server persists a UUID job before execution. It claims the GitHub delivery ID through exclusive file creation. Concurrent retries cannot both claim the same delivery.

### 5. The project queue schedules execution

Jobs for one repository run sequentially, preventing deployment races. Unrelated repositories may run concurrently. A failed promise is caught so it cannot permanently break the queue.

### 6. The exact commit is isolated

The runner creates a UUID workspace, initializes Git, fetches the requested SHA with limited history, performs a detached checkout, and verifies `git rev-parse HEAD`.

It never deploys whatever branch tip happens to exist later.

### 7. Trusted stages execute

Webhook data never supplies commands. Commands come from server-owned configuration.

For DataDock:

```text
server: npm ci
client: npm ci
client: npm test
client: npm run build
```

The command runner uses `spawn` with `shell: false`, separate arguments, timeouts, bounded output, and secret redaction.

### 8. The selected adapter deploys

The adapter receives the verified job and workspace. It reports a provider-specific result through a common contract.

### 9. Public health is checked

The health service retries a public URL. This exercises DNS, TLS, Nginx, the application port, startup, and the dependencies represented by the health route.

### 10. Release and notification state is finalized

Only a healthy deployment enters the known-good release registry. The pipeline result is persisted before email, so SMTP failure cannot rewrite deployment truth.

## Job state model

Success:

```text
queued -> checking_out -> checked_out
-> installing -> testing -> building -> build_succeeded
-> deploying -> staging_deployed
-> checking_health -> succeeded
```

Recovery:

```text
checking_health -> failed -> rolling_back
-> checking_rollback_health -> rolled_back | rollback_failed
```

Each meaningful transition is persisted, making the job explainable after the request finishes.

## Key engineering decisions

### Raw body before JSON parsing

Authentication covers bytes, not the semantic meaning of JSON. Signature verification must therefore happen before parsing.

### Authentication and authorization are separate

HMAC proves the sender knows the secret. Repository and branch allowlists decide whether that authenticated event may deploy.

### Delivery ID as an idempotency key

GitHub retries webhooks. Claiming its unique delivery ID atomically prevents repeated side effects.

### Persistent state before asynchronous work

The HTTP request can return `202` while work continues. Persisting first separates job lifetime from request lifetime.

### Queue by project instead of globally

A global queue blocks unrelated applications. No queue permits same-project races. A keyed queue provides serialization only where required.

### Exact SHA instead of branch checkout

Branches move; commit SHAs do not. The SHA connects webhook, job, build, release, and deployment evidence to one identity.

### No shell interpolation

`spawn(command, args, { shell: false })` keeps arguments separate from executable syntax and reduces command-injection risk.

### Immutable release directories

Every job uploads to a new UUID directory. A partial upload cannot overwrite the running application, and rollback retains complete previous artifacts.

### Atomic `current` symlink

Activation creates a temporary symlink and renames it over `current`. On one filesystem, readers see either the old target or the new target, never a partially changed pointer.

### Shared environment files

Runtime secrets live outside releases. Releases link to protected shared files, so secrets survive code changes without being committed or duplicated.

### Health-verified rollback targets

A release is not safe merely because it exists. Only versions that passed public health verification qualify as rollback targets.

### Best-effort notifications

Deployment truth must not depend on SMTP availability. Notification errors are recorded separately from pipeline outcome.

## Deployment adapters

### Local

Copies the verified workspace into an immutable local directory and updates an activation manifest. It is useful for learning and same-host staging.

### SSH/EC2

Uses strict host verification and argument-array `ssh`/`scp` commands. A restricted production account uploads releases and has narrowly scoped sudo permission for PM2 activation.

The trusted remote script supports:

```text
prepare <job-id>
activate <job-id> <commit-sha>
rollback <failed-job-id> <previous-job-id>
```

### S3 static

Uploads a static build beneath a versioned prefix and writes a `current.json` manifest. It rejects symlinks and never grants public ACLs. A CDN or application must consume the activation manifest.

### Deploy hook

Calls a configured secret URL for a managed provider. Hook acceptance becomes `deployment_triggered`, because an HTTP response does not prove provider completion.

## DataDock production architecture

```text
GitHub
  -> cicd.datadock.me (TLS + Nginx)
  -> custom CI/CD systemd service
  -> persistent job + isolated workspace
  -> install/test/build
  -> private VPC SSH as cicd-deploy
  -> /var/www/datadock-deploy/releases/<job-id>
  -> shared environment links
  -> atomic current symlink
  -> PM2 client/server reload
  -> Nginx public endpoints
  -> api.datadock.me/health
  -> SMTP notification
```

The CI application runs as a non-login `cicd` user. Nginx exposes only the webhook path. Production SSH uses a dedicated Ed25519 key and a pinned `known_hosts` entry. The two EC2 instances communicate over private VPC addresses.

PM2 executes an absolute Node binary directly instead of `npm run start`. This avoids depending on interactive NVM shell initialization or `PATH` during restricted automation.

## Production validation and lessons

The rollout produced evidence beyond unit tests:

- A stale DataDock test failed at `client:test`; the pipeline stopped before deployment and emailed the failed stage.
- After correcting the application test suite, all 24 current client tests and the Next.js build passed on the CI host.
- A remote precondition failure stopped before `current` was switched.
- Two CI-managed releases passed public health verification and generated success emails.
- A live rollback switched to the previous UUID release while API health and frontend HTTP 200 remained successful.
- Forward activation restored the latest release successfully.

Important lessons:

1. A green GitHub delivery proves webhook acceptance, not pipeline success.
2. A long-running daemon does not inherit Linux groups added after it starts.
3. NVM is usually initialized by an interactive shell; automation should use absolute runtime paths.
4. During legacy migration, health can still check the old process. The active runtime path must also be verified.
5. The first CI-managed release has no previous CI-known target, so the legacy deployment must remain recoverable during initial cutover.

## Failure behavior

| Failure | System behavior |
|---|---|
| Missing or invalid signature | HTTP 401; no job |
| Unsupported event | Ignored; no deployment |
| Unauthorized repository | Rejected |
| Wrong branch | Ignored |
| Duplicate delivery | Original job returned; no second execution |
| Checkout mismatch | Job fails before stages |
| Install, test, or build failure | Later stages and deployment skipped |
| Adapter failure | Job records the deployment-stage failure |
| Health failure | Previous healthy release rollback attempted |
| Rollback health failure | Job records `rollback_failed` |
| Email failure | Pipeline result remains unchanged |

## Testing strategy

The 33 automated tests cover:

- Missing, invalid, valid, and tampered signatures
- Event, repository, and branch validation
- Persistent job creation and retrieval
- Atomic concurrent delivery deduplication
- Same-project serialization and cross-project concurrency
- Queue continuation after failure
- Exact commit checkout and mismatch handling
- Stage success, failure, and fail-fast behavior
- Local, SSH, S3, and hook adapter contracts
- Health retry success and exhaustion
- Notification composition and isolation
- Healthy rollback and rollback failure
- Static validation of production deployment assets

Tests use local HTTP servers, temporary Git repositories, fake SMTP, fake S3 clients, and captured SSH commands. Automated tests never contact production.

## Security review checklist

- Webhook secret stored outside Git
- Signature verified over raw bytes
- Constant-time comparison used
- Repository and branch allowlisted
- Deliveries deduplicated atomically
- Job IDs and SHAs validated
- Commands owned by server configuration
- Shell disabled for child commands
- Output bounded and secrets redacted
- Workspaces isolated by UUID
- SSH key dedicated to deployment
- Strict host-key verification enabled
- SSH restricted through private networking and security groups
- Deployment account separated from application account
- Secrets stored outside releases
- Public Nginx route limited to the exact webhook path
- Health checked after activation and rollback

## Tradeoffs and limitations

### Filesystem persistence

It keeps the implementation visible and dependency-light, but a database would provide stronger querying, transactions, indexing, retention, and multi-node coordination.

### In-memory queue

It handles live concurrency correctly, but queued execution is not reconstructed after restart. A larger system would use a durable broker and workers.

### Single CI node

This suits a small self-hosted system. Horizontal scaling requires shared persistence, distributed locks, durable queues, and artifact storage.

### No authenticated dashboard

The job API remains private. A future dashboard requires authentication, authorization, pagination, and safe log presentation.

### Trusted static pipeline configuration

This prevents webhooks from supplying executable commands. Repository-defined pipelines would require schema validation, command policy, sandboxing, and pull-request trust rules.

## Comparison with managed CI/CD

| This project | Managed platform |
|---|---|
| One self-hosted orchestrator | Distributed control plane and worker fleet |
| Filesystem persistence | Managed databases and artifact storage |
| In-memory keyed queue | Durable distributed scheduler |
| Trusted code configuration | Repository workflows and marketplace actions |
| Four deployment adapters | Large provider ecosystem |
| Manual host provisioning | Managed runners or installed agents |
| Fully visible implementation | Operational complexity abstracted away |

Its value is exposing mechanisms that managed platforms hide, not having more features than those platforms.

## Common interview questions

### Why must the webhook body remain raw?

GitHub signs the exact bytes it sends. Parsing and serializing JSON may produce different bytes and invalidate the signature.

### Why use `timingSafeEqual`?

A normal comparison may return on the first different byte. Constant-time comparison reduces information leaked through timing.

### Does a valid signature mean the event should deploy?

No. It authenticates the sender. Event type, repository, and branch authorization remain separate decisions.

### Why return HTTP 202?

The webhook is accepted and persisted, but install, test, build, and deployment continue asynchronously.

### How are duplicate deliveries prevented?

The unique GitHub delivery ID is claimed using exclusive file creation. Only one concurrent request can create that claim.

### Why deploy the SHA rather than `main`?

`main` may move after webhook creation. The immutable SHA ensures the recorded and deployed code are identical.

### Why is a per-project queue necessary?

It prevents releases of the same application from racing while allowing unrelated projects to execute concurrently.

### How do you prevent command injection?

Webhook data never becomes a command. Commands are trusted configuration executed with `shell: false` and separate arguments.

### Why are releases immutable?

New directories prevent partial writes to the live application and preserve complete artifacts for rollback.

### Why use a symlink for activation?

It provides a stable runtime path and makes activation or rollback one atomic pointer change.

### Why check the public health URL?

It verifies DNS, TLS, Nginx, the process, the application, and the dependencies represented by the route.

### What happens when a deployment is unhealthy?

The failure is persisted, the previous known-healthy release is selected, the adapter rolls back, and health is checked again.

### Can email failure change deployment status?

No. Terminal state is saved first; email is a best-effort side effect.

### Why not Docker or Kubernetes?

The goal was to understand orchestration and release mechanics with a small codebase. Containers are a possible future layer, not a requirement for these fundamentals.

### What would you build next?

1. Durable queue and restart recovery
2. Database-backed jobs and releases
3. Authenticated dashboard and live log streaming
4. Artifact storage and retention policies
5. Sandboxed or containerized build workers
6. Repository-defined pipelines with a validated schema
7. Metrics, audit events, and alert integrations

## Interview demonstration plan

1. Show the webhook configuration without exposing its secret.
2. Push an empty or documentation commit to `main`.
3. Show the `202` response and job UUID.
4. Query the job privately and explain each persisted stage.
5. Show UUID release directories on production.
6. Show `current` pointing to the job UUID.
7. Show PM2 working directories through `current`.
8. Show public health and the deployment email.
9. Explain the verified rollback instead of intentionally breaking production.

## Resume bullets

- Built and productionized a self-hosted Node.js CI/CD orchestrator with authenticated GitHub webhooks, persistent idempotent jobs, per-project queues, isolated exact-SHA builds, and fail-fast execution.
- Implemented local, SSH/EC2, S3-static, and deploy-hook adapters with public health verification, known-good releases, SMTP notifications, and rollback orchestration.
- Deployed the CI server on AWS using Ubuntu, Nginx, HTTPS, systemd, private VPC SSH, immutable release directories, atomic symlink activation, and PM2-managed services.
- Created a 33-test suite covering webhook tampering, concurrent deduplication, queue behavior, exact checkout, deployment adapters, health retries, notifications, and rollback.

## Honest closing statement

This project demonstrates that I understand CI/CD as a stateful, security-sensitive orchestration problem rather than only as a YAML file. I can explain where trust is established, how duplicate and concurrent work is controlled, how a specific commit becomes a release, how deployment truth is verified, and how the system recovers when a release is unhealthy. I also understand the limitations of this single-node design and what would be required to scale it safely.
