#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import dotenv from "dotenv";
import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars(["DENO_ORGANIZATION_ID", "DENO_TOKEN", "VITE_API_BASE_URL", "VITE_APP_ID"]);

// Configuration - from environment variables
const DENO_API_BASE_URL = process.env.DENO_API_BASE_URL || 'https://api.deno.com/v1';
const ENTRY_POINT = process.env.DENO_ENTRY_POINT || 'src/main.ts';
const VITE_APP_BASE_URL = process.env.VITE_APP_BASE_URL;
const VITE_APP_ID = process.env.VITE_APP_ID;

/**
 * Make authenticated request to Deno API
 */
async function makeDenoRequest(endpoint, options = {}) {
  const url = `${DENO_API_BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${env.DENO_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Create a new project in Deno
 */
async function createProject() {
  console.log("Getting Server Deployment Project...");

  try {
    // This api creates new deno project if it doesnt exists. Once create the project cannot be changes
    const response = await platformApiCall("GET", "get-server-project");

    if (!response.ok) {
      const errorText = await response.text();
      console.error("API request failed:", response.status, errorText);
      throw new Error(`API request failed (${response.status}): ${errorText}`);
    }

    const denoProjectDetails = await response.json();
    console.log(denoProjectDetails);

    return denoProjectDetails;
  } catch (error) {
    console.error("Failed to create project:", error.message);
    throw error;
  }
}


/**
 * Recursively read directory and add files to assets
 * @param {string} dir - Directory to read
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} prefix - Prefix to add to asset paths
 * @param {Object} assets - Assets object to populate
 * @param {Array<string>} excludeDirs - Directories to exclude (relative to dir)
 */
function readDirectoryRecursively(dir, baseDir = dir, prefix = "", assets = {}, excludeDirs = []) {
  const files = readdirSync(dir, { withFileTypes: true });

  for (const file of files) {
    const fullPath = join(dir, file.name);
    const relativePath = relative(baseDir, fullPath);

    // Check if this directory should be excluded
    if (file.isDirectory()) {
      // Check if this directory name is in the exclude list
      const shouldExclude = excludeDirs.includes(file.name) ||
        excludeDirs.some(excludeDir => relativePath.startsWith(excludeDir));

      if (!shouldExclude) {
        readDirectoryRecursively(fullPath, baseDir, prefix, assets, excludeDirs);
      }
    } else {
      const assetPath = (prefix ? join(prefix, relativePath) : relativePath).replace(/\\/g, "/");
      const content = readFileSync(fullPath, "utf-8");
      assets[assetPath] = {
        kind: "file",
        content: content,
        encoding: "utf-8",
      };
    }
  }

  return assets;
}

/**
 * Read the backend server files and create deployment assets
 */
function prepareDeploymentAssets() {
  console.log("Preparing deployment assets...");

  try {
    const assets = {};
    const backendPath = join(ROOT_DIR, 'backend');

    if (!existsSync(backendPath)) {
      throw new Error(`Backend directory not found: ${backendPath}`);
    }

    // Read all files from backend/src directory (will be deployed to src/)
    const srcPath = join(backendPath, 'src');
    if (existsSync(srcPath)) {
      readDirectoryRecursively(srcPath, srcPath, "src", assets);
      console.log("   Added backend/src files");
    } else {
      throw new Error(`Backend src directory not found: ${srcPath}`);
    }

    // Add shared files
    const sharedPath = join(ROOT_DIR, 'shared');
    if (existsSync(sharedPath)) {
      readDirectoryRecursively(sharedPath, sharedPath, "shared", assets);
      console.log("   Added shared files");
    }

    // Add deno.json to the root
    const denoJsonPath = join(backendPath, 'deno.jsonc');
    if (existsSync(denoJsonPath)) {
      let content = readFileSync(denoJsonPath, "utf-8");
      // Replace ../shared/ with ./shared/ for deployment
      content = content.replace(/\.\.\/shared\//g, "./shared/");

      assets["deno.jsonc"] = {
        kind: "file",
        content: content,
        encoding: "utf-8",
      };
      console.log("   Added deno.jsonc");
    } else {
      console.warn(`   deno.jsonc not found at: ${denoJsonPath}`);
    }

    // Add drizzle.config.ts if it exists
    const drizzleConfigPath = join(backendPath, 'drizzle.config.ts');
    if (existsSync(drizzleConfigPath)) {
      assets["drizzle.config.ts"] = {
        kind: "file",
        content: readFileSync(drizzleConfigPath, "utf-8"),
        encoding: "utf-8",
      };
      console.log("   Added drizzle.config.ts");
    }

    // Add deno.lock if it exists
    const denoLockPath = join(backendPath, 'deno.lock');
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
  } catch (error) {
    console.error("Failed to prepare deployment assets:", error.message);
    throw error;
  }
}

/**
 * Create a deployment for the project
 */
async function createDeployment(projectId, deploymentAssets) {
  console.log("Creating deployment...");

  try {
    // Load backend/.env if it exists (root .env already loaded at script start)
    const backendEnvPath = join(ROOT_DIR, 'backend', '.env');
    if (existsSync(backendEnvPath)) {
      dotenv.config({ path: backendEnvPath, override: false });
      console.log(`   Loaded environment variables from backend/.env`);
    }

    // Validate required environment variables
    const requiredEnvVars = {
      DATABASE_URL: process.env.DATABASE_URL,
      APP_JWT_SECRET: process.env.APP_JWT_SECRET
    };

    const missingVars = Object.entries(requiredEnvVars)
      .filter(([key, value]) => !value)
      .map(([key]) => key);

    if (missingVars.length > 0) {
      console.error("Missing required environment variables:");
      missingVars.forEach(varName => console.error(`   - ${varName}`));
      console.error("Please set these environment variables in your .env file or environment:");
      console.error("   DATABASE_URL='postgres://username:password@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb'");
      console.error("   APP_JWT_SECRET='your-jwt-secret'");
      process.exit(1);
    }

    // Build environment variables object from process.env
    const envVars = {
      NODE_ENV: process.env.NODE_ENV || 'production',
      APP_ID: env.VITE_APP_ID,
      API_BASE_URL: env.VITE_API_BASE_URL,
      VITE_APP_ID: env.VITE_APP_ID,
      QWIKBUILD_PLATFORM_URL: env.VITE_API_BASE_URL,
      VITE_API_BASE_URL: env.VITE_API_BASE_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      APP_S3_BUCKET_NAME: process.env.APP_S3_BUCKET_NAME,
      APP_S3_ENDPOINT: process.env.APP_S3_ENDPOINT,
      APP_S3_ACCESS_KEY_ID: process.env.APP_S3_ACCESS_KEY_ID,
      APP_S3_SECRET_ACCESS_KEY: process.env.APP_S3_SECRET_ACCESS_KEY,
      APP_JWT_SECRET: process.env.APP_JWT_SECRET
    };

    // Remove undefined values
    Object.keys(envVars).forEach(key => {
      if (envVars[key] === undefined) {
        delete envVars[key];
      }
    });

    const deploymentData = {
      entryPointUrl: ENTRY_POINT,
      assets: deploymentAssets,
      envVars: envVars
    };

    const deployment = await makeDenoRequest(
      `/projects/${projectId}/deployments`,
      {
        method: 'POST',
        body: JSON.stringify(deploymentData),
      }
    );

    console.log("Deployment created successfully!");
    console.log("   ID:", deployment.id);
    console.log("   Status:", deployment.status || "Unknown");

    return deployment;
  } catch (error) {
    console.error("Failed to create deployment:", error.message);
    throw error;
  }
}

/**
 * Wait for deployment to be ready
 */
async function waitForDeployment(projectId, deploymentId) {
  const maxAttempts = parseInt(process.env.DENO_DEPLOYMENT_MAX_ATTEMPTS || '30', 10);
  const waitInterval = parseInt(process.env.DENO_DEPLOYMENT_WAIT_INTERVAL || '5000', 10);

  console.log("Waiting for deployment to be ready...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const deployment = await makeDenoRequest(
      `/deployments/${deploymentId}`
    );

    if (deployment.status === "success") {
      console.log("Deployment is ready!");
      return deployment;
    }

    if (deployment.status === "failed") {
      console.log("Deployment failed, getting build logs...");
      const logs = await makeDenoRequest(`/deployments/${deploymentId}/build_logs`, { headers: { accept: "application/json" } });
      throw new Error(`Deployment failed: ${JSON.stringify(logs)}`);
    }

    if (deployment.status === "error") {
      throw new Error("Deployment failed");
    }

    console.log(`   Attempt ${attempt}/${maxAttempts}: Status is ${deployment.status}, waiting...`);
    await new Promise(resolve => setTimeout(resolve, waitInterval));
  }

  throw new Error("Deployment timeout - please check manually");
}

/**
 * Main deployment function
 */
async function deploy() {
  try {
    console.log("Starting Deno deployment process...");

    // Step 1: Create project
    const project = await createProject();
    console.log("");

    // Step 2: Prepare deployment assets
    const deploymentFiles = prepareDeploymentAssets();
    console.log("");

    // Step 3: Create deployment
    const deployment = await createDeployment(project.id, deploymentFiles);
    console.log("");

    // Step 4: Wait for deployment to be ready
    const finalDeployment = await waitForDeployment(project.id, deployment.id);
    console.log("");

    const deployedPlatformUrl = `${VITE_APP_BASE_URL}/api/apps/${VITE_APP_ID}/server/`;
    console.log("Deployment completed successfully!");
    console.log("Deployment URL: ", deployedPlatformUrl);
    console.log("You can now access your server function at the deployment URL.");

    const deploymentUrl = `https://${project.name}-${finalDeployment.id}.deno.dev`;
    const setUrlResponse = await platformApiCall("POST", "set-server-url", { url: deploymentUrl });
    if (!setUrlResponse.ok) {
      throw new Error(`Failed to set server URL (${setUrlResponse.status}): ${await setUrlResponse.text()}`);
    }
  } catch (error) {
    console.error("Deployment Status Unknown - May be Deno deployment is throttled. Error Message from Deno:", error.message);
    process.exit(1);
  }
}

// Run the deployment
deploy().catch(error => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

export { deploy, createProject, createDeployment, prepareDeploymentAssets };
