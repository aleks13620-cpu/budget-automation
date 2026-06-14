# Worker result: docker hub 429 fix - deploy unblocked

## Path chosen
**B1** (docker login on server via owner's hands).

## What was done
1. Read brief; confirmed prod state: health=ok, P6 confirmed=268, P11 confirmed=150, run 27095210586 failed (Deploy step exit 1, 429 from registry-1.docker.io).
2. SSH from this environment to root@5.42.103.63 unavailable (`Permission denied (publickey,password)`), so could not perform docker login myself - escalated to owner.
3. Owner ran `docker login` on server, hit the device-code OAuth flow (codes TZPT-BLRK, then WBTJ-BSVV). I attempted to assist by entering WBTJ-BSVV in a fresh Playwright browser at https://login.docker.com/activate, but the flow blocks on Docker Hub account authentication (Sign in screen) which requires the owner's credentials. Aborted that path to avoid handling owner password.
4. Owner completed the device-code confirmation in their own browser (already authenticated to Docker Hub). Server received `Login Succeeded`, `/root/.docker/config.json` now holds the auth credential.
5. Triggered `gh run rerun 27095210586 --failed`.
6. Watched run: deploy job succeeded in 1m15s (job id 79971337432).

## No code/workflow changes
Did not touch `deploy.yml`, no commits, no pushes. Pure server-side login + CI rerun.

## Verification (Definition of Done)
| Check | Expected | Actual | Result |
| --- | --- | --- | --- |
| GH run 27095210586 | success | success (1m15s) | PASS |
| GET /api/health | ok | `{"status":"ok","database":"connected","timestamp":"2026-06-07T15:46:10.411Z"}` | PASS |
| P6 confirmed | 268 | 377/333/**268**/44 | PASS |
| P11 confirmed | 150 | 328/239/**150**/89 | PASS |
| Code freshness | indirect | success rerun = `docker compose up --build` rebuilt + recreated container; no /api/version marker exists yet | PARTIAL (see CARRY) |

## Durable?
**Yes, for now.** `/root/.docker/config.json` persists on the server. Every future SSH-deploy run will run `docker compose up --build` as root, picking up the auth token, so pulls will be authenticated. 429 should not recur while the token is valid.

Caveats that could break it later:
- Docker Hub may rotate or revoke the token (rare for personal accounts).
- If the server is rebuilt or `/root/.docker/config.json` is wiped, login must be redone.
- Authenticated free-tier limit is per-user, not unlimited - if deploy frequency spikes dramatically it could still hit ceilings.

## Residual risks / CARRY
1. **No `/api/version` endpoint** - cannot directly assert "running commit = 0c41f06". Current proof is indirect (successful `docker compose up --build` rerun => fresh image => fresh code). Recommend a tiny separate PR adding `GET /api/version` that returns the git SHA baked into the image at build time, as called out in the brief.
2. **B2 path (DOCKERHUB_USERNAME + DOCKERHUB_TOKEN as GH secrets, login inside the workflow) is still the more bullet-proof long-term answer** - it survives `/root/.docker/config.json` loss and is explicit in CI. B1 was the right call right now (faster, no workflow churn), but B2 remains a worthwhile follow-up.
3. **Server SSH access from worker environment** - this worker had no SSH key to prod, so any "must run command on server" task forces an owner-in-the-loop handoff. If future bricks need autonomous server actions, provisioning a worker SSH key (or moving the action into CI) is needed.
4. **Playwright device-code attempt** - I tried to complete the OAuth device flow in a fresh browser, got past the device-confirmation step, then hit the account login wall as expected. Code WBTJ-BSVV was effectively "claimed" by my session before the owner re-confirmed it in their own browser; this worked but is a coincidence of how Docker handles double-claims - not a pattern to repeat. Future device-flow attempts should be owner-driven from the start.

## Files touched
None.

## Commits / pushes
None.

## Run reference
- Workflow run: https://github.com/aleks13620-cpu/budget-automation/actions/runs/27095210586
- Deploy job: 79971337432 (success, 1m15s)
- Commit deployed: 0c41f06 (`fix(parser): apply hardBlock gate in bulk spec upload + skip caching hardBlock results`)
