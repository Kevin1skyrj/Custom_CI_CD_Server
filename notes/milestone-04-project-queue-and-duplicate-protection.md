# Milestone 4: Per-Project Queue and Duplicate Protection

## Goal

Prevent one GitHub webhook delivery from creating multiple pipeline jobs, and provide a queue that runs jobs serially per repository while allowing unrelated repositories to run concurrently.

## Problems solved

### Duplicate webhook deliveries

GitHub can redeliver an event when delivery is retried. Network clients can also retry when they do not receive a response. Without idempotency, one push could create and deploy multiple jobs.

### Overlapping deployments

Two commits can reach the same repository close together. If both deployments mutate the same working directory or server simultaneously, they can overwrite files, restart services out of order, and deploy an older commit after a newer one.

Globally serializing every job would be unnecessarily slow. DataDock should not block an unrelated project. Therefore, the queue key is the repository name.

## Duplicate-protection flow

```text
Create provisional UUID job file
  -> exclusively create delivery claim using flag "wx"
     -> success: append initial log and return new job with HTTP 202
     -> EEXIST: delete provisional job, load claimed job, return it with HTTP 200
```

Writing the provisional job before claiming is intentional. The winner's job already exists when another request discovers its claim. A losing concurrent request deletes only its own randomly generated provisional job directory.

## Persistent delivery index

Delivery records are stored under:

```text
data/pipeline-jobs/deliveries/<sha256-of-delivery-id>.json
```

Example content:

```json
{
  "deliveryId": "original GitHub delivery ID",
  "jobId": "our pipeline UUID"
}
```

The GitHub header is hashed before it is used as a filename. Hashing is deterministic, so the same delivery always maps to the same record. It also prevents path separators or traversal input from becoming part of a filesystem path. This hash is for safe indexing, not encryption.

## Atomic claim

`claimDelivery()` writes with:

```js
{
  encoding: "utf8",
  flag: "wx"
}
```

`w` means write a file. `x` means exclusive creation: the operation fails if the path already exists. The filesystem performs the existence check and creation as one operation, eliminating the check-then-write race.

An unsafe alternative would be:

```text
check whether delivery exists
  -> if absent, write delivery
```

Two requests could both complete the check before either write occurs.

## Service return value

`createPipelineJob()` now returns:

```js
{
  job,
  duplicate
}
```

- `duplicate: false` means a new job was persisted and returns HTTP `202 Accepted`.
- `duplicate: true` means the existing job was reused and returns HTTP `200 OK`.
- Both responses return the same `jobId` for the same GitHub delivery.

## Per-project queue design

`src/services/project-queue.service.js` holds a `Map`:

```text
repository key -> promise representing the tail of its queue
```

`enqueueProjectTask(projectKey, task)` performs these steps:

1. Reads the previous tail for the project, or starts with an already-resolved promise.
2. Chains the new task after that tail.
3. Creates a cleanup promise that resolves whether the task succeeds or fails.
4. Stores that cleanup promise as the project's new tail.
5. Returns the actual task promise so callers still receive its result or error.

## Why the queue continues after failure

The promise stored as the queue tail handles both fulfillment and rejection. Consequently, one failed deployment does not permanently poison the chain and prevent later commits from running.

The task's original promise is still returned, so the pipeline runner can mark that individual job as failed.

## Queue cleanup

After the final task completes, its entry is removed from the `Map`. The identity check ensures an older task cannot delete the entry when a newer task has already become the tail.

This prevents the in-memory map from growing forever as new repository names are processed.

## Concurrency behavior

```text
DataDock job A ──> DataDock job B

Other project job X ─────────────>
```

Jobs A and B are serialized because they share a repository key. Job X may run concurrently because it has a different key.

## File responsibilities

### `pipeline.repository.js`

- Converts delivery IDs to deterministic safe hashes.
- Atomically creates delivery claims.
- Reads existing claims.
- Deletes a losing provisional job directory.

### `pipeline.service.js`

- Creates provisional job metadata.
- Attempts the atomic claim.
- Returns the winning existing job for duplicates.
- Cleans up provisional state when it loses or claim creation errors.

### `webhook.controller.js`

- Destructures `{ job, duplicate }` from the service.
- Returns `202` for a new queued job.
- Returns `200` for an idempotent duplicate response.
- Always returns the canonical job ID.

### `project-queue.service.js`

- Owns in-memory per-project scheduling.
- Knows nothing about GitHub, HTTP, checkout, or deployment.
- Will receive the real pipeline execution function beginning with Milestone 5.

## Tests

The test suite verifies:

- A repeated delivery returns the original job ID.
- A repeated delivery does not leave a second job directory.
- Two concurrent identical requests produce one `202`, one `200`, and the same job ID.
- Tasks for one project execute in insertion order without overlap.
- Tasks for different projects start concurrently.
- A failed task does not block the next task for that project.
- Previous security, validation, persistence, and retrieval tests still pass.

## Current limitations

- The queue is process-local. Multiple CI/CD server instances would require a distributed queue or database locking.
- Queue contents exist in memory, although job records remain persisted. Restart recovery will need to reload queued/running jobs before claiming production-grade crash recovery.
- Delivery claims currently have no retention policy.
- This milestone provides the scheduler; Milestone 5 connects an actual isolated checkout task to it.
- The filesystem design targets a single-node educational/self-hosted server, not a horizontally scaled cluster.

## Interview explanation

> I made webhook processing idempotent using GitHub's delivery ID and atomic exclusive file creation. I hash the untrusted header before using it as a filesystem key. Under concurrent duplicate requests, both may create provisional UUID jobs, but only one can create the delivery claim; the loser deletes its provisional directory and returns the winner's job ID. I also implemented a promise-chain queue keyed by repository, so the same project's deployments cannot overlap while independent projects retain concurrency. Failures are isolated so one rejected task does not block the rest of its project queue.

## Expected interview questions

### What is idempotency?

Repeating the same logical operation produces the same effective result. Here, redelivering one GitHub event returns the same pipeline job instead of creating another deployment.

### Why is a normal existence check insufficient?

It creates a time-of-check/time-of-use race. Multiple requests may observe “missing” before any creates the record. Exclusive creation makes the decision atomic.

### Why use GitHub's delivery ID instead of the commit SHA?

The delivery ID identifies a webhook delivery and its retries. Two distinct events can legitimately reference the same commit, so commit SHA alone is not the correct idempotency key.

### Why hash the delivery ID?

It converts external input into a fixed-size filesystem-safe key. It prevents traversal and problematic filename characters while remaining deterministic.

### Why queue per repository instead of globally?

Same-repository deployments can conflict with each other. Unrelated repositories generally do not share deployment state, so global serialization would reduce throughput without improving their safety.

### How does the queue work without a queue package?

Each map value is the tail promise for a repository. A new task is chained after that promise. JavaScript promise sequencing provides ordered execution for each key.

### What happens when a queued task throws?

Its returned promise rejects so that job can be marked failed, while a separate handled tail promise resolves and permits the next task to start.

### Is this queue suitable for multiple Node.js instances?

No. Each process has its own `Map`. A distributed deployment would use Redis, a database-backed queue, or another broker with distributed locking.

### Why return `200` for a duplicate and `202` for a new job?

`202` says new asynchronous work was accepted. For a duplicate, no new work is created; `200` reports the already-existing result successfully.

## Completion checklist

- [x] Delivery IDs are stored persistently.
- [x] External IDs are converted to safe filesystem keys.
- [x] Claims use atomic exclusive creation.
- [x] Sequential duplicates reuse the original job.
- [x] Concurrent duplicates reuse the original job.
- [x] Losing provisional job data is cleaned up.
- [x] Same-project tasks execute serially.
- [x] Different projects retain concurrency.
- [x] Queue failures do not block following tasks.
- [x] Queue entries are cleaned up.
- [x] All 14 tests pass.

Milestone 4 is complete. Milestone 5 will perform an isolated checkout of the exact commit and connect that work to this queue.
