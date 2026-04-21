# Deploy Runbook

This file is the practical runbook for deploying `budget-automation` and avoiding environment confusion.

## 0) What Is Running In Production

- Production host: `5.42.103.63`
- Runtime: Docker Compose
- Service: `app`
- Image: `ghcr.io/aleks13620-cpu/budget-automation:latest`
- API port: `3001`
- Health endpoint: `http://5.42.103.63:3001/api/health`

From `docker-compose.yml`:
- Host DB folder: `./database`
- Container DB folder: `/app/database`
- Effective DB file in container: `/app/database/budget_automation.db`

## 1) Standard Deploy (Preferred)

Run on server in project directory:

```bash
cd ~/budget-automation
git pull origin main
docker compose ps
docker compose pull
docker compose up -d
docker compose ps
curl -s http://localhost:3001/api/health
```

Expected:
- `docker compose ps` shows `app` as `Up`
- `/api/health` returns `"status":"ok"`

## 2) If `docker compose pull` Fails With `denied`

Symptom:
- `error from registry: denied`

Reason:
- Server Docker is not authenticated to GHCR, or token has insufficient permissions.

Fix:

```bash
docker login ghcr.io -u <github-username>
```

Use a GitHub PAT token as password with at least:
- `read:packages`

Then retry:

```bash
docker compose pull
docker compose up -d
```

## 3) Fast Verification For QA

After deploy, verify both infra and feature behavior:

```bash
curl -s http://localhost:3001/api/health
curl -s http://localhost:3001/api/projects | head
docker compose logs --tail=120 app
```

For training-mode fix verification:
- Import XLS in "Обучение"
- Confirm response has fields:
  - `newRules`
  - `updatedRules`
  - `processedPairs`
  - `invoiceColumnsUsed`
- Run matching and verify coverage increases (not stuck at previous behavior).

## 4) Alternative Deploy Strategy A (Build On Server)

Use this if GHCR access is unstable and source code is present on server.

1. Ensure compose has `build:` for `app` (or use override file).
2. Build and restart:

```bash
git pull origin main
docker compose up -d --build
docker compose ps
```

Pros:
- No dependency on GHCR pull.

Cons:
- Slower deploy, build toolchain required on server.

## 5) Alternative Deploy Strategy B (Release Tags)

Use immutable tags instead of `latest`.

Flow:
1. Build/push image with version tag (example: `v2026.04.14-1`).
2. Update `docker-compose.yml` image to that tag.
3. `docker compose pull && docker compose up -d`.

Pros:
- Reproducible rollbacks.
- Clear "what version is in prod".

Cons:
- Requires disciplined release process.

## 6) Rollback Procedure (If Needed)

If latest deploy is unhealthy:
1. Switch compose image to previous known-good tag.
2. Run:

```bash
docker compose pull
docker compose up -d
docker compose ps
curl -s http://localhost:3001/api/health
```

## 7) Preflight Checklist (Mandatory Before Debugging Data Issues)

Before concluding "data is missing" or "old code is running", always check:
1. Which environment is used (`localhost` vs `5.42.103.63`)?
2. Is runtime Docker or local node process?
3. Which DB path is active?
4. Does `/api/projects` match expected project names?

Skipping this checklist leads to false diagnostics.
