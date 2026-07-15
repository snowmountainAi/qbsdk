# @qwikbuild/qbsdk-deployment

Deployment tools for QwikBuild projects. Deploys Vercel backend servers, frontend applications, and cron/communication templates.

## Installation

```bash
# From GitHub release
npm install https://github.com/snowmountainAi/qbsdk/releases/download/deployment-v1.0.0/qbsdk-deployment-1.0.0.tgz

# Or add to package.json
"@qwikbuild/qbsdk-deployment": "https://github.com/snowmountainAi/qbsdk/releases/download/deployment-v1.0.0/qbsdk-deployment-1.0.0.tgz"
```

## Commands

### qb-deploy-server

Deploys the Hono backend to Vercel using the Vercel SDK (experimental backends / cervel).

```bash
npx qb-deploy-server
```

**What it does:**
1. Resolves the backend directory (`backend/` by default)
2. Builds the backend with `cervel` and collects deployment files
3. Syncs environment variables from `backend/.env` to the Vercel project
4. Creates a production deployment via the Vercel API
5. Polls until the deployment is ready
6. Registers the deployment URL with the QwikBuild platform

**Options:**
- `-n, --name <name>` — deployment / project name (default: random UUID)
- `-d, --domain <domain>` — custom domain to attach to the Vercel project
- `-p, --project <id>` — existing Vercel project ID
- `-r, --regions <list>` — comma-separated Function regions (default: `sin1`)
- `--skip-platform` — skip QwikBuild platform URL registration

**Required environment variables:**
- `VERCEL_TOKEN` — Vercel API token
- `VITE_API_BASE_URL` — QwikBuild platform API URL
- `VITE_APP_ID` — Application ID
- `DATABASE_URL` — PostgreSQL connection string (in `backend/.env` or shell)
- `APP_JWT_SECRET` — JWT secret for the backend

**Optional environment variables:**
- `VERCEL_TEAM_ID` — Vercel team ID
- `VERCEL_PROJECT_ID` / `DEPLOY_FILES_PROJECT_ID` — existing Vercel project ID
- `VERCEL_REGIONS` — comma-separated Function regions (Pro: up to 3)
- `BACKEND_DIR` — backend folder name (default: `backend`)
- `VERCEL_DEPLOYMENT_NAME`, `VERCEL_DOMAIN` — defaults for CLI flags

### qb-deploy-frontend

Builds the frontend and deploys it via the AgentQ backend. The backend handles S3 upload and platform notification, so no CDN credentials are needed on the CLI side.

```bash
# Default: uploads only the dist/ folder (smallest upload)
npx qb-deploy-frontend

# Full mode: uploads entire project source + dist
npx qb-deploy-frontend --full
```

**What it does:**
1. Detects package manager (pnpm > npm > yarn) and build script
2. Runs the frontend build
3. Creates a tar.gz archive of the output
4. Uploads the archive to the AgentQ backend
5. Backend extracts, uploads to S3, and notifies the platform

**Modes:**
- **Default (dist-only):** Archives only the `dist/` folder. Smallest possible upload.
- **`--full`:** Archives the entire project (excluding node_modules, .git, .env, lock files). Use when the backend needs full source code.

**Build script detection priority:** `frontend:build` > `build:prod` > `build:production`

**Required environment variables:**
- `AGENTQ_API_URL` - AgentQ backend base URL (including `/api` prefix, e.g. `https://your-domain.com/api`)
- `URL_SLUG` - Project URL slug
- `QWIKBUILD_PLATFORM_API_KEY` - API key for backend authentication

### qb-deploy-cron-and-comms

Deploys cron jobs and communication templates from backend configuration.

```bash
npx qb-deploy-cron-and-comms
```

**What it does:**
1. Loads `CONFIG` from `backend/src/cron_n_comm_config.ts`
2. Deploys cron job schedules to the platform
3. Submits communication templates for approval

**Required environment variables:**
- `VITE_API_BASE_URL` - QwikBuild platform API URL
- `VITE_APP_ID` - Application ID
- `QWIKBUILD_PLATFORM_API_KEY` - Platform API key

## Requirements

- Node.js >= 18
- Environment variables set (via `.env` file or shell)
- For `qb-deploy-server`: Vercel account and token; backend built with cervel (via `vercel` devDependency in the backend)
- For `qb-deploy-frontend`: AgentQ backend URL and API key
- For `qb-deploy-cron-and-comms`: `backend/src/cron_n_comm_config.ts` with exported `CONFIG`

## Project Structure Expected

```
project/
├── .env                           # Environment variables
├── backend/                       # Vercel/Hono backend (used by qb-deploy-server)
│   ├── src/
│   │   ├── main.ts                # Hono entry point
│   │   └── cron_n_comm_config.ts  # Cron/comms config
│   ├── package.json
│   ├── package-lock.json
│   ├── vercel.json
│   └── .env
├── frontend/
│   └── ...                        # Frontend source
├── shared/                        # Shared code (deployed with server)
├── dist/                          # Built frontend output
└── package.json
```

## License

Apache-2.0
