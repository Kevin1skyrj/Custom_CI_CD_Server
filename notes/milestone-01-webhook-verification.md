# Milestone 1: Correct GitHub Webhook Verification

## Milestone outcome

The CI/CD server now exposes `POST /webhook/github` and authenticates incoming webhook requests with GitHub's HMAC-SHA256 signature. Requests with a missing, incorrect, or stale signature receive HTTP `401`. A request containing the correct signature for its exact raw body reaches the controller and receives HTTP `200`.

This milestone does not decide whether the webhook is a push event or whether its repository and branch are allowed. Those authorization rules belong to Milestone 2.

## Why webhook verification is required

A webhook URL is reachable over HTTP. Knowing the URL does not prove that a request came from GitHub. Without authentication, an attacker could send a fabricated request and eventually trigger expensive builds or production deployments.

GitHub and the CI/CD server share a secret that is never sent in the webhook request. GitHub combines the secret with the exact request body using HMAC-SHA256 and sends the result in the `X-Hub-Signature-256` header. Our server independently performs the same calculation. Matching results demonstrate that the sender possessed the shared secret and that the body was not modified after signing.

```text
GitHub                                      CI/CD server
   |                                             |
   | HMAC-SHA256(secret, raw body)               |
   |                                             |
   | POST body + X-Hub-Signature-256 ----------> |
   |                                             | HMAC-SHA256(secret, raw body)
   |                                             | compare signatures
   |                                             |
   | <------------------------- 200 or 401 ------|
```

## Authentication versus authorization

This milestone performs authentication: it checks whether the request was signed with our shared secret.

It does not yet perform authorization: a valid GitHub request might refer to the wrong event, repository, or branch. Milestone 2 will authorize only the events and source repositories we intend to process.

## Project structure

```text
index.js
src/
├── app.js
├── config/
│   └── env.js
├── controllers/
│   └── webhook.controller.js
├── middlewares/
│   └── verifyGithubSignature.js
└── routes/
    └── webhook.routes.js
test/
└── webhook.test.js
```

The project uses a layered Express structure. It borrows route and controller concepts from MVC, but there is no View layer because this is currently an HTTP service rather than a server-rendered user interface.

## Complete request flow

```text
POST /webhook/github
        |
        v
Express raw-body parser
        |
        v
GitHub signature middleware
        |
        +---- invalid ----> 401 Invalid signature
        |
        v valid
Webhook controller
        |
        v
200 Webhook verified
```

Middleware order is significant. The raw-body parser must execute before signature verification, and signature verification must execute before the controller.

## File-by-file explanation

### `index.js`

```js
import app from "./src/app.js";
import { PORT } from "./src/config/env.js";

app.listen(PORT, () => {
  console.log(`CI/CD server listening on port ${PORT}`);
});
```

`index.js` is the process entry point. It imports the configured Express application and port, then opens the network listener. Keeping startup separate from application construction allows tests to import `app` without automatically opening a fixed port.

The application is a default export, so it is imported without braces. `PORT` is a named export, so its import uses braces.

### `src/config/env.js`

```js
export const PORT = Number(process.env.PORT ?? 3000);
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!GITHUB_WEBHOOK_SECRET) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required");
}
```

Environment-specific values are kept outside source code. `process.env` contains the environment variables available to the Node.js process, and those values are strings. `Number()` converts the configured port to a number. The nullish coalescing operator uses `3000` only when `PORT` is absent.

The missing-secret check follows the fail-fast principle: an insecurely configured server stops during startup rather than accepting traffic in a broken state. There is deliberately no public default secret.

The real `.env` file is ignored by Git. Development loads it through Node's `--env-file=.env` option. The same secret will later be entered in the GitHub webhook configuration.

### `src/app.js`

```js
import express from "express";

import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

app.use("/webhook", webhookRoutes);

export default app;
```

Calling `express()` creates the application. `app.use("/webhook", webhookRoutes)` mounts the router under a common URL prefix. The router's `/github` path therefore becomes `/webhook/github`.

This file constructs and configures the application but does not call `listen()`. That separation makes integration testing with a temporary port straightforward.

### `src/routes/webhook.routes.js`

```js
router.post(
  "/github",
  raw({ type: "application/json" }),
  verifyGithubSignature,
  handleGithubWebhook
);
```

The route handles only POST requests. Its processing chain is ordered as follows:

1. `raw({ type: "application/json" })` reads an `application/json` request without parsing it into a JavaScript object. `req.body` remains a `Buffer` containing the exact bytes.
2. `verifyGithubSignature` authenticates those bytes.
3. `handleGithubWebhook` runs only after the middleware calls `next()`.

Using `express.json()` before verification would parse the body. Recreating JSON afterward could change whitespace, escaping, or formatting and therefore change the bytes used by the HMAC calculation.

### `src/middlewares/verifyGithubSignature.js`

The middleware contains three responsibilities.

#### Creating the expected signature

```js
const digest = crypto
  .createHmac("sha256", GITHUB_WEBHOOK_SECRET)
  .update(rawBody)
  .digest("hex");

return `sha256=${digest}`;
```

`node:crypto` explicitly imports Node's built-in cryptography module. No third-party `crypto` package is required.

`createHmac()` constructs a keyed hash calculator. The algorithm is SHA-256 and the key is the shared webhook secret. `update()` supplies the raw request bytes. `digest("hex")` finishes the calculation and represents the bytes as hexadecimal text. GitHub's header format includes the `sha256=` prefix, so our expected value must include it too.

#### Comparing signatures safely

```js
const expected = Buffer.from(expectedSignature);
const received = Buffer.from(receivedSignature ?? "");

return (
  expected.length === received.length &&
  crypto.timingSafeEqual(expected, received)
);
```

Both strings are converted to buffers for byte comparison. A missing header becomes an empty string rather than causing `Buffer.from(undefined)` to throw.

Ordinary string comparison can stop at the first mismatch. Small timing differences may reveal information about how much input matched. `timingSafeEqual()` compares the full byte sequences in approximately constant time.

Node requires both buffers to have equal lengths. The length check prevents an exception. JavaScript's `&&` short-circuit behavior means `timingSafeEqual()` is not called when the lengths differ.

#### Express middleware control flow

```js
if (!signaturesMatch(expectedSignature, receivedSignature)) {
  return res.status(401).json({ message: "Invalid signature" });
}

return next();
```

Invalid requests receive `401 Unauthorized`, and `return` prevents further handler execution. Valid requests call `next()`, transferring control to the next function registered on the route.

### `src/controllers/webhook.controller.js`

```js
export function handleGithubWebhook(_req, res) {
  return res.status(200).json({ message: "Webhook verified" });
}
```

The controller runs only after authentication succeeds. `_req` begins with an underscore to indicate that the request argument is required by the handler signature but is intentionally unused in this milestone.

Its response confirms authentication only. Payload parsing and business decisions are intentionally deferred.

## HMAC, hashing, and encryption

A plain cryptographic hash accepts only data:

```text
hash(data)
```

Anyone can calculate it, so it cannot prove who sent the data.

An HMAC combines data with a secret key:

```text
HMAC(secret, data)
```

Only parties possessing the secret can generate the expected value. HMAC provides authenticity and integrity, but not confidentiality. The webhook body is not encrypted; HTTPS is still required to protect it in transit.

## Why the raw body must be used

These JSON documents describe the same object but contain different bytes:

```json
{"message":"hello"}
```

```json
{
  "message": "hello"
}
```

Because HMAC operates on bytes, they produce different signatures. Verification must use the body exactly as GitHub sent it, before JSON parsing or transformation.

## HTTP status behavior

| Condition | Result |
|---|---:|
| Signature header missing | `401` |
| Signature malformed or incorrect | `401` |
| Body changed after signing | `401` |
| Signature matches the exact body | `200` |

The server intentionally returns the same response for different authentication failures. A public endpoint should not provide attackers with unnecessary diagnostic detail.

## Automated test design

The project uses Node's built-in `node:test`, `assert`, `crypto`, and `fetch` functionality. No test framework dependency is required.

The test sets a known test-only secret before dynamically importing the Express application:

```js
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
const { default: app } = await import("../src/app.js");
```

Dynamic import matters because `env.js` reads environment variables when the module is first evaluated. Setting the variable afterward would be too late.

The application listens on port `0` during testing. Port zero asks the operating system to choose an available ephemeral port, which avoids conflicts with development servers and parallel processes. `before()` starts the server, while `after()` closes it so Node can exit cleanly.

These are integration tests rather than isolated unit tests: each request passes through routing, raw-body parsing, middleware, and the controller.

### Test cases

1. A request without `X-Hub-Signature-256` returns `401`.
2. A request with a malformed or incorrect signature returns `401`.
3. A signature calculated from the test secret and exact body returns `200`.
4. A body modified after signing returns `401`.

Current verified result:

```text
tests 4
pass 4
fail 0
```

## Security decisions

- The secret comes from the environment rather than source control.
- There is no insecure fallback secret.
- The external `crypto` package was removed in favor of `node:crypto`.
- Verification uses the exact raw request body.
- Comparison uses `timingSafeEqual()` rather than ordinary equality.
- Missing and differently sized signatures are handled without throwing.
- Authentication executes before controller logic.
- Tests use a fake secret rather than the developer's real secret.

## Current limitations and deliberate boundaries

- The server has not yet checked `X-GitHub-Event`.
- The webhook payload has not yet been parsed as JSON.
- Repository and branch allowlists are not implemented.
- GitHub delivery IDs are not stored or deduplicated.
- There is no request-body size policy beyond the current parser default.
- There is no secret-rotation mechanism supporting old and new secrets simultaneously.
- HTTPS termination and reverse-proxy configuration are deployment concerns for later milestones.
- A valid signature authenticates GitHub but does not automatically authorize a deployment.

These are not accidental omissions. They belong to later milestones and keep Milestone 1 focused on correct authentication.

## Failure scenarios

| Failure | Behavior |
|---|---|
| Secret missing at startup | Process throws an error and does not serve traffic |
| Signature header missing | Request returns `401` |
| Signature has wrong length | Length check returns false; no crypto exception |
| Signature has correct length but wrong bytes | Timing-safe comparison returns false |
| Body changes after signature creation | Recalculated digest differs; request returns `401` |
| Signature is valid | Middleware calls `next()` and controller returns `200` |

## How to explain this milestone in an interview

> I started the CI/CD server by securing its public entry point. GitHub and my server share a high-entropy webhook secret. The route preserves the request as raw bytes because GitHub signs the exact payload representation. My middleware calculates an HMAC-SHA256 digest with Node's built-in crypto module and compares it with the `X-Hub-Signature-256` header using a timing-safe byte comparison. Invalid requests return 401 before reaching controller logic. I verified the complete Express flow with integration tests covering missing, incorrect, correct, and stale signatures.

## Interview questions and answers

### 1. Why does a webhook need authentication?

The endpoint is publicly reachable. Without authentication, anyone who discovers it could submit fabricated events and trigger builds or deployments.

### 2. Why use HMAC instead of a normal hash?

A normal hash has no secret, so anyone can produce it. HMAC incorporates a shared secret and therefore authenticates a sender who possesses that secret while also detecting body modification.

### 3. Does HMAC encrypt the webhook payload?

No. HMAC provides authenticity and integrity, not confidentiality. HTTPS protects the body while it travels over the network.

### 4. Why use SHA-256?

GitHub's modern webhook signature header, `X-Hub-Signature-256`, uses HMAC-SHA256. The server must use the same algorithm and format.

### 5. Why verify the raw request body?

The signature covers exact bytes. Parsing and serializing JSON can change whitespace, escaping, property representation, or encoding, causing a different HMAC even when the logical object is equivalent.

### 6. Why not use `JSON.stringify(req.body)`?

It reconstructs JSON rather than preserving GitHub's original bytes. The reconstructed representation is not guaranteed to match what GitHub signed.

### 7. Why use `timingSafeEqual()`?

Ordinary equality may return as soon as it finds a mismatch, creating timing differences. Timing-safe comparison reduces information leakage about partial matches.

### 8. Why check buffer lengths first?

Node's `timingSafeEqual()` throws when buffer lengths differ. The length check treats malformed signatures as authentication failures and uses short-circuit evaluation to avoid the exception.

### 9. Why return `401` rather than `400`?

The request failed authentication. `400` means malformed request syntax, whereas `401` communicates missing or invalid authentication credentials.

### 10. Why is the secret stored in an environment variable?

Secrets vary by environment and must not be committed with source code. Environment configuration allows development, staging, and production to use different values.

### 11. Why fail during startup if the secret is missing?

Fail-fast behavior makes misconfiguration obvious and prevents the security-sensitive endpoint from running in an undefined or insecure state.

### 12. What is Express middleware?

It is a function receiving `req`, `res`, and `next`. It can modify the request, send a response to stop processing, or call `next()` to continue through the route's handler chain.

### 13. Why separate middleware from the controller?

Authentication is a reusable cross-cutting concern. The controller should assume its caller is authenticated and focus on application decisions. Separation also improves testing and maintainability.

### 14. Why separate `app.js` from `index.js`?

`app.js` constructs the application while `index.js` opens a network listener. Tests can import the app and choose an ephemeral port without starting the production listener as a side effect.

### 15. Are these unit tests or integration tests?

They are integration tests because they issue real HTTP requests and cover Express routing, body parsing, signature middleware, and controller response together.

### 16. Why use port zero in tests?

The operating system selects an available ephemeral port, avoiding collisions with other services and making the tests independent of the developer's machine configuration.

### 17. Does a valid signature mean the application should deploy?

No. It authenticates the payload, but the server must still validate the event type, repository, branch, delivery identity, and project policy before creating a pipeline job.

### 18. What attack does the modified-body test simulate?

It simulates payload tampering or reuse of a valid signature with different content. Because the HMAC covers the body, the old signature cannot authenticate the changed payload.

### 19. How would webhook-secret rotation work?

One approach is a controlled transition where the verifier temporarily accepts signatures produced by either the old or new secret, followed by removal of the old secret. Rotation behavior must be carefully coordinated with GitHub's configured value.

### 20. What comes next?

Milestone 2 parses the authenticated JSON and authorizes only the intended GitHub event, repository, and branch. Authentication must remain before parsing and business logic.

## Milestone completion checklist

- [x] Secret loaded from environment
- [x] Missing secret fails startup
- [x] Raw `application/json` body preserved
- [x] HMAC-SHA256 expected signature calculated
- [x] `sha256=` header format used
- [x] Timing-safe comparison implemented
- [x] Invalid request stopped before controller
- [x] Valid request reaches controller
- [x] Missing-signature test passes
- [x] Incorrect-signature test passes
- [x] Valid-signature test passes
- [x] Modified-body test passes
- [x] Application files pass syntax checks
- [x] Milestone documentation completed
