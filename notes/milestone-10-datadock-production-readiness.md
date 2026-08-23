# Milestone 10: DataDock Production Readiness

## Goal

Connect the generic CI/CD engine to DataDock's real EC2 runtime with versioned releases, protected shared environments, atomic activation, PM2 reload, health verification, and rollback—while keeping the legacy installation available as a recovery path.

## Verified production facts

- EC2 instance: `datadock-production`
- Instance ID: `i-046fd3434efff4f37`
- Private IPv4: `172.31.9.177`
- Legacy recovery root: `/var/www/datadock`
- Active release root: `/var/www/datadock-deploy/current`
- Branch: `main`
- Node.js: `22.23.2`
- npm: `10.9.8`
- PM2 processes: `datadock-client`, `datadock-server`
- Client working directory: `/var/www/datadock-deploy/current/client`
- Server working directory: `/var/www/datadock-deploy/current/server`
- Shared client environment: `/var/www/datadock-deploy/shared/client.env.production`
- Shared server environment: `/var/www/datadock-deploy/shared/server.env`
- Nginx frontend upstream: `127.0.0.1:3000`
- Nginx API upstream: `127.0.0.1:4000`
- Health endpoint: `https://api.datadock.me/health`

Public IPs are deliberately not embedded in project configuration. The CI server should use private VPC connectivity when possible.

## Target release layout

```text
/var/www/datadock-deploy/
├── releases/
│   └── <job-uuid>/
│       ├── client/
│       └── server/
├── shared/
│   ├── client.env.production
│   └── server.env
└── current -> releases/<active-job-uuid>
```

The existing `/var/www/datadock` directory remains unchanged during initial setup and first-release verification.

## Remote deployment script

`deploy/datadock/cicd-deploy` is installed as:

```text
/usr/local/bin/cicd-deploy
```

It uses:

```bash
set -Eeuo pipefail
umask 027
```

Strict Bash mode stops on errors, unset variables, and pipeline failures. The restrictive umask prevents newly created deployment files from becoming world-writable.

### `prepare`

```text
cicd-deploy prepare <job-id>
```

- Validates UUID v4.
- Refuses an existing release.
- Creates the release directory with restricted permissions.

### `activate`

```text
cicd-deploy activate <job-id> <commit-sha>
```

- Validates UUID and SHA.
- Requires client `.next`, package files, and the server entry point.
- Requires shared environment files.
- Verifies Git `HEAD` when `.git` metadata is present.
- Links shared environment files into the release.
- Atomically switches `current` using a temporary symlink and `mv -T`.
- Reloads PM2 from the ecosystem file.
- Saves PM2 state for reboot recovery.
- Restores the prior link if PM2 activation itself fails.

### `rollback`

```text
cicd-deploy rollback <failed-job-id> <previous-job-id>
```

- Validates both UUIDs.
- Requires the previous release directory.
- Atomically switches `current`.
- Reloads and saves PM2.
- Leaves public health verification to the CI runner.

## PM2 ecosystem configuration

`datadock.ecosystem.config.cjs` keeps the stable process names Nginx already depends on indirectly through ports:

- `datadock-server`
- `datadock-client`

Both working directories point through `/var/www/datadock-deploy/current`. Therefore, changing the symlink and reloading PM2 activates a versioned release without editing Nginx.

The ecosystem invokes the absolute Node binary directly for both applications. It does not use `npm run start`, because npm and package shebangs depend on `node` being present in a shell `PATH`; non-interactive PM2 automation must not rely on NVM shell initialization.

## Protected environments

Production runtime secrets are copied once into the shared directory with permission `600`. They are never committed and never stored in the healthy-release registry.

The Next.js test/build stage can load a separate CI-side file through:

```dotenv
DATADOCK_CLIENT_BUILD_ENV_FILE=/etc/custom-cicd/datadock-client-build.env
```

The stage runner parses this protected file and passes values only as child-process environment variables. It does not copy the file into the Git workspace or release. Sensitive values are included in command-output redaction.

The backend runtime `.env` stays only on production because server dependency installation requires no runtime secrets.

## CI server service

`deploy/ci-server/custom-cicd.service` runs the application as a dedicated `cicd` user, loads protected configuration from `/etc/custom-cicd`, restarts only on failure, and restricts filesystem writes to `/var/lib/custom-cicd`.

The Nginx template publicly proxies only:

```text
POST /webhook/github
```

All other routes return `404`. This keeps the unauthenticated job-details API off the public internet.

TLS must be configured before registering the production GitHub webhook.

## Production configuration

The relevant SSH values are:

```dotenv
DEPLOYMENT_TYPE=ssh
SSH_HOST=172.31.9.177
SSH_USER=cicd-deploy
SSH_REMOTE_DEPLOY_DIR=/var/www/datadock-deploy/releases
SSH_REMOTE_DEPLOY_SCRIPT=/usr/local/bin/cicd-deploy
HEALTH_CHECK_URL=https://api.datadock.me/health
ROLLBACK_ENABLED=true
```

The private IP is appropriate only when the CI EC2 and production EC2 have private VPC connectivity. Otherwise, routing must be designed explicitly rather than silently falling back to unrestricted public SSH.

## Production installation performed

The following human-reviewed installation was completed on August 23, 2026:

1. Back up or snapshot production.
2. Install the remote script and ecosystem file.
3. Create release/shared directories owned by the deployment user.
4. Copy existing environment files into the shared directory without printing them.
5. Configure a dedicated CI SSH key and strict `known_hosts` entry.
6. Put both EC2 instances in an appropriate private-network/security-group relationship.
7. Install the CI server as a systemd service.
8. Configure HTTPS Nginx for the webhook-only route.
9. Add the GitHub webhook URL and matching secret.
10. Run a controlled first release.
11. Verify API health, frontend response, PM2 status, and logs.
12. Preserve the legacy directory until rollback behavior is demonstrated.

The dedicated CI host runs Ubuntu 26.04 LTS at private IP `172.31.1.34`. The public webhook is `https://cicd.datadock.me/webhook/github`, protected by TLS, raw-body HMAC verification, event/repository/branch validation, and an Nginx exact-path rule. The CI service connects to production through private VPC networking as `cicd-deploy` with a dedicated Ed25519 key and pinned host key.

## Verified production evidence

- GitHub push delivery was accepted and persisted as a pipeline job.
- A stale DataDock mock-service test failed safely at `client:test`; production was not modified.
- After removing that obsolete test, all 24 current DataDock client tests passed.
- Server and client dependency installation completed with zero reported vulnerabilities.
- The Next.js 16.3.1 production build completed successfully.
- A deployment permission failure stopped before switching `current`, demonstrating fail-closed behavior.
- The first healthy CI-managed release was job `7192a5b5-74a1-41cf-a2e3-fc33472a0132`.
- The second healthy release was job `a05b89ed-3b19-4903-afbb-f3a6ea3213a0`.
- Public API health passed after two attempts for both successful pipeline runs.
- PM2 runs `datadock-server` and `datadock-client` as `ubuntu` through `/var/www/datadock-deploy/current`.
- Email delivered both failed-stage and successful-deployment results from `cicd@mail.datadock.me`.
- Manual rollback atomically moved `current` from `a05b89ed-3b19-4903-afbb-f3a6ea3213a0` to `7192a5b5-74a1-41cf-a2e3-fc33472a0132`; the API remained healthy and the frontend returned HTTP 200.
- Forward reactivation returned `current` to `a05b89ed-3b19-4903-afbb-f3a6ea3213a0` and health remained successful.

The initial PM2 migration exposed an important operational lesson: a long-running daemon does not inherit Linux group changes made after it starts, and `npm` wrappers can fail when NVM is absent from a non-interactive `PATH`. Restarting PM2 once after the group change and invoking absolute Node commands made the runtime deterministic.

## First-release caveat

Automatic rollback requires a previous release recorded by this CI server as healthy. The existing manually deployed directory is not automatically inserted into that registry.

Therefore, the first versioned cutover requires an explicit recovery plan using the preserved `/var/www/datadock` installation. After the first CI-managed release passes health, subsequent releases have an automatic known-good rollback target.

## Security decisions

- Administrator `.pem` keys must not be committed or copied into the project.
- Prefer a dedicated CI deployment key over reusing a personal production key.
- Restrict production SSH ingress to the CI security group/private network.
- Keep strict host checking and a pinned `known_hosts` file.
- Keep runtime secrets outside immutable releases.
- Validate every release identifier and commit.
- Refuse release overwrites.
- Use atomic activation links.
- Revert the activation link if PM2 reload fails.
- Verify public health after activation and rollback.
- Keep Nginx routing stable.
- Preserve the legacy installation during initial migration.

## Resume-ready explanation

> For my production DataDock deployment, I designed an Ubuntu-to-Ubuntu release workflow. The CI server builds an exact Git commit, then uploads it to a UUID release directory on EC2. A preinstalled strict Bash script validates the artifact and commit, links protected shared environments, atomically switches a current symlink, and reloads the existing PM2 process names, so Nginx configuration stays stable. The CI runner verifies the public API health endpoint. Only healthy releases enter the rollback registry; an unhealthy deployment restores the previous UUID release and verifies health again. I also separated the client build environment from production runtime secrets and exposed only the raw-body-verified webhook through Nginx.

## Expected interview questions

### Why keep environment files in a shared directory?

Secrets should survive releases without being copied from Git or duplicated into versioned source trees. Symlinks provide stable protected runtime configuration.

### Why use an atomic symlink?

It changes the active release in one filesystem operation, avoiding a partially copied live directory and making rollback a pointer switch.

### Why keep PM2 process names unchanged?

Operational monitoring and Nginx upstream ports remain stable. Only the process working directory moves through the current-release link.

### Why use absolute NVM paths?

Non-interactive SSH sessions may not load `.bashrc` or initialize NVM. Absolute paths make remote automation deterministic.

### What happens if PM2 activation fails?

The remote script restores the prior current link and attempts to reload it before returning a failure to the CI runner.

### Why verify through the public domain?

It exercises DNS, TLS, Nginx, the application port, and application startup rather than checking only whether a local process exists.

### Why preserve the old deployment?

The first CI-managed release has no previous healthy registry entry. The old installation provides a human-controlled recovery path during migration.

### Why not use DataDock's private S3 bucket for deployment?

It stores user objects under a separate security boundary. DataDock is a dynamic Next.js/Express application running on EC2, so SSH release activation is the correct adapter.

## Completion checklist

- [x] Real production paths and process names documented.
- [x] DataDock remote prepare/activate/rollback script implemented.
- [x] UUID and commit validation implemented.
- [x] Versioned release layout implemented.
- [x] Shared environment strategy implemented.
- [x] Atomic current-release switching implemented.
- [x] PM2 reload and activation recovery implemented.
- [x] DataDock PM2 ecosystem configuration implemented.
- [x] CI systemd unit template implemented.
- [x] Webhook-only Nginx template implemented.
- [x] Complete safe environment template implemented.
- [x] Stage-specific client build environment implemented.
- [x] Deployment assets covered by tests.
- [x] Resume-ready root README implemented.
- [x] Human-reviewed installation on production EC2.
- [x] First controlled production cutover.
- [x] Second automatic versioned release.
- [x] Public frontend and API health verification.
- [x] Email success and failure notification delivery.
- [x] Rollback to the previous release and forward reactivation.

Milestone 10 is complete. The software, infrastructure integration, controlled production deployment, health verification, notification delivery, rollback, and forward recovery were all exercised against DataDock production.
