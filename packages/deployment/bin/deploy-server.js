#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";
import { resolveBackendRoot } from "./lib/backend-path.js";
import { collectBackendFiles } from "./lib/collect-backend-files.js";
import {
  buildDeployEnv,
  deployBackendFiles,
  parseRegions,
  waitForDeploymentReady,
} from "./lib/vercel-api.js";

function parseArgs(argv) {
  const options = {
    deploymentName: process.env.VERCEL_DEPLOYMENT_NAME,
    domain: process.env.VERCEL_DOMAIN,
    projectId: process.env.VERCEL_PROJECT_ID || process.env.DEPLOY_FILES_PROJECT_ID,
    regions: process.env.VERCEL_REGIONS,
    skipPlatform: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--name" || arg === "-n") {
      options.deploymentName = argv[++i];
    } else if (arg === "--domain" || arg === "-d") {
      options.domain = argv[++i];
    } else if (arg === "--project" || arg === "-p") {
      options.projectId = argv[++i];
    } else if (arg === "--regions" || arg === "-r") {
      options.regions = argv[++i];
    } else if (arg === "--skip-platform") {
      options.skipPlatform = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`qb-deploy-server — deploy a Hono backend to Vercel

Usage:
  npx qb-deploy-server [options]

Options:
  -n, --name <name>       Deployment / project name (default: random UUID)
  -d, --domain <domain>   Custom domain to attach to the Vercel project
  -p, --project <id>      Existing Vercel project ID (skips auto-provision)
  -r, --regions <list>    Comma-separated Function regions (default: sin1)
      --skip-platform     Do not register the deployment URL with QwikBuild
  -h, --help              Show this help message

Environment:
  VERCEL_TOKEN            Vercel API token (required)
  VERCEL_TEAM_ID          Vercel team ID (optional)
  VERCEL_PROJECT_ID       Existing Vercel project ID (optional)
  DEPLOY_FILES_PROJECT_ID Alias for VERCEL_PROJECT_ID
  VERCEL_REGIONS          Comma-separated Function regions (optional)
  BACKEND_DIR             Backend folder name (default: backend)
  VITE_API_BASE_URL       QwikBuild platform API URL (required)
  VITE_APP_ID             Application ID (required)
  DEPLOY_AUTH_TOKEN       Precomputed per-app deploy token for the authenticated
                          v3 platform endpoints: sha256(appId + base secret).
                          The platform injects this per app; the base secret
                          never reaches the app environment.
  DEPLOY_AUTH_SECRET      DEPRECATED fallback: platform-wide base secret from
                          which the token is derived locally. Only used when
                          DEPLOY_AUTH_TOKEN is unset. One of the two is required.
`);
}

const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  printHelp();
  process.exit(0);
}

loadEnv();

const env = requireEnvVars([
  "VERCEL_TOKEN",
  "VITE_API_BASE_URL",
  "VITE_APP_ID",
]);

if (!process.env.DEPLOY_AUTH_TOKEN && !process.env.DEPLOY_AUTH_SECRET) {
  console.error("Error: Missing required environment variables:");
  console.error("   - DEPLOY_AUTH_TOKEN (or the deprecated DEPLOY_AUTH_SECRET fallback)");
  process.exit(1);
}

const VITE_APP_BASE_URL = process.env.VITE_APP_BASE_URL;
const VITE_APP_ID = env.VITE_APP_ID;

/**
 * Per-app deploy token for the authenticated v3 platform endpoints.
 * Must equal sha256(appId + base secret) — the platform recomputes and
 * compares it in withDeployAuth. Preferred source is DEPLOY_AUTH_TOKEN,
 * precomputed and injected per app so the platform-wide base secret never
 * enters the app environment. DEPLOY_AUTH_SECRET (deriving the token locally
 * from the base secret) is a deprecated fallback. Both are distinct from the
 * app's JWT/testing secret.
 */
function deployToken() {
  if (process.env.DEPLOY_AUTH_TOKEN) {
    return process.env.DEPLOY_AUTH_TOKEN;
  }
  return createHash("sha256")
    .update(VITE_APP_ID + process.env.DEPLOY_AUTH_SECRET)
    .digest("hex");
}

/** Options for the authenticated v3 platform calls. */
function v3Auth() {
  return { apiVersion: "v3", apiKey: deployToken() };
}

/**
 * Resolve the Vercel project ID from CLI/env or the QwikBuild platform.
 * Platform contract (authenticated v3): GET /api/apps/v3/{appId}/get-server-project
 * returns { id, name, url?, server_provider: "vercel" }, where `id` is the Vercel
 * project ID (existing or freshly provisioned).
 */
async function resolveProjectId(explicitProjectId) {
  if (explicitProjectId) {
    console.log(`Using Vercel project ID from configuration: ${explicitProjectId}`);
    return explicitProjectId;
  }

  console.log("Fetching server project from QwikBuild platform...");

  const response = await platformApiCall("GET", "get-server-project", undefined, v3Auth());
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Platform get-server-project failed (${response.status}): ${errorText}`);
  }

  const platformApp = await response.json();
  if (!platformApp?.id) {
    throw new Error(
      `Platform get-server-project response missing 'id'. Got: ${JSON.stringify(platformApp)}`,
    );
  }

  console.log(`   Platform returned Vercel project ID: ${platformApp.id}`);
  return platformApp.id;
}

function loadBackendEnv(backendRoot) {
  const backendEnvPath = join(backendRoot, ".env");
  if (existsSync(backendEnvPath)) {
    dotenv.config({ path: backendEnvPath, override: false });
    console.log("   Loaded environment variables from backend/.env");
  }
}

function buildPlatformEnv() {
  const required = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_JWT_SECRET: process.env.APP_JWT_SECRET,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error("Missing required environment variables:");
    for (const key of missing) {
      console.error(`   - ${key}`);
    }
    console.error("Set these in backend/.env or your shell environment.");
    process.exit(1);
  }

  const platformEnv = {
    NODE_ENV: process.env.NODE_ENV || "production",
    VITE_APP_SLUG: process.env.URL_SLUG,
    URL_SLUG: process.env.URL_SLUG,
    APP_ID: VITE_APP_ID,
    API_BASE_URL: env.VITE_API_BASE_URL,
    VITE_APP_ID,
    QWIKBUILD_PLATFORM_URL: env.VITE_API_BASE_URL,
    VITE_API_BASE_URL: env.VITE_API_BASE_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    APP_S3_BUCKET_NAME: process.env.APP_S3_BUCKET_NAME,
    APP_S3_ENDPOINT: process.env.APP_S3_ENDPOINT,
    APP_S3_ACCESS_KEY_ID: process.env.APP_S3_ACCESS_KEY_ID,
    APP_S3_SECRET_ACCESS_KEY: process.env.APP_S3_SECRET_ACCESS_KEY,
    APP_JWT_SECRET: process.env.APP_JWT_SECRET,
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
    // Redis: REST facade only — the sole Redis transport on the v8 stack (the
    // token auto-encrypts via the secret-key pattern). The rediss:// TCP pair
    // is deliberately NOT forwarded to v8 deployments.
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };

  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("APP_DENO") || key.startsWith("USER_ADDED_KEY_")) && !(key in platformEnv)) {
      platformEnv[key] = value;
    }
  }

  return Object.fromEntries(
    Object.entries(platformEnv).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

async function deploy() {
  try {
    console.log("Starting Vercel backend deployment...");

    const backendRoot = resolveBackendRoot();
    console.log(`   Backend directory: ${backendRoot.replace(`${ROOT_DIR}/`, "")}`);
    console.log("");

    loadBackendEnv(backendRoot);
    const platformEnv = buildPlatformEnv();
    const envPreview = buildDeployEnv(platformEnv);
    console.log(`   Prepared ${Object.keys(envPreview).length} environment variables for Vercel`);
    console.log("");

    let projectId = cli.projectId;
    if (!cli.skipPlatform && !projectId) {
      projectId = await resolveProjectId();
      console.log("");
    }

    console.log("Building and collecting deployment files...");
    const files = await collectBackendFiles(backendRoot);
    console.log(`   Collected ${files.length} files`);
    console.log("");

    console.log("Creating Vercel deployment...");
    const { deployment, projectId: targetProjectId, url, regions } = await deployBackendFiles({
      files,
      deploymentName: cli.deploymentName,
      projectId,
      domain: cli.domain,
      platformEnv,
      regions: parseRegions(cli.regions),
    });

    console.log(`   Deployment created: id=${deployment.id} state=${deployment.readyState}`);
    if (url) {
      console.log(`   URL: ${url}`);
    }
    console.log(`   Project ID: ${targetProjectId}`);
    console.log(`   Regions: ${regions.join(", ")}`);
    console.log("");

    console.log("Waiting for deployment to become ready...");
    const finalStatus = await waitForDeploymentReady(deployment.id, {
      onUpdate(status) {
        if (status.readyState) {
          console.log(`   Status: ${status.readyState}`);
        }
      },
    });

    const deploymentUrl = finalStatus.url ? `https://${finalStatus.url}` : url;
    if (!deploymentUrl) {
      throw new Error("Deployment succeeded but no URL was returned");
    }

    const deployedPlatformUrl = VITE_APP_BASE_URL
      ? `${VITE_APP_BASE_URL}/api/apps/${VITE_APP_ID}/server/`
      : undefined;

    console.log("");
    console.log("Deployment completed successfully!");
    console.log(`Vercel URL:         ${deploymentUrl}`);
    if (deployedPlatformUrl) {
      console.log(`Platform proxy URL: ${deployedPlatformUrl}`);
    }

    if (!cli.skipPlatform) {
      const setUrlResponse = await platformApiCall("POST", "set-server-url", { url: deploymentUrl }, v3Auth());
      if (!setUrlResponse.ok) {
        throw new Error(
          `Failed to set server URL (${setUrlResponse.status}): ${await setUrlResponse.text()}`,
        );
      }
      console.log("Registered deployment URL with QwikBuild platform.");
    }
  } catch (error) {
    console.error("Deployment failed. Error:", error?.message ?? error);
    process.exit(1);
  }
}

deploy().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

export { deploy, resolveProjectId, buildPlatformEnv };
