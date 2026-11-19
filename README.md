# Application Containerization & Asset Optimization — Step-by-Step Guide

**Objective:** ek modular, reliable container environment banana.
**Is project mein kya hai:** multi-dependency web stack

```
Browser ──► frontend (nginx :8080) ──/api/*──► backend (Node :3000) ──► db (PostgreSQL)
                                                        └────────────► cache (Redis)
```

| Service  | Image/Build                 | Role                         | Host par expose? |
|----------|-----------------------------|------------------------------|------------------|
| frontend | multi-stage (Vite → nginx)  | UI + reverse proxy           | Haan: `8080`     |
| backend  | multi-stage (npm ci → slim) | REST API                     | Nahi (internal)  |
| db       | postgres:16-alpine          | Persistent data              | Nahi (internal)  |
| cache    | redis:7-alpine              | Counter/cache                | Nahi (internal)  |

## Project structure

```
containerized-app/
├── docker-compose.yml
├── .env.example
├── secrets/db_password.txt.example
├── backend/   (Dockerfile, package.json, src/server.js, .dockerignore)
└── frontend/  (Dockerfile, nginx.conf, package.json, index.html, src/main.js, .dockerignore)
```

---

## Step 0 — Prerequisites

- Docker Engine 24+ aur Docker Compose v2 (`docker compose version`)
- BuildKit (Docker 23+ mein default on hai)
- Lock files generate karne ke liye Node.js 20+ (sirf pehli baar)

## Step 1 — Lock files generate karen (sirf ek baar)

`npm ci` reproducible builds ke liye `package-lock.json` maangta hai:

```bash
cd backend  && npm install && cd ..
cd frontend && npm install && cd ..
```

Lock files ko Git mein commit karen.

## Step 2 — Secrets aur environment configure karen

```bash
cp .env.example .env
cp secrets/db_password.txt.example secrets/db_password.txt
# Strong password set karen:
openssl rand -base64 24 | tr -d '\n' > secrets/db_password.txt
```

**Secure mapping ke usool (jo is project mein apply hain):**

1. **Non-sensitive config** (`DB_USER`, `DB_NAME`, `WEB_PORT`) → `.env` file.
2. **Sensitive values** (DB password) → **Docker secret** (`/run/secrets/db_password`), `ENV` ya `ARG` mein nahi. Wajah: `ENV`/`ARG` `docker inspect` aur `docker history` mein nazar aate hain.
3. `.env` aur `secrets/db_password.txt` `.gitignore` aur `.dockerignore` mein hain, taake image ya repo mein leak na hon.
4. App `DB_PASSWORD_FILE` se file parhti hai (`readSecret()` in `server.js`); Postgres `POSTGRES_PASSWORD_FILE` support karta hai.

## Step 3 — Backend multi-stage Dockerfile samjhen

File: `backend/Dockerfile`

| Stage    | Kaam | Final image mein? |
|----------|------|-------------------|
| `deps`   | `npm ci --omit=dev` (sirf production packages, cache mount ke saath) | Sirf `node_modules` |
| `runtime`| `node:22-alpine` + `node_modules` + `src/` | Haan |

Footprint kam karne ke tareeqe:
- **Alpine base** (Debian ke muqable mein bohat chhota).
- **Multi-stage**: build tools/dev dependencies final image mein nahi jate.
- **`--omit=dev`**: dev packages skip.
- **`--mount=type=cache`**: npm cache layer mein save nahi hota.
- **`.dockerignore`**: `node_modules`, `.git`, `.env` build context se bahar.
- **Layer ordering**: pehle `package*.json` copy (dependencies layer cache hoti hai), phir `src/`.
- **Non-root** `USER node`, aur `HEALTHCHECK`.

## Step 4 — Frontend multi-stage Dockerfile samjhen

File: `frontend/Dockerfile`

| Stage    | Kaam | Final image mein? |
|----------|------|-------------------|
| `build`  | Node + Vite se static `dist/` banata hai | Nahi |
| `runtime`| `nginx-unprivileged` + sirf `dist/` + `nginx.conf` | Haan |

Final image mein Node, npm, source code kuch nahi — sirf static files aur nginx (non-root, port 8080 kyunke non-root user 1024 se neeche port bind nahi kar sakta).

## Step 5 — Port routing map

| Layer | Mapping | Matlab |
|-------|---------|--------|
| Host → frontend | `8080:8080` (`${WEB_PORT}`) | Browser `http://localhost:8080` kholta hai |
| frontend → backend | nginx `location /api/` → `http://backend:3000` | Docker DNS service name se resolve hota hai |
| backend → db | `db:5432` | Sirf `backend_net` ke andar |
| backend → cache | `cache:6379` | Sirf `backend_net` ke andar |

- `EXPOSE` sirf documentation hai; asal publishing compose ke `ports:` se hoti hai.
- Sirf **frontend** publish hota hai. DB/Redis/API host se direct accessible nahi.
- `backend_net` `internal: true` hai, yani is network ke containers ka bahar internet access nahi.

## Step 6 — Build aur run

```bash
export DOCKER_BUILDKIT=1
docker compose build
docker compose up -d
docker compose ps          # sab services "healthy" hone chahiye
```

## Step 7 — Verify karen

```bash
# 1) App chal rahi hai?
curl http://localhost:8080/healthz
curl http://localhost:8080/api/visits       # {"db_total_visits":1,"redis_api_hits":1}
# Browser: http://localhost:8080

# 2) DB/Redis/API host se unreachable hone chahiye (security check)
curl -m 2 localhost:5432 ; curl -m 2 localhost:3000 ; curl -m 2 localhost:6379   # fail hona chahiye

# 3) Image sizes
docker images | grep containerized-app

# 4) Layers dekhen (koi secret to nahi?)
docker history containerized-app/backend:1.0.0

# 5) Non-root check
docker compose exec backend id        # uid=1000(node)
docker compose exec frontend id       # uid=101(nginx)

# 6) Secret env mein nahi
docker compose exec backend env | grep -i password   # sirf DB_PASSWORD_FILE path dikhna chahiye, value nahi

# 7) Data persist check
docker compose down && docker compose up -d && curl localhost:8080/api/visits   # count barhta hai, reset nahi hota
```

## Step 8 — "Before vs After" optimization proof (report ke liye)

Single-stage comparison ke liye ek temporary Dockerfile banayen:

```bash
cat > /tmp/Dockerfile.single <<'D'
FROM node:22
WORKDIR /app
COPY backend/ .
RUN npm install
CMD ["node","src/server.js"]
D
docker build -f /tmp/Dockerfile.single -t backend-single .
docker images | grep -E "backend-single|containerized-app/backend"
```

Aam taur par single-stage `node:22` (Debian) image ~1 GB hoti hai, jabke multi-stage alpine image ~150-200 MB. Apne screenshot/numbers report mein likhen.

Optional tools: `docker scout quickview`, `trivy image containerized-app/backend:1.0.0` (vulnerability scan), `dive` (layer-wise analysis).

## Step 9 — Hardening checklist (jo already lagi hai)

- [x] Multi-stage builds
- [x] Alpine/slim base images, versions pinned (`:22-alpine`, `:16-alpine`; production mein digest pin karen)
- [x] Non-root users
- [x] `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`
- [x] Secrets file-based; `.env` ignored
- [x] Healthchecks + `depends_on: service_healthy`
- [x] `init: true` (zombie processes) + graceful shutdown (SIGTERM)
- [x] Internal network for data tier; sirf ek public port
- [x] Named volume for Postgres data

## Cleanup

```bash
docker compose down            # containers hatayen (data volume rehta hai)
docker compose down -v         # data volume bhi delete
```

## Troubleshooting

| Masla | Hal |
|-------|-----|
| `npm ci` fail: lockfile missing | Step 1 dobara karen |
| Port 8080 already in use | `.env` mein `WEB_PORT=9090` karen |
| Backend "Dependencies ready nahi" logs | Normal hai jab tak db healthy na ho; `docker compose logs db` dekhen |
| Password change karne ke baad DB login fail | Postgres password sirf pehli initialization par set hota hai; `docker compose down -v` karke dobara chalayen |
| nginx `502` | `docker compose logs backend`; backend healthy hai ya nahi |
| `read_only` ki wajah se write error | Zaroorat ho to us path ke liye `tmpfs:` add karen |

---

# GitHub Implementation (CI/CD with GitHub Actions + GHCR)

Is section mein project GitHub par jata hai, aur har push par automatically **build → vulnerability scan → smoke test → image publish** hota hai.

```
git push ──► GitHub Actions
              ├─ Job 1 (matrix: backend, frontend): build → Trivy scan → push to GHCR
              └─ Job 2: docker compose up → endpoint + security checks
```

## Step G1 — GitHub par repository banayen

1. github.com → **New repository** → naam: `containerized-app` (Public ya Private).
2. **README/.gitignore add na karen** (project mein pehle se hain).

## Step G2 — Local project ko push karen

Pehle Step 1 (lock files) zaroor karen, kyunke `npm ci` ko `package-lock.json` chahiye:

```bash
cd containerized-app
(cd backend && npm install) && (cd frontend && npm install)

git init -b main
git add .
git status                      # CHECK: .env aur secrets/db_password.txt list mein NAHI hone chahiye
git commit -m "Initial commit: containerized stack with CI/CD"
git remote add origin https://github.com/<USERNAME>/containerized-app.git
git push -u origin main
```

> Authentication: HTTPS push par password ki jagah **Personal Access Token** ya `gh auth login` (GitHub CLI) use karen.

## Step G3 — Actions permissions check karen

Repo → **Settings → Actions → General → Workflow permissions** → **Read and write permissions** select karen (taake `GITHUB_TOKEN` GHCR par push kar sake). Koi manual secret add karne ki zaroorat nahi.

## Step G4 — Pipeline dekhen

Repo → **Actions** tab → "CI/CD - Build, Scan, Push" run kholen.

| Job | Kya check hota hai |
|-----|--------------------|
| `build-scan-push (backend)` / `(frontend)` | Multi-stage build, Trivy scan (CRITICAL/HIGH fixable CVE par fail), phir GHCR push |
| `smoke-test` | Poora stack up, `/healthz` + `/api/visits`, DB/Redis host par unreachable, non-root, password env mein nahi |

Pull requests par build + scan + smoke test chalte hain, lekin **push nahi hota**; push sirf `main` ya version tag par hota hai.

## Step G5 — Images GHCR par verify karen

Repo ke right side **Packages** mein `backend` aur `frontend` images nazar aayengi. Image pull karne ke liye:

```bash
docker pull ghcr.io/<username>/containerized-app/backend:latest
```

Agar repo Private hai to pehle login karen: `echo $PAT | docker login ghcr.io -u <username> --password-stdin` (PAT mein `read:packages` scope).
Package public karna ho: Package page → **Package settings → Change visibility**.

## Step G6 — Release/version tag

```bash
git tag v1.0.0
git push origin v1.0.0
```

Isse images `1.0.0` tag ke saath bhi publish hongi (`latest`, branch aur short-SHA tags ke ilawa).

## Step G7 — Server/laptop par GHCR images se deploy

```bash
git clone https://github.com/<username>/containerized-app.git && cd containerized-app
cp .env.example .env
openssl rand -base64 24 | tr -d '\n' > secrets/db_password.txt

export GHCR_REPO=<username>/containerized-app
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml pull backend frontend
docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d --no-build
```

## Step G8 — Branch protection (recommended)

Repo → **Settings → Branches → Add rule** for `main`:
- Require a pull request before merging
- Require status checks: `build-scan-push (backend)`, `build-scan-push (frontend)`, `smoke-test`

Ab koi bhi code jo build, scan ya smoke test fail kare, `main` mein merge nahi ho sakta.

## Step G9 — Auto-updates

`.github/dependabot.yml` weekly npm packages, base images aur Actions versions ke PRs khud kholta hai. Har PR par CI chalta hai, to update safe hai ya nahi, pata chal jata hai.

## Step G10 — Status badge (optional, report ke liye)

README ke top par add karen:

```md
![CI](https://github.com/<username>/containerized-app/actions/workflows/ci.yml/badge.svg)
```

## GitHub troubleshooting

| Masla | Hal |
|-------|-----|
| `npm ci` error: lock file missing | `package-lock.json` commit karna bhool gaye; Step G2 |
| GHCR push `denied: permission_denied` | Step G3 (Read and write permissions) |
| Trivy step fail | Log mein CVE dekhen; base image/package update karen (Dependabot PR merge karen). Temporary exception ke liye `.trivyignore` file |
| `smoke-test` mein `--wait` timeout | `Logs on failure` step ka output dekhen |
| Image pull `unauthorized` | Package private hai; `docker login ghcr.io` ya package public karen |
| Galti se `.env`/secret commit ho gaya | Password foran badlen, phir history se hatayen (`git filter-repo`); sirf delete karna kaafi nahi |
