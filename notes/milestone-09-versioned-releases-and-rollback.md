# Milestone 9: Versioned Releases and Rollback

## Goal

Remember previously health-verified releases and automatically return to the most recent healthy release when a newly deployed version fails its post-deployment health check.

## Central safety rule

Only a release that previously completed a successful health check is eligible as a rollback target.

A build artifact, uploaded release, or successfully restarted process is not enough. The release registry is updated only after terminal health success.

## Full flow

```text
build succeeds
  -> load previous healthy release
  -> deploy new versioned release
  -> new health check succeeds
     -> status: succeeded
     -> save new release as current healthy release

  -> new health check fails
     -> persist original health failure
     -> previous healthy release exists?
        -> no: rollback not attempted; status remains failed
        -> yes: status rolling_back
             -> adapter rollback
             -> rollback health check
                -> healthy: status rolled_back
                -> unhealthy/error: status rollback_failed
  -> notify final state
```

The triggering job still rejects after a successful rollback because its new release failed. `rolled_back` means service recovery succeeded, not that the new commit succeeded.

## Persistent healthy-release registry

`src/repositories/release.repository.js` stores one registry per repository under the pipeline data directory:

```text
data/pipeline-jobs/releases/<sha256-of-repository>.json
```

Repository names are hashed before becoming filenames, preventing path manipulation and producing fixed safe keys.

The registry contains:

```json
{
  "current": {
    "jobId": "healthy-job-id",
    "repository": "owner/repository",
    "commitSha": "exact-commit",
    "deployment": {},
    "healthyAt": "timestamp"
  },
  "history": []
}
```

History is bounded to the latest 20 healthy releases to prevent unlimited metadata growth. Release files and actual deployment artifacts still need a separate retention policy.

## Why save only after health success?

Saving immediately after deployment could make an unhealthy version the “previous good” rollback target. Recording after health ensures the registry represents observed healthy state.

## Rollback adapter contract

The deployment service now supports:

```js
await rollbackStaging({
  job,
  workspace,
  failedDeployment,
  previousRelease
});
```

Adapters return the same provider-oriented result shape with a rollback status. The runner does not contain provider-specific rollback commands.

## Local rollback

Local deployments already use versioned directories:

```text
LOCAL_DEPLOY_DIR/
├── <job-a>/
├── <job-b>/
└── current.json
```

Deployment updates `current.json` to the new release. Rollback verifies that the previous UUID directory exists and rewrites `current.json` to the previous healthy release.

This is a staging activation manifest. A local serving layer must read or atomically consume that manifest; simply writing it does not restart a process.

## SSH/EC2 rollback

The SSH adapter invokes only the trusted remote script:

```text
cicd-deploy rollback <failed-job-id> <previous-healthy-job-id>
```

The remote script must atomically switch the active release, restart or reload services, and preserve the failed release for diagnosis. The CI server still runs a public health check after the remote script returns.

For DataDock, the production script and PM2/Nginx activation details are finalized in Milestone 10.

## S3 static rollback

Every S3 deployment has a versioned prefix:

```text
staging/<job-id>/...
```

The adapter also writes:

```text
staging/current.json
```

Rollback replaces this small manifest with the previous healthy job ID and prefix. No version objects are deleted.

This design requires the delivery layer to understand the manifest. A plain S3 website endpoint does not automatically route through `current.json`; a CloudFront function, deployment controller, or live-prefix synchronization strategy is required for actual traffic switching.

## Deploy-hook rollback

A generic provider hook cannot assume that every provider supports rollback. When `DEPLOY_HOOK_ROLLBACK_URL` is configured, the adapter posts:

```json
{
  "failedJobId": "...",
  "previousJobId": "...",
  "previousCommitSha": "..."
}
```

Without that URL, rollback fails explicitly as unsupported rather than pretending recovery occurred. Provider-specific APIs can later replace this generic hook.

## Rollback health verification

Adapter rollback success only confirms that the rollback operation ran. The runner repeats the same independent health check afterward.

```text
rolling_back
  -> checking_rollback_health
     -> rolled_back
     -> rollback_failed
```

This prevents a failed or incomplete rollback from being reported as recovery.

## Terminal states

- `succeeded`: the new release is healthy and is recorded as current.
- `failed`: the pipeline failed and rollback was unavailable, disabled, or unnecessary.
- `rolled_back`: the new release failed, but the previous release was restored and verified healthy.
- `rollback_failed`: restoring or verifying the previous release failed; operator action is required.

The original `failedStage: health-check` remains on a successful rollback so the cause of the triggering job is visible. A rollback failure changes the failed stage to `rollback` or `rollback-health-check`.

## Notification ordering

Email is sent only after rollback reaches its final state. Messages can therefore report:

- New release succeeded.
- Pipeline failed with no rollback.
- New release failed but rollback succeeded.
- New release and rollback both failed.

Email now includes rollback status and target job ID when present. Notification failure still cannot change any pipeline or rollback result.

## Configuration

```dotenv
ROLLBACK_ENABLED=true
```

For generic hooks only:

```dotenv
DEPLOY_HOOK_ROLLBACK_URL=<secret-provider-rollback-hook>
```

Rollback can be disabled for controlled maintenance or when an environment has no safe activation mechanism.

## Tests

Tests prove:

- A healthy release is saved in the persistent repository registry.
- An unhealthy later release selects that previous healthy job.
- Adapter rollback is followed by a second health check.
- Successful recovery ends as `rolled_back`.
- The original failed health metadata remains available.
- Notification receives the final rolled-back state.
- A thrown rollback operation ends as `rollback_failed`.
- Rollback failure notification receives the final failure state.
- Local rollback changes the current release manifest.
- SSH rollback sends one fixed trusted `rollback` action.
- S3 rollback updates only the current manifest to the prior prefix.
- No external server, bucket, provider, or email is contacted.

## Current limitations

- Release-registry writes are file-based and not transactional across multiple CI/CD server instances.
- Physical release directories and S3 prefixes are not pruned automatically.
- The local manifest needs a serving/activation layer.
- The real DataDock SSH rollback script is deferred to Milestone 10.
- S3 manifest switching requires a compatible traffic-serving design.
- Generic provider rollback depends on an explicitly configured provider hook.
- Rollback is triggered only for post-deployment health failure, not for pre-deployment checkout/test/build failures because no new release was activated.
- A database migration would be appropriate for horizontally scaled CI/CD workers.

## Interview explanation

> I maintain a persistent per-repository registry containing only releases that passed health verification. Before deploying, the runner loads the current healthy release. If the new deployment fails health, it asks the selected adapter to restore that known-good version and then runs health verification again. The final state distinguishes recovered rollback from rollback failure, and notification happens only afterward. Local, SSH, S3, and deploy-hook targets preserve the same orchestration contract while implementing different activation mechanisms. I never select an unverified build as a rollback target.

## Expected interview questions

### What makes a release eligible for rollback?

It must have completed deployment and passed the configured health check. Build success alone is insufficient.

### Why keep versioned releases instead of overwriting one directory?

Versioned immutable releases make rollback a pointer or activation switch rather than reconstructing old code during an outage.

### Why run health checks again after rollback?

The rollback command itself may fail silently or restore an unhealthy dependency combination. Recovery is complete only when the application responds successfully.

### Is `rolled_back` a successful pipeline?

No. It is successful service recovery after a failed new release. The triggering job still represents a failed deployment and rejects to its caller.

### Why preserve the original failed stage after successful rollback?

Operators need the reason the new release failed. Replacing it with a generic rollback state would lose root-cause context.

### Why rollback only health failures?

Checkout, install, test, and build failures happen before activation, so the current healthy release is still serving. Rolling it back would add risk without benefit.

### How does SSH rollback remain safe?

The CI server calls a preinstalled trusted script with validated UUID arguments. It does not accept remote commands from webhook data, and strict host verification remains enabled.

### Is `current.json` enough for an S3 website?

Not by itself. It is an activation manifest that a compatible delivery layer must consume. Plain S3 static hosting needs live-prefix copying or CloudFront-aware switching for real traffic activation.

### What happens when there is no previous healthy release?

Rollback is recorded as not attempted with `no_previous_healthy_release`, and the pipeline remains failed. It never guesses a rollback target.

### What happens if rollback fails?

The job becomes `rollback_failed`, records whether activation or rollback health failed, logs the event, and sends a terminal failure notification for operator intervention.

## Completion checklist

- [x] Healthy releases are persisted by repository.
- [x] Only health-verified releases enter the registry.
- [x] History is bounded.
- [x] Common rollback adapter contract exists.
- [x] Local rollback exists.
- [x] SSH rollback exists.
- [x] S3 version-pointer rollback exists.
- [x] Optional deploy-hook rollback exists.
- [x] Rollback is triggered by new-release health failure.
- [x] Rollback health is independently verified.
- [x] `rolled_back` and `rollback_failed` are distinct.
- [x] Notifications contain final rollback state.
- [x] Successful recovery and rollback failure are tested.

Milestone 9 is complete. Milestone 10 will implement the real DataDock EC2 release script, production configuration, controlled rollout, and verification procedure.
