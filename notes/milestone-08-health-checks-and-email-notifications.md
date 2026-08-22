# Milestone 8: Health Checks and Email Notifications

## Goal

Separate “deployment command completed” from “the deployed application is actually healthy,” then notify the owner of the terminal pipeline result without allowing notification problems to corrupt that result.

## Final flow

```text
build succeeds
  -> deployment adapter runs
  -> status: checking_health
  -> retry configured health endpoint
     -> healthy: status succeeded
     -> retries exhausted: status failed, failedStage health-check
  -> persist terminal state
  -> attempt email notification
     -> sent: append confirmation log
     -> failed: append warning; terminal state remains unchanged
```

## Why deployment success is not health success

An upload, file copy, PM2 restart, or accepted provider hook can succeed while the application is unusable. Examples include:

- The process starts and immediately crashes.
- Required environment variables are absent.
- MongoDB or Redis initialization fails.
- Nginx points to the wrong upstream.
- A managed provider accepted the build but has not finished it.
- The new application returns HTTP 500.

The pipeline now claims `succeeded` only after an independent HTTP health request succeeds.

## Status transitions

```text
staging_deployed | deployment_triggered
  -> checking_health
     -> succeeded
     -> failed
```

Successful health metadata:

```json
{
  "status": "healthy",
  "statusCode": 200,
  "attempts": 2,
  "durationMs": 1240
}
```

Failed health metadata contains the same safe structure with `status: unhealthy`. It does not expose the configured health URL, response body, credentials, or network stack trace.

## Health-check service

`src/services/health-check.service.js` performs an HTTP `GET` with:

- `Accept: application/json`
- Per-attempt timeout using `AbortController`
- Configured maximum attempts
- Configured delay between attempts
- Success on an HTTP 2xx response
- Safe, structured failure metadata after exhaustion

The response body is not needed. Health is based on the endpoint's HTTP contract, which avoids storing arbitrary application responses in pipeline logs.

## Retry reasoning

Applications commonly need a short warm-up period after activation. A single immediate request can report a false failure. Bounded retries tolerate normal startup while still producing a deterministic terminal outcome.

Retries are bounded by both attempt count and per-request timeout. A permanently hanging endpoint therefore cannot occupy the project queue forever.

## DataDock health endpoint

The configured endpoint is:

```dotenv
HEALTH_CHECK_URL=https://api.datadock.me/health
```

DataDock's Express server exposes `/health`. In production, this request passes through the public HTTPS/Nginx path, so it verifies more than a localhost process check.

Milestone 10 may add additional frontend and component-specific checks before production activation is considered complete.

## Email notification service

`src/services/notification.service.js` uses Nodemailer and standard SMTP. This permits providers such as Amazon SES, Resend SMTP, or another SMTP service without coupling pipeline logic to one vendor API.

Emails are sent only for terminal outcomes:

- Pipeline and healthy deployment succeeded.
- Pipeline failed at checkout, install, test, build, deployment, or health check.

The email includes:

- Status
- Repository
- Branch
- Exact commit SHA
- Job ID
- Failed stage when applicable
- Health result and attempts when available

It deliberately excludes full logs, environment variables, SMTP credentials, hook URLs, SSH configuration, and AWS details.

## Notification failure isolation

The runner persists the terminal job state before attempting email. Notification runs inside its own `try/catch`.

If SMTP fails:

```text
Email notification failed; pipeline result was not changed
```

is appended to the job log. A healthy deployment remains `succeeded`; an unhealthy deployment remains `failed`.

This ordering prevents an observability failure from triggering rollback or misreporting application health.

## SMTP configuration

```dotenv
EMAIL_NOTIFICATIONS_ENABLED=false
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<secret-user>
SMTP_PASSWORD=<secret-password>
EMAIL_FROM=ci@example.com
EMAIL_TO=owner@example.com
```

Rules:

- Email is opt-in and disabled by default.
- Host, sender, and recipient are required when enabled.
- Username and password must either both exist or both be absent.
- Port must be valid.
- Credentials belong only in protected runtime configuration.
- Port 465 commonly uses `SMTP_SECURE=true`; port 587 commonly starts unencrypted and upgrades with STARTTLS using `SMTP_SECURE=false`.

## Pipeline-runner design

The runner now has one terminal-control sequence:

1. Execute checkout, stages, and deployment in the main `try` block.
2. Run health verification.
3. Persist `succeeded` or catch and persist `failed`.
4. Reload the final persisted job.
5. Attempt notification using that final state.
6. Rethrow the original pipeline error after notification, if one exists.

Reloading the job ensures the email represents durable state rather than a stale in-memory object created before stage transitions.

## Dependency injection in tests

The scheduler accepts optional adapters, health-check functions, and notification functions. Production uses real defaults. Tests inject controlled implementations to prove orchestration without contacting AWS, EC2, DataDock, or SMTP.

This is dependency injection: behavior is supplied from outside while the production interface remains the same.

## Tests

The suite proves:

- A real local HTTP server returns 503 once and 200 next; health succeeds on attempt 2.
- Repeated 503 responses exhaust configured retries and produce safe unhealthy metadata.
- A fake SMTP transporter receives the expected sender, recipient, subject, and concise body.
- SMTP credentials are absent from email content.
- A full successful checkout/build/deploy/health pipeline ends as `succeeded`.
- A simulated notification failure does not change that successful status.
- A full deployment with failed health ends as `failed` with `failedStage: health-check`.
- The failed health result is persisted.
- Terminal notification receives the already-persisted failed job.
- Earlier webhook, queue, checkout, build, and adapter tests remain green.

## Current limitations

- Health success currently means any HTTP 2xx response; JSON schema/content validation is not yet configured.
- There is one health URL rather than component-specific frontend, API, database, and worker checks.
- Provider hooks are verified through the configured public health URL rather than provider API status polling.
- Retry intervals are fixed rather than exponential backoff with jitter.
- Email supports one configured recipient string; recipient policy and templates remain simple.
- Email delivery acceptance by SMTP does not guarantee inbox delivery.
- No GitHub commit-status API integration has been implemented yet.
- Automatic rollback after health failure begins in Milestone 9.

## Interview explanation

> I separated deployment execution from health verification because copying files or restarting a process does not prove the application works. The runner performs bounded HTTP retries with per-attempt timeouts and persists safe health metadata. Only a 2xx health response produces the terminal succeeded state. After terminal state is durable, I send a concise SMTP email through Nodemailer. Notification is best-effort in a separate error boundary, so SMTP failure can never turn a healthy deployment into a failed one or trigger rollback. My tests include a real HTTP server that transitions from 503 to 200, exhausted retry behavior, fake SMTP, notification failure isolation, and a full unhealthy pipeline.

## Expected interview questions

### Why check health after a successful deployment command?

Deployment tools confirm their operation, not application behavior. Health checks verify that the running system responds after the change.

### Why retry instead of failing immediately?

Services may require warm-up time. Bounded retry prevents false failures while still limiting total wait time.

### Why use a timeout for every attempt?

A TCP connection or server response can hang. Without timeout, one request could block the repository queue indefinitely.

### Why not save the health response body?

The body may be large or contain internal details. This milestone needs only status, attempts, and duration. Rich schema validation can be added deliberately.

### Why persist status before sending email?

Job state is the source of truth. Notification is a secondary side effect. Persisting first ensures SMTP failure cannot corrupt or misrepresent deployment outcome.

### Why reload the job before notification?

The original job object has only queued metadata. Reloading retrieves the final status, failed stage, deployment result, health result, and timestamps that the email must describe.

### Why use SMTP rather than a provider-specific email API?

SMTP provides a small vendor-neutral interface supported by multiple providers. Nodemailer also makes transport easy to replace and mock in tests.

### What if email sending fails?

The failure is logged, but pipeline status remains unchanged. A notification outage is not an application deployment outage.

### How would health failure interact with rollback?

Milestone 9 will treat failed post-deployment health as a rollback trigger when a previous healthy version exists. Notification still remains outside rollback decisions.

### How would you improve retry behavior?

Use exponential backoff with jitter, overall deadlines, provider-aware readiness states, and component-specific checks while keeping attempts bounded.

## Completion checklist

- [x] Deployment health check exists.
- [x] Health requests have timeouts.
- [x] Startup retries are bounded.
- [x] Health success metadata is persisted.
- [x] Health failure metadata is persisted.
- [x] Health failure identifies the correct failed stage.
- [x] Terminal success requires health success.
- [x] SMTP notification service exists.
- [x] Success and failure messages contain useful concise context.
- [x] SMTP credentials are not included in messages.
- [x] Notification failure cannot change pipeline outcome.
- [x] Real HTTP and fake SMTP tests exist.
- [x] Full success and unhealthy pipeline paths are tested.

Milestone 8 is complete. Milestone 9 will add versioned releases and rollback when post-deployment health fails.
