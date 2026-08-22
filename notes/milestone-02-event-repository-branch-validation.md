# Milestone 2: Event, Repository, and Branch Validation

## Milestone outcome

The webhook endpoint now distinguishes between an authentic GitHub request and an authorized deployment trigger. After HMAC authentication succeeds, the server accepts only a `push` event from the configured repository and branch.

The server now produces these results:

| Request condition | HTTP status | Meaning |
|---|---:|---|
| Missing or invalid signature | `401` | Sender is not authenticated |
| Authenticated non-push event | `202` | Delivery succeeded, but event is intentionally ignored |
| Authenticated push with malformed JSON | `400` | Payload cannot be understood |
| Authenticated push from another repository | `403` | Sender is authenticated but repository is not authorized |
| Authenticated push to another branch | `202` | Valid event is intentionally ignored |
| Authenticated and authorized push | `200` | Request may continue to pipeline processing |

Milestone 2 does not create a pipeline job. Persistent jobs and logs begin in Milestone 3.

## Authentication versus authorization

Authentication asks:

> Did GitHub sign this exact request body with our shared secret?

Authorization asks:

> Even if GitHub sent it, is this the event, repository, and branch our server is configured to process?

A correctly signed webhook is not automatically safe to deploy. GitHub can legitimately send many event types, repositories may share a webhook endpoint, and feature branches should not automatically modify production.

```text
Incoming request
      |
      v
Authentication: valid GitHub signature?
      |
      v
Authorization: push + allowed repository + allowed branch?
      |
      v
Pipeline eligibility
```

## Configuration

The server uses two new environment variables:

```env
ALLOWED_REPOSITORY=Kevin1skyrj/DataDock
ALLOWED_BRANCH=main
```

`ALLOWED_REPOSITORY` uses GitHub's full repository name in `owner/repository` format. Checking only `DataDock` would be ambiguous because different owners can create repositories with the same name.

`ALLOWED_BRANCH` contains the short branch name. GitHub's push payload represents it as a full ref such as `refs/heads/main`.

In `src/config/env.js`, both values are exported and required:

```js
export const ALLOWED_REPOSITORY = process.env.ALLOWED_REPOSITORY;
export const ALLOWED_BRANCH = process.env.ALLOWED_BRANCH;

if (!ALLOWED_REPOSITORY || !ALLOWED_BRANCH) {
  throw new Error("ALLOWED_REPOSITORY and ALLOWED_BRANCH are required");
}
```

The server fails during startup when either authorization rule is absent. An accidental missing allowlist must not create an allow-all policy.

Tests use independent values:

```js
process.env.ALLOWED_REPOSITORY = "test-owner/test-repo";
process.env.ALLOWED_BRANCH = "main";
```

This prevents automated tests from relying on production configuration or a developer's real repository.

## Complete middleware order

The route is defined as:

```js
router.post(
  "/github",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  validateGithubWebhook,
  handleGithubWebhook
);
```

Express executes route handlers from left to right:

```text
1. raw body parser
        |
2. signature authentication
        |
3. event and payload authorization
        |
4. controller
```

This order is a security property, not a style preference.

- Raw bytes must be preserved before HMAC verification.
- Unauthenticated input must be rejected before JSON parsing and business logic.
- Unauthorized events must stop before the controller.
- Only the accepted request reaches future pipeline creation.

## Validation middleware

Milestone 2 adds `src/middlewares/validateGithubWebhook.js`.

### Importing configuration

```js
import {
  ALLOWED_BRANCH,
  ALLOWED_REPOSITORY,
} from "../config/env.js";
```

These are named imports because `env.js` exports named constants. Keeping deployment policy in configuration allows the same source code to run against different repositories and branches.

### Reading the event header

```js
const event = req.get("x-github-event");
```

GitHub places the webhook event name in `X-GitHub-Event`. HTTP header names are case-insensitive. Express's `req.get()` provides a convenient header lookup.

### Ignoring non-push events

```js
if (event !== "push") {
  return res.status(202).json({ message: "Event ignored" });
}
```

The comparison is strict and case-sensitive because GitHub's event identifier is defined as `push`.

HTTP `202 Accepted` tells GitHub that delivery succeeded even though the server intentionally performed no pipeline work. Returning a client or server error would misleadingly mark an expected ignored event as a failed webhook delivery.

The `return` is important: it stops the current middleware so JSON parsing and later authorization do not execute.

### Parsing only after authentication

```js
let payload;

try {
  payload = JSON.parse(req.body.toString("utf8"));
} catch {
  return res.status(400).json({ message: "Invalid JSON payload" });
}
```

At this point, `req.body` is still a `Buffer`. Authentication has already used those exact bytes. The middleware converts the buffer to a UTF-8 string and parses it into a JavaScript object.

`let` is used because the variable is declared outside the `try` block but assigned inside it. A `const` declared inside the block would not be available afterward because JavaScript braces create block scope.

`JSON.parse()` throws when input is malformed. The `try/catch` converts that programming exception into a controlled HTTP `400 Bad Request` response rather than allowing Express to return an unexpected server error.

The `catch` does not expose parsing details. External callers receive a stable error message without unnecessary internal information.

### Validating the repository

```js
if (payload.repository?.full_name !== ALLOWED_REPOSITORY) {
  return res.status(403).json({ message: "Repository not allowed" });
}
```

GitHub supplies the repository identity as `payload.repository.full_name`. Its value includes both owner and repository.

Optional chaining (`?.`) returns `undefined` when `repository` is absent instead of throwing an exception. `undefined` cannot match the allowed repository, so an incomplete payload is safely denied.

HTTP `403 Forbidden` is appropriate because the signature already authenticated the request, but the resource identity is outside server policy.

This is an allowlist design: one exact configured value is permitted; everything else is denied by default.

### Validating the branch ref

```js
if (payload.ref !== `refs/heads/${ALLOWED_BRANCH}`) {
  return res.status(202).json({ message: "Branch ignored" });
}
```

Git references have namespaces:

```text
refs/heads/main  -> branch named main
refs/tags/main   -> tag named main
```

Comparing the complete ref prevents a tag and branch with the same short name from being confused. It is safer than removing a prefix without first proving which namespace was received.

A push to another branch is a legitimate delivery, so the endpoint acknowledges and ignores it with `202`.

### Passing parsed data forward

```js
req.body = payload;
return next();
```

After verification, the raw buffer is no longer required by downstream code. Replacing it with the parsed object means controllers and later pipeline services can access fields normally:

```js
req.body.repository.full_name
req.body.ref
req.body.after
```

`next()` transfers control to `handleGithubWebhook`. It is reachable only when every check succeeds.

## Decision flow

```text
Signature valid?
├── No  -> 401
└── Yes
    |
    v
Event is push?
├── No  -> 202 ignored
└── Yes
    |
    v
JSON parses?
├── No  -> 400
└── Yes
    |
    v
Repository allowed?
├── No  -> 403
└── Yes
    |
    v
Branch allowed?
├── No  -> 202 ignored
└── Yes -> controller -> 200
```

## Why the order of authorization checks matters

The event header is checked before JSON parsing because ignored event types need no payload processing. This is a small efficiency improvement and keeps each rejection close to the information it depends on.

JSON must be parsed before repository and branch fields can be inspected.

Repository validation occurs before branch validation. A payload from an unauthorized repository receives `403` regardless of which branch it names. This avoids treating an unauthorized repository as merely an ignored branch.

Most importantly, all Milestone 2 checks run after HMAC authentication. No untrusted request can reach repository or branch business logic with an invalid signature.

## Test coverage

The integration suite now has eight cases:

| Test | Expected |
|---|---:|
| Missing signature | `401` |
| Incorrect signature | `401` |
| Authorized push | `200` |
| Modified body with old signature | `401` |
| Signed non-push event | `202` |
| Signed push with malformed JSON | `400` |
| Signed push from unauthorized repository | `403` |
| Signed push to non-deployment branch | `202` |

The Milestone 2 tests deliberately generate valid HMAC signatures even for payloads expected to fail authorization. Otherwise, they would stop in Milestone 1 middleware and would not prove the new validation behavior.

The malformed JSON test also signs the malformed bytes correctly. This demonstrates that authentication and JSON validity are independent concerns: a sender can authenticate bytes that are not valid JSON.

Final verified result:

```text
tests 8
pass 8
fail 0
```

## Security properties gained

- Only authenticated webhook bodies enter authorization logic.
- Only the exact `push` event is considered.
- Malformed payloads become controlled client errors.
- Repository identity uses the full owner/name combination.
- Missing repository data is denied safely.
- Repository access follows deny-by-default allowlisting.
- Full Git ref comparison distinguishes branches from tags.
- Non-deployment events are acknowledged without triggering work.
- Parsed payload data reaches the controller only after all checks pass.
- Tests use isolated authorization configuration.

## Current boundaries

- Only one repository and branch are configured. Multi-project configuration comes later.
- The controller still returns a confirmation and does not create a job.
- GitHub delivery IDs are not validated or deduplicated yet.
- The `after` commit SHA is not yet checked or stored.
- Push-deletion payloads are not handled specially yet.
- Payload shape validation is limited to fields required for current decisions.
- There is no schema-validation library because the current required shape is small.
- Branch comparisons are exact and intentionally case-sensitive.

## Alternatives considered

### Parse JSON before signature verification

Rejected because HMAC must cover the exact original bytes. Parsed and reconstructed JSON may not match GitHub's signed representation.

### Accept every signed GitHub event

Rejected because authenticity does not imply relevance. Pull requests, issue events, pings, and unrelated hooks must not create deployment jobs.

### Check only the repository name

Rejected because repository names are not globally unique. The owner/repository full name is the correct identity boundary.

### Check only whether `ref` ends with `main`

Rejected because a tag, another namespace, or a differently structured ref could also end with the same text. Exact full-ref matching is clearer and safer.

### Return errors for ignored events

Rejected because a correctly delivered but intentionally irrelevant webhook is not a delivery failure. A `2xx` response represents successful receipt.

### Add a schema-validation dependency now

Deferred because only two payload fields are needed. Optional chaining and exact comparisons handle the current scope without introducing another dependency. Schema validation may become valuable when later milestones consume more payload data.

## Interview-ready explanation

> After authenticating the raw webhook body, I added a separate authorization middleware. It first checks GitHub's event header and acknowledges irrelevant events without running work. It then parses the already-authenticated buffer, validates the repository using GitHub's owner/repository full name, and compares the complete branch ref so tags cannot be mistaken for branches. The server follows deny-by-default allowlisting and returns distinct HTTP statuses for unauthenticated, malformed, forbidden, ignored, and accepted deliveries. I verified every decision path with end-to-end HTTP tests.

## Interview questions and answers

### 1. Is a valid webhook signature enough to deploy?

No. It authenticates GitHub and protects payload integrity, but the server must still authorize the event type, repository, branch, and eventually delivery and commit information.

### 2. What is the difference between `401` and `403` here?

`401` means the signature is absent or invalid, so authentication failed. `403` means authentication succeeded but the repository is not allowed by server policy.

### 3. Why return `202` for ignored events and branches?

The webhook was successfully received and understood, but no pipeline work is required. A success-family status prevents GitHub from reporting an expected ignored delivery as failed.

### 4. Why not return `200` for everything?

Distinct statuses make behavior observable and testable. `400`, `401`, and `403` identify actual client, authentication, and authorization failures, while `202` communicates deliberate non-processing.

### 5. Why parse JSON after signature verification?

GitHub signs the exact raw bytes. Parsing first would destroy the original representation and could invalidate correct signatures or encourage insecure reserialization.

### 6. Why does `JSON.parse()` need `try/catch`?

It throws on malformed JSON. Catching it allows the server to return a controlled `400` response rather than propagating an exception.

### 7. Why is `payload` declared with `let`?

It must be assigned inside `try` and used outside that block. A `const` declared inside `try` would be block-scoped and unavailable afterward.

### 8. What does optional chaining do?

`payload.repository?.full_name` accesses `full_name` only when `repository` is not null or undefined. Missing data produces `undefined` and fails the allowlist comparison safely.

### 9. Why validate `repository.full_name`?

It includes the owner and repository name, creating a more precise identity than the repository's short name alone.

### 10. What is an allowlist?

It defines the exact identities that are permitted and denies everything else. This is safer than trying to enumerate every disallowed repository.

### 11. Why compare `refs/heads/main` instead of `main`?

Git uses namespaced refs. Full comparison proves the payload refers to a branch and prevents confusion with a tag such as `refs/tags/main`.

### 12. Why is middleware order important?

Express executes handlers sequentially. Moving JSON parsing ahead of raw-body authentication would break signature correctness, while moving authorization after the controller could allow unauthorized work.

### 13. Why replace `req.body` with the parsed payload?

Authentication requires a buffer, but application logic works with an object. After authentication is complete, replacing it gives downstream handlers a convenient, already-authorized representation.

### 14. Why put these checks in middleware instead of the controller?

They are request-gating concerns. The controller should run only for an authenticated and authorized event, which keeps business logic simpler and prevents accidental bypass.

### 15. Why keep repository and branch in environment variables?

They are deployment policy that varies by environment. External configuration keeps code reusable and avoids hardcoding DataDock-specific values.

### 16. What happens when repository data is missing?

Optional chaining returns `undefined`, which does not equal the allowed full name, so the request receives `403` rather than crashing.

### 17. Can GitHub send a valid signature for malformed JSON?

Yes. HMAC authenticates bytes, not their semantic format. That is why authentication and parsing require separate checks and tests.

### 18. Why do authorization tests calculate valid signatures?

They must pass authentication to reach the middleware under test. An invalid signature would only retest Milestone 1.

### 19. How will this design support multiple projects later?

The single repository and branch configuration can evolve into a trusted project registry. The authenticated payload will look up a configured project rather than supplying executable paths or commands itself.

### 20. What information from the push payload will be needed next?

Milestone 3 will need a persistent job identity and useful metadata such as repository, branch, commit SHA, timestamps, and status. Delivery ID handling becomes important for duplicate protection in Milestone 4.

## Milestone completion checklist

- [x] Allowed repository configured outside code
- [x] Allowed branch configured outside code
- [x] Missing authorization configuration fails startup
- [x] `X-GitHub-Event` checked
- [x] Only `push` continues
- [x] JSON parsed only after HMAC verification
- [x] Malformed JSON returns `400`
- [x] Full repository identity compared exactly
- [x] Unauthorized repository returns `403`
- [x] Full branch ref compared exactly
- [x] Non-deployment branch returns `202`
- [x] Parsed payload forwarded to controller
- [x] All authentication regression tests pass
- [x] All authorization-path tests pass
- [x] Eight total tests pass
- [x] No whitespace errors
- [x] Milestone documentation completed
