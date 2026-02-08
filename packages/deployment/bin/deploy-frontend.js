#!/usr/bin/env node
// Deploy frontend application by building, uploading to S3, and notifying the platform.
// Replicates the Python frontend deployment logic (deployment_tools.py + sync_codebase_to_s3.py).
//
// Usage: npx qb-deploy-frontend
//
// Required env vars:
//   VITE_API_BASE_URL  - QwikBuild platform API base URL
//   VITE_APP_ID        - Application ID
//   URL_SLUG           - Project URL slug
//   CDN_ACCESS_KEY_ID  - CDN Store credentials
//   CDN_SECRET_ACCESS_KEY
//   CDN_BUCKET_NAME    - CDN bucket name

// Optional env vars:
//   CDN_REGION         - CDN region (default: ap-south-1)
//   CDN_CODEBASE_BASE_PATH  - CDN base path (default: coder-agent-output)
//   MAX_FILE_SIZE           - Max file size in bytes to upload (default: 50MB)


import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { spawn } from "node:child_process";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars([
  "VITE_API_BASE_URL",
  "VITE_APP_ID",
  "URL_SLUG",
  "CDN_ACCESS_KEY_ID",
  "CDN_SECRET_ACCESS_KEY",
  "CDN_BUCKET_NAME",
]);

// Optional configuration
const CDN_REGION = process.env.CDN_REGION || "ap-south-1";
const CDN_CODEBASE_BASE_PATH = process.env.CDN_CODEBASE_BASE_PATH || "coder-agent-output";
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || "52428800", 10); // 50MB
const QWIKBUILD_PLATFORM_API_KEY = process.env.QWIKBUILD_PLATFORM_API_KEY;

/**
 * Create S3 client for CDN operations (shared across sync and notification)
 */
function createCdnS3Client() {
  return new S3Client({
    region: CDN_REGION,
    credentials: {
      accessKeyId: env.CDN_ACCESS_KEY_ID,
      secretAccessKey: env.CDN_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Get MIME content type for a file based on extension.
 * Mirrors Python s3_utils._get_content_type
 */
function getContentType(filePath) {
  const types = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.jsx': 'application/javascript',
    '.ts': 'application/typescript',
    '.tsx': 'application/typescript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.map': 'application/json',
  };
  return types[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ─── Step 1: Build Frontend ─────────────────────────────────────────────────

/**
 * Build the frontend application.
 *  _run_frontend_build:
 *   - Reads package.json to find the build script
 *   - Detects package manager (pnpm > npm > yarn)
 *   - Runs the build command
 */
async function buildFrontend() {
  console.log("Building frontend...");

  const packageJsonPath = join(ROOT_DIR, "package.json");
  if (!existsSync(packageJsonPath)) {
    console.log("   No package.json found, skipping build");
    return { success: true, skipped: true };
  }

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch (err) {
    console.error(`   Failed to read package.json: ${err.message}`);
    return { success: false, error: `Failed to read package.json: ${err.message}` };
  }

  const scripts = packageJson.scripts || {};

  // Find build script (priority order matches Python)
  const buildScriptPriority = ["frontend:build", "build:prod", "build:production"];
  let buildScript = null;
  for (const name of buildScriptPriority) {
    if (scripts[name]) {
      buildScript = name;
      break;
    }
  }

  if (!buildScript) {
    console.log("   No build script found in package.json, skipping build");
    return { success: true, skipped: true };
  }

  // Detect package manager (priority: pnpm > npm > yarn, matches Python)
  let pm = "pnpm";
  if (!existsSync(join(ROOT_DIR, "pnpm-lock.yaml"))) {
    if (existsSync(join(ROOT_DIR, "package-lock.json"))) {
      pm = "npm";
    } else if (existsSync(join(ROOT_DIR, "yarn.lock"))) {
      pm = "yarn";
    }
  }

  const command = `${pm} run ${buildScript}`;
  console.log(`   Package manager: ${pm}`);
  console.log(`   Build script: ${buildScript}`);
  console.log(`   Running: ${command}`);

  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: { ...process.env },
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log("Frontend build completed successfully");
        resolve({ success: true, command });
      } else {
        console.error(`Frontend build failed with exit code ${code}`);
        resolve({ success: false, error: `Build failed with exit code ${code}`, command, return_code: code });
      }
    });

    child.on("error", (err) => {
      console.error(`Frontend build error: ${err.message}`);
      resolve({ success: false, error: err.message, command });
    });
  });
}

// ─── Step 2: Sync to CDN Store ────────────────────────────────────────────────────

/**
 * Walk directory recursively and collect files for upload.
 * CDN Store file organization logic:
 *   - Skips node_modules directories
 *   - Skips symlinks
 *   - Skips files exceeding MAX_FILE_SIZE
 *   - Organizes into source/ (all non-dist) and dist/ (from dist/ folders)
 */
function collectFiles(rootDir) {
  const sourceFiles = [];
  const distFiles = [];
  const warnings = [];
  const basePath = `${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}`;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`Cannot read directory ${dir}: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

      // Skip node_modules (matches Python: dirs[:] = [d for d in dirs if d != 'node_modules'])
      if (entry.name === "node_modules") continue;

      // Skip symlinks (matches Python: os.path.islink check)
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        // Skip large files (matches Python: file_size > max_file_size check)
        if (stats.size > MAX_FILE_SIZE) {
          warnings.push(`Skipping large file: ${relPath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
          continue;
        }

        // Determine source vs dist (matches Python: normalized_rel_path logic)
        const isDist = relPath.startsWith("dist/") || relPath.includes("/dist/");

        if (isDist) {
          // Normalize dist path (matches Python: handle nested dist folders)
          let distRelPath;
          if (relPath.startsWith("dist/")) {
            distRelPath = relPath.substring(5); // remove "dist/"
          } else {
            const parts = relPath.split("/dist/");
            distRelPath = parts.length > 1 ? parts[1] : relPath;
          }
          distFiles.push({
            fullPath,
            s3Key: `${basePath}/dist/${distRelPath}`,
            size: stats.size,
          });
        } else {
          sourceFiles.push({
            fullPath,
            s3Key: `${basePath}/source/${relPath}`,
            size: stats.size,
          });
        }
      }
    }
  }

  walk(rootDir);
  return { sourceFiles, distFiles, warnings };
}

/**
 * Upload a single file to CDN Store with retry logic.
 * Mirrors _upload_with_retry (exponential backoff).
 */
async function uploadFileWithRetry(s3Client, file, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const content = readFileSync(file.fullPath);
      const contentType = getContentType(file.fullPath);

      await s3Client.send(new PutObjectCommand({
        Bucket: env.CDN_BUCKET_NAME,
        Key: file.s3Key,
        Body: content,
        ContentType: contentType,
      }));

      return { success: true };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`   Retry ${attempt + 1}/${maxRetries} for ${file.s3Key} (waiting ${waitTime}ms)...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  return { success: false, error: lastError?.message || "Upload failed after all retries" };
}

/**
 * Sync the project codebase to CDN Store.
 *   - Collects and organizes files into source/ and dist/
 *   - Uploads all files to S3 with retry logic
 *   - Reports progress and results
 */
async function syncToS3() {
  console.log("Syncing codebase to S3...");
  console.log(`   Bucket: ${env.CDN_BUCKET_NAME}`);
  console.log(`   Path: ${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}/`);

  const s3Client = createCdnS3Client();

  // Collect files (mirrors Python's file organization walk)
  console.log("   Organizing files...");
  const { sourceFiles, distFiles, warnings } = collectFiles(ROOT_DIR);

  for (const warning of warnings) {
    console.log(`   Warning: ${warning}`);
  }

  console.log(`   Source files: ${sourceFiles.length}`);
  console.log(`   Dist files: ${distFiles.length}`);

  // Check for missing dist when build script exists (mirrors Python warning logic)
  if (distFiles.length === 0) {
    const packageJsonPath = join(ROOT_DIR, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageData = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const scripts = packageData.scripts || {};
        const hasBuildScript = "build" in scripts || "build:prod" in scripts ||
          "build:production" in scripts || "frontend:build" in scripts;
        if (hasBuildScript) {
          console.log("   Warning: Project has build script but no dist files found. Build may not have been executed.");
        }
      } catch { /* ignore */ }
    }
  }

  // Upload files
  const allFiles = [...sourceFiles, ...distFiles];
  const errors = [];
  let uploaded = 0;

  console.log(`   Uploading ${allFiles.length} files...`);

  for (const file of allFiles) {
    const result = await uploadFileWithRetry(s3Client, file);

    if (result.success) {
      uploaded++;
    } else {
      errors.push(`Failed to upload ${file.s3Key}: ${result.error}`);
      console.error(`   FAIL: ${file.s3Key}: ${result.error}`);
    }

    // Progress (matches Python's notify_frontend progress updates)
    if (uploaded % 50 === 0 || uploaded === allFiles.length) {
      const progress = allFiles.length > 0
        ? Math.round((uploaded / allFiles.length) * 100)
        : 100;
      console.log(`   Progress: ${uploaded}/${allFiles.length} files (${progress}%)`);
    }
  }

  const success = errors.length === 0;
  const s3FolderUrl = `${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}/`;

  if (success) {
    console.log(`S3 sync completed successfully (${uploaded} files uploaded)`);
  } else {
    console.log(`S3 sync completed with ${errors.length} errors (${uploaded} files uploaded)`);
  }

  return {
    success,
    source_uploaded: sourceFiles.length - errors.filter(e => e.includes("/source/")).length,
    dist_uploaded: distFiles.length - errors.filter(e => e.includes("/dist/")).length,
    s3_folder_url: s3FolderUrl,
    errors,
    warnings,
  };
}

// ─── Step 3: Notify Platform ────────────────────────────────────────────────

/**
 * Check if this is the first time deploying this project to S3.
 * Mirrors Python _send_code_gen_complete first_time_build check.
 */
async function checkFirstTimeBuild(s3Client) {
  try {
    const result = await s3Client.send(new ListObjectsV2Command({
      Bucket: env.CDN_BUCKET_NAME,
      Prefix: `${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}/`,
      MaxKeys: 1,
    }));
    return !result.Contents || result.Contents.length === 0;
  } catch {
    return false;
  }
}

/**
 * Notify the QwikBuild platform that frontend deployment is complete.
 * Mirrors Python _send_code_gen_complete / inform_code_gen_complete.
 */
async function notifyCompletion(syncResult) {
  console.log("Notifying platform of deployment completion...");

  const s3Client = createCdnS3Client();
  const firstTimeBuild = await checkFirstTimeBuild(s3Client);
  const s3Path = syncResult.s3_folder_url || `${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}/`;

  try {
    const response = await platformApiCall(
      "POST",
      "notify-frontend-deployed",
      {
        status: "SUCCESS",
        result: s3Path,
        first_time_build: firstTimeBuild,
        url_slug: env.URL_SLUG,
      },
      { apiKey: QWIKBUILD_PLATFORM_API_KEY },
    );

    if (response.ok) {
      console.log("Platform notified successfully");
      return { success: true, first_time_build: firstTimeBuild };
    } else {
      const text = await response.text();
      console.warn(`Platform notification returned ${response.status}: ${text}`);
      return { success: false, error: `${response.status}: ${text}` };
    }
  } catch (err) {
    console.warn(`Platform notification failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Main Deployment ────────────────────────────────────────────────────────

/**
 * Main deployment function orchestrating the full frontend deployment workflow.
 * Mirrors Python DeploymentTools.deploy_frontend:
 *   1. Build frontend
 *   2. Sync to S3 (source + dist)
 *   3. Send deployment completion notification
 */
async function deploy() {
  try {
    console.log("Starting frontend deployment...");
    console.log(`   URL Slug: ${env.URL_SLUG}`);
    console.log(`   S3 Bucket: ${env.CDN_BUCKET_NAME}`);
    console.log(`   S3 Base Path: ${CDN_CODEBASE_BASE_PATH}`);
    console.log("");

    const result = {
      status: "success",
      steps: {},
      build: {},
      sync: {},
      notification: {},
    };

    // Step 1: Build frontend
    const buildResult = await buildFrontend();
    result.build = buildResult;
    result.steps.build = buildResult.success ? "completed" : "failed";

    if (!buildResult.success) {
      result.status = "error";
      result.error = `Build failed: ${buildResult.error}`;
      console.error("\nFrontend build failed. Aborting deployment.");
      process.exit(1);
    }
    console.log("");

    // Step 2: Sync to S3
    const syncResult = await syncToS3();
    result.sync = syncResult;
    result.steps.sync = syncResult.success ? "completed" : "failed";

    if (!syncResult.success) {
      result.status = "error";
      result.error = "S3 sync failed";
      console.error("\nS3 sync failed. Aborting deployment.");
      process.exit(1);
    }
    console.log("");

    // Step 3: Notify platform (only if sync succeeded, matches Python logic)
    const notificationResult = await notifyCompletion(syncResult);
    result.notification = notificationResult;
    result.steps.notification = notificationResult.success ? "completed" : "failed";

    if (!notificationResult.success) {
      console.warn("Platform notification failed, but S3 upload succeeded.");
      console.warn("The deployment may still work - check the platform dashboard.");
    }
    console.log("");

    // Summary
    console.log("Frontend deployment completed!");
    console.log(`   Build: ${result.steps.build}`);
    console.log(`   S3 Sync: ${result.steps.sync}`);
    console.log(`   Notification: ${result.steps.notification}`);
    console.log(`   S3 Path: ${CDN_CODEBASE_BASE_PATH}/${env.URL_SLUG}/`);

  } catch (error) {
    console.error("Deployment failed:", error.message);
    process.exit(1);
  }
}

// Run
deploy().catch(error => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
