# @qwikbuild/qbsdk-deployment

Deployment tools for QwikBuild projects. Deploys Deno backend servers, frontend applications (build + S3 sync), and cron/communication templates.

## Installation

```bash
# From GitHub release
npm install https://github.com/snowmountainAi/qbsdk/releases/download/deployment-v1.0.0/qbsdk-deployment-1.0.0.tgz

# Or add to package.json
"@qwikbuild/qbsdk-deployment": "https://github.com/snowmountainAi/qbsdk/releases/download/deployment-v1.0.0/qbsdk-deployment-1.0.0.tgz"
```

## Commands

### qb-deploy-server

Deploys the Deno backend server to Deno Deploy.

```bash
npx qb-deploy-server
```

**What it does:**
1. Fetches project details from the QwikBuild platform API
2. Prepares deployment assets (backend/src, shared, deno.jsonc, deno.lock)
3. Creates a deployment via Deno Deploy API with environment variables
4. Polls until deployment is ready
5. Registers the deployment URL with the platform

**Required environment variables:**
- `DENO_ORGANIZATION_ID` - Deno Deploy organization ID
- `DENO_TOKEN` - Deno Deploy API token
- `VITE_API_BASE_URL` - QwikBuild platform API URL
- `VITE_APP_ID` - Application ID
- `DATABASE_URL` - PostgreSQL connection string
- `APP_JWT_SECRET` - JWT secret for the backend

**Optional environment variables:**
- `DENO_ENTRY_POINT` - Entry point file (default: `src/main.ts`)
- `DENO_DEPLOYMENT_MAX_ATTEMPTS` - Max poll attempts (default: `30`)
- `DENO_DEPLOYMENT_WAIT_INTERVAL` - Poll interval in ms (default: `5000`)
- `APP_S3_BUCKET_NAME`, `APP_S3_ENDPOINT`, `APP_S3_ACCESS_KEY_ID`, `APP_S3_SECRET_ACCESS_KEY` - S3/R2 storage config

### qb-deploy-frontend

Builds the frontend and deploys it to CDN Store (S3-compatible).

```bash
npx qb-deploy-frontend
```

**What it does:**
1. Detects package manager (pnpm > npm > yarn) and build script
2. Runs the frontend build
3. Walks the project directory, organizing files into `source/` and `dist/`
4. Uploads all files to CDN Store with retry and exponential backoff
5. Notifies the QwikBuild platform of deployment completion

**Build script detection priority:** `frontend:build` > `build:prod` > `build:production`

**File organization:**
- `{base_path}/{url_slug}/source/` - All project files (excludes node_modules, symlinks, large files)
- `{base_path}/{url_slug}/dist/` - Built output from dist/ directory

**Required environment variables:**
- `VITE_API_BASE_URL` - QwikBuild platform API URL
- `VITE_APP_ID` - Application ID
- `URL_SLUG` - Project URL slug (used as CDN folder name)
- `CDN_ACCESS_KEY_ID` - CDN Store access key
- `CDN_SECRET_ACCESS_KEY` - CDN Store secret key
- `CDN_BUCKET_NAME` - CDN Store bucket name
- `QWIKBUILD_PLATFORM_API_KEY` - API key for platform notification

**Optional environment variables:**
- `CDN_REGION` - CDN region (default: `ap-south-1`)
- `CDN_CODEBASE_BASE_PATH` - CDN base path (default: `coder-agent-output`)
- `MAX_FILE_SIZE` - Max file size in bytes to upload (default: `52428800` / 50MB)

### qb-deploy-cron-and-comms

Deploys cron jobs and communication templates from backend configuration.

```bash
npx qb-deploy-cron-and-comms
```

**What it does:**
1. Loads `CONFIG` from `backend/src/cron_n_comm_config.js`
2. Deploys cron job schedules to the platform
3. Submits communication templates for approval

**Required environment variables:**
- `VITE_API_BASE_URL` - QwikBuild platform API URL
- `VITE_APP_ID` - Application ID
- `QWIKBUILD_PLATFORM_API_KEY` - Platform API key

## Requirements

- Node.js >= 18
- Environment variables set (via `.env` file or shell)
- For `qb-deploy-server`: Deno Deploy account and token
- For `qb-deploy-frontend`: CDN Store credentials with bucket access
- For `qb-deploy-cron-and-comms`: `backend/src/cron_n_comm_config.js` with exported `CONFIG`

## Project Structure Expected

```
project/
├── .env                          # Environment variables
├── backend/
│   ├── src/
│   │   ├── main.ts               # Deno entry point
│   │   └── cron_n_comm_config.js # Cron/comms config
│   ├── deno.jsonc
│   ├── deno.lock
│   └── drizzle.config.ts
├── frontend/
│   └── ...                       # Frontend source
├── shared/                       # Shared code (deployed with server)
├── dist/                         # Built frontend output
└── package.json
```

## License

Apache-2.0
