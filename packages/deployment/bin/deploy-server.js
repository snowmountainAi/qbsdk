#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import dotenv from "dotenv";
import { Client } from "@deno/sandbox";


import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars([
  "DENO_DEPLOY_TOKEN",
  "VITE_API_BASE_URL",
  "VITE_APP_ID",
]);

const ENTRY_POINT = process.env.DENO_ENTRY_POINT || "src/main.ts";
const VITE_APP_BASE_URL = process.env.VITE_APP_BASE_URL;
const VITE_APP_ID = env.VITE_APP_ID;

// SDK reads DENO_DEPLOY_TOKEN from process.env, but pass it explicitly so the
// requireEnvVars check above is the single source of truth.
const client = new Client({ token: env.DENO_DEPLOY_TOKEN });

// Heuristic matching the Deno Deploy dashboard's auto-secret detection.
const SECRET_KEY_PATTERNS = [/SECRET/i, /TOKEN/i, /PRIVATE/i, /PASSWORD/i, /CREDENTIAL/i];
const ALWAYS_SECRET_KEYS = new Set([
  "DATABASE_URL",
  "APP_S3_ACCESS_KEY_ID",
  "APP_S3_SECRET_ACCESS_KEY",
  // Redis proxy URIs embed the per-app auth token in the URL, so treat as secret.
  "REDIS_URL",
  "REDIS_TLS_URL",
]);

function isSecretEnvKey(key) {
  if (ALWAYS_SECRET_KEYS.has(key)) return true;
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Resolve the QwikBuild platform's record for this app's Deno target.
 * Returns the v2 App fetched from Deno.
 *
 * Contract: the platform's `get-server-project` endpoint returns
 *   { id: string, slug: string }
 * for a v2 Deno App (provisioning it on first call).
 */
async function getApp() {
  console.log("Fetching server App from QwikBuild platform...");

  const response = await platformApiCall("GET", "get-server-project");
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Platform get-server-project failed (${response.status}): ${errorText}`);
  }

  const platformApp = await response.json();
  if (!platformApp?.slug) {
    throw new Error(
      `Platform get-server-project response missing 'slug'. Got: ${JSON.stringify(platformApp)}`,
    );
  }
  console.log(`   Platform returned App slug: ${platformApp.slug}`);

  const app = await client.apps.get(platformApp.slug);
  console.log(`   Resolved Deno App: id=${app.id} slug=${app.slug}`);
  return app;
}

/**
 * Recursively read a directory and add files into the deploy assets map.
 * Asset values use the v2 shape: { kind: "file", content, encoding }.
 *
 * @param {string} dir - Directory to read
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} prefix - Prefix to add to asset paths
 * @param {Object} assets - Assets object to populate
 * @param {Array<string>} excludeDirs - Directory names to exclude
 */
function readDirectoryRecursively(dir, baseDir = dir, prefix = "", assets = {}, excludeDirs = []) {
  const files = readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = join(dir, file.name);
    const relativePath = relative(baseDir, fullPath);

    if (file.isDirectory()) {
      const shouldExclude =
        excludeDirs.includes(file.name) ||
        excludeDirs.some((excludeDir) => relativePath.startsWith(excludeDir));

      if (!shouldExclude) {
        readDirectoryRecursively(fullPath, baseDir, prefix, assets, excludeDirs);
      }
    } else {
      const assetPath = (prefix ? join(prefix, relativePath) : relativePath).replace(/\\/g, "/");
      assets[assetPath] = {
        kind: "file",
        content: readFileSync(fullPath, "utf-8"),
        encoding: "utf-8",
      };
    }
  }

  return assets;
}

/**
 * Read the backend server files and produce a v2 deploy assets map.
 * Layout matches the v1 script: `src/...`, `shared/...`, and root config files.
 */
function prepareDeploymentAssets() {
  console.log("Preparing deployment assets...");

  const assets = {};
  const backendPath = join(ROOT_DIR, "backend");

  if (!existsSync(backendPath)) {
    throw new Error(`Backend directory not found: ${backendPath}`);
  }

  const srcPath = join(backendPath, "src");
  if (!existsSync(srcPath)) {
    throw new Error(`Backend src directory not found: ${srcPath}`);
  }
  readDirectoryRecursively(srcPath, srcPath, "src", assets);
  console.log("   Added backend/src files");

  const sharedPath = join(ROOT_DIR, "shared");
  if (existsSync(sharedPath)) {
    readDirectoryRecursively(sharedPath, sharedPath, "shared", assets);
    console.log("   Added shared files");
  }

  const denoJsonPath = join(backendPath, "deno.jsonc");
  if (existsSync(denoJsonPath)) {
    let content = readFileSync(denoJsonPath, "utf-8");
    // Backend imports from ../shared/ during local dev; rewrite to ./shared/
    // for the deployed layout where shared/ lives at the deploy root.
    content = content.replace(/\.\.\/shared\//g, "./shared/");
    assets["deno.jsonc"] = { kind: "file", content, encoding: "utf-8" };
    console.log("   Added deno.jsonc");
  } else {
    console.warn(`   deno.jsonc not found at: ${denoJsonPath}`);
  }

  const drizzleConfigPath = join(backendPath, "drizzle.config.ts");
  if (existsSync(drizzleConfigPath)) {
    assets["drizzle.config.ts"] = {
      kind: "file",
      content: readFileSync(drizzleConfigPath, "utf-8"),
      encoding: "utf-8",
    };
    console.log("   Added drizzle.config.ts");
  }

  const denoLockPath = join(backendPath, "deno.lock");
  if (existsSync(denoLockPath)) {
    assets["deno.lock"] = {
      kind: "file",
      content: readFileSync(denoLockPath, "utf-8"),
      encoding: "utf-8",
    };
    console.log("   Added deno.lock");
  }

  console.log(`Deployment assets prepared (${Object.keys(assets).length} files)`);
  return assets;
}

/**
 * Build the v2 env_vars array from the current process environment.
 * Sensitive keys are marked `secret: true` so the dashboard masks them.
 */
function buildEnvVars() {
  const backendEnvPath = join(ROOT_DIR, "backend", ".env");
  if (existsSync(backendEnvPath)) {
    dotenv.config({ path: backendEnvPath, override: false });
    console.log("   Loaded environment variables from backend/.env");
  }

  const required = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_JWT_SECRET: process.env.APP_JWT_SECRET,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error("Missing required environment variables:");
    for (const v of missing) {
      console.error(`   - ${v}`);
    }
    console.error("Please set these environment variables in your .env file or environment:");
    console.error(
      "   DATABASE_URL='postgres://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb'",
    );
    console.error("   APP_JWT_SECRET='your-jwt-secret'");
    process.exit(1);
  }

  const envObj = {
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
    REDIS_URL: process.env.REDIS_URL,
    REDIS_TLS_URL: process.env.REDIS_TLS_URL,
  };

  // Auto-include any APP_DENO* and USER_ADDED_KEY_* vars from the environment,
  // matching the v1 script's behaviour.
  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("APP_DENO") || key.startsWith("USER_ADDED_KEY_")) && !(key in envObj)) {
      envObj[key] = value;
    }
  }

  return Object.entries(envObj)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      key,
      value: String(value),
      secret: isSecretEnvKey(key),
      contexts: "all",
    }));
}

const TERMINAL_REVISION_STATUSES = new Set(["succeeded", "failed", "skipped"]);

/**
 * Poll until the revision reaches a terminal status. Streams build logs in parallel.
 *
 * @param {string} revisionId
 * @param {{ status: string }} initial - First payload from apps.deploy()
 */
async function waitForRevisionComplete(revisionId, initial) {
  let revision = initial;
  let prevStatus = initial.status;
  const pollMs = 2000;

  const logStreamDone = (async () => {
    try {
      console.log("Streaming build logs...");
      for await (const log of client.revisions.buildLogs(revisionId)) {
        const step = log.step ? `[${log.step}]` : "";
        const timeline = log.timeline ? `(${log.timeline})` : "";
        const prefix = `${step}${timeline}`.trim();
        const line = prefix ? `${prefix} ${log.message}` : log.message;
        if (log.level === "error") {
          console.error(line);
        } else {
          console.log(line);
        }
      }
    } catch (err) {
      console.warn(`Build log stream stopped: ${err?.message ?? err}`);
    }
  })();

  while (!TERMINAL_REVISION_STATUSES.has(revision.status)) {
    await new Promise((r) => setTimeout(r, pollMs));
    const next = await client.revisions.get(revisionId);
    if (!next) {
      throw new Error(`Revision ${revisionId} not found while polling`);
    }
    revision = next;
    if (revision.status !== prevStatus) {
      console.log(`   Revision ${revisionId} status: ${revision.status}`);
      prevStatus = revision.status;
    }
  }

  await logStreamDone.catch(() => {});
  return revision;
}

/**
 * Deploy a new revision to the App's production timeline.
 * Streams build logs to stdout and resolves with the final revision.
 */
async function deployRevision(app, assets) {
  console.log("Creating revision...");

  const envVars = buildEnvVars();
  console.log(`   Sending ${envVars.length} env vars (${envVars.filter((v) => v.secret).length} marked secret)`);
  console.log(`   Entrypoint: ${ENTRY_POINT}`);

  const result = await client.apps.deploy(app.slug, {
    assets,
    config: {
      install: "deno install",
      build: null,
      runtime: { type: "dynamic", entrypoint: ENTRY_POINT },
    },
    env_vars: envVars,
    production: true,
  });

  console.log(`   Revision created: id=${result.id} status=${result.status}`);

  const revision = TERMINAL_REVISION_STATUSES.has(result.status)
    ? result
    : await waitForRevisionComplete(result.id, result);

  if (revision.status !== "succeeded") {
    const reason = revision.failure_reason ? ` (${revision.failure_reason})` : "";
    throw new Error(
      `Revision ${revision.id} ended with status="${revision.status}"${reason}. See streamed build logs above.`,
    );
  }

  console.log(`Revision succeeded: id=${revision.id}`);
  return revision;
}

/**
 * Resolve the public URL for a successful revision by reading the production
 * timeline's domains.
 */
async function resolveDeploymentUrl(revisionId) {
  const timelines = await client.revisions.timelines(revisionId);
  if (!Array.isArray(timelines) || timelines.length === 0) {
    throw new Error(`No timelines returned for revision ${revisionId}`);
  }

  // Prefer the production timeline; fall back to the first one with a domain.
  const productionTimeline = timelines.find((t) => t?.context?.slug === "production");
  const candidate = productionTimeline ?? timelines.find((t) => t?.domains?.length > 0);
  const domain = candidate?.domains?.[0]?.domain;

  if (!domain) {
    throw new Error(
      `No domain found for revision ${revisionId} timelines: ${JSON.stringify(timelines)}`,
    );
  }

  return `https://${domain}`;
}

async function deploy() {
  try {
    console.log("Starting Deno deployment process (Subhosting v2)...");

    const app = await getApp();
    console.log("");

    const assets = prepareDeploymentAssets();
    console.log("");

    const revision = await deployRevision(app, assets);
    console.log("");

    const deploymentUrl = await resolveDeploymentUrl(revision.id);
    const deployedPlatformUrl = `${VITE_APP_BASE_URL}/api/apps/${VITE_APP_ID}/server/`;
    console.log("Deployment completed successfully!");
    console.log(`Deno URL:           ${deploymentUrl}`);
    console.log(`Platform proxy URL: ${deployedPlatformUrl}`);
    console.log("You can now access your server function at the deployment URL.");

    const setUrlResponse = await platformApiCall("POST", "set-server-url", { url: deploymentUrl });
    if (!setUrlResponse.ok) {
      throw new Error(
        `Failed to set server URL (${setUrlResponse.status}): ${await setUrlResponse.text()}`,
      );
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

export { deploy, getApp, deployRevision, prepareDeploymentAssets, buildEnvVars };