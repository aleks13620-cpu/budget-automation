# Budget Automation: Project Operating Rules

## Deployment Topology (must check first)

- Production server runs via Docker Compose from `docker-compose.yml`.
- App container image: `ghcr.io/aleks13620-cpu/budget-automation:latest`.
- Production DB is bind-mounted from host path `./database` into container path `/app/database`.
- Effective production DB path inside container: `/app/database/budget_automation.db`.
- Local development DB may differ from production data and must not be assumed equal.

## Mandatory Preflight Before Debugging

Run these checks before any data diagnosis or "missing data" conclusions:

1. Confirm target environment:
   - Local (`localhost:3001`) or production (`5.42.103.63:3001`).
2. Confirm runtime mode:
   - `docker compose ps` (containerized prod), or
   - `npm run dev` / direct node process (local dev).
3. Confirm DB source:
   - If Docker: trust compose volume mapping in `docker-compose.yml`.
   - If local dev: trust `backend/.env` and `backend/src/database/connection.ts`.
4. Confirm active API identity:
   - `curl -s http://<host>:3001/api/projects` and compare expected projects.

Do not run deep SQL diagnostics until all 4 checks are done.

## Production Deploy Checklist

1. Ensure commit is pushed to GitHub.
2. On server:
   - `cd ~/budget-automation` (or actual project path),
   - `docker compose ps`.
3. Pull image:
   - `docker compose pull`.
4. Restart:
   - `docker compose up -d`.
5. Verify:
   - `docker compose ps`,
   - `curl -s http://localhost:3001/api/health`.

## GHCR Authentication Checklist

If `docker compose pull` returns `error from registry: denied`:

1. Authenticate Docker to GHCR on server:
   - `docker login ghcr.io -u <github-username>`
   - password must be a GitHub PAT token with `read:packages` scope.
2. Retry:
   - `docker compose pull && docker compose up -d`.

## Safety Rules

- Never assume production uses local DB file state.
- Never assume `pm2` if app is Dockerized.
- Never expose passwords/tokens in chat logs; enter them directly in terminal prompts.
