#!/usr/bin/env node
// Deploy frontend application by building, archiving, and uploading to the AgentQ backend.
// The backend handles S3 upload and platform notification — no CDN credentials needed on the CLI side.
//
// Usage:
//   npx qb-deploy-frontend              # default: dist-only mode
//   npx qb-deploy-frontend --full       # include full source code
//
// Required env vars:
//   AGENTQ_API_URL             - AgentQ backend base URL
//   URL_SLUG                   - Project URL slug
//   QWIKBUILD_PLATFORM_API_KEY - API key for backend authentication

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadEnv, requireEnvVars, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars([
  "AGENTQ_API_URL",
  "URL_SLUG",
  "QWIKBUILD_PLATFORM_API_KEY",
]);

// Parse CLI flags: --full sends entire project, default is dist-only
const includeSource = process.argv.includes("--full");

// ─── Step 1: Build Frontend ─────────────────────────────────────────────────

/**
 * Build the frontend application.
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

  // Find build script (priority order)
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

  // Detect package manager (priority: pnpm > npm > yarn)
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

// ─── Step 2: Create Archive ─────────────────────────────────────────────────

/**
 * Create a tar.gz archive for deployment.
 * Uses the native `tar` command (available on Windows 10+, macOS, Linux).
 *
 * Default (dist-only): archives only the dist/ folder — smallest possible upload.
 * --full mode: archives the entire project (excluding node_modules, .git, .env, lock files).
 *
 * @returns {Promise<{success: boolean, archivePath?: string, error?: string}>}
 */
async function createArchive() {
  const archiveName = "deploy-frontend.tar.gz";
  const archivePath = join(ROOT_DIR, archiveName);

  // Remove existing archive if present
  if (existsSync(archivePath)) {
    unlinkSync(archivePath);
  }

  let args;
  if (includeSource) {
    // --full: archive entire project minus junk
    console.log("Creating deployment archive (full: source + dist)...");
    console.log("   Excluding: node_modules (recursive), .git, .env, lock files");
    args = [
      "-czf", archiveName,
      "--exclude=./node_modules",
      "--exclude=*/node_modules",
      "--exclude=.git",
      "--exclude=.env",
      "--exclude=*.lock",
      "--exclude=pnpm-lock.yaml",
      "--exclude=package-lock.json",
      "--exclude=yarn.lock",
      `--exclude=${archiveName}`,
      ".",
    ];
  } else {
    // Default: dist-only
    console.log("Creating deployment archive (dist only)...");

    // Find the dist directory
    const distPath = join(ROOT_DIR, "dist");
    const frontendDistPath = join(ROOT_DIR, "frontend", "dist");

    if (existsSync(distPath)) {
      console.log("   Found: dist/");
      args = ["-czf", archiveName, "dist"];
    } else if (existsSync(frontendDistPath)) {
      console.log("   Found: frontend/dist/");
      args = ["-czf", archiveName, "-C", "frontend", "dist"];
    } else {
      console.error("   No dist/ directory found. Run the build first, or use --full to include source.");
      return { success: false, error: "No dist/ directory found" };
    }
  }

  console.log(`   Running: tar ${args.join(" ")}`);

  return new Promise((resolve) => {
    const child = spawn("tar", args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });

    child.on("close", (code) => {
      if (code === 0 && existsSync(archivePath)) {
        const sizeBytes = readFileSync(archivePath).length;
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
        console.log(`Archive created successfully (${sizeMB} MB)`);
        resolve({ success: true, archivePath });
      } else {
        console.error(`Archive creation failed with exit code ${code}`);
        resolve({ success: false, error: `tar failed with exit code ${code}` });
      }
    });

    child.on("error", (err) => {
      console.error(`Archive creation error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

// ─── Step 3: Upload to Backend ──────────────────────────────────────────────

/**
 * Upload the archive to the AgentQ backend.
 * The backend will extract it, upload to S3, and send the platform notification.
 *
 * @param {string} archivePath - Path to the tar.gz archive
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function uploadToBackend(archivePath) {
  const mode = includeSource ? "full" : "dist";
  const url = `${env.AGENTQ_API_URL}/projects/${env.URL_SLUG}/deploy-frontend?mode=${mode}`;
  console.log(`Uploading archive to backend...`);
  // console.log(`   URL: ${url}`);
  console.log(`   Mode: ${mode}`);

  try {
    const fileBuffer = readFileSync(archivePath);
    const blob = new Blob([fileBuffer], { type: "application/gzip" });

    const formData = new FormData();
    formData.append("file", blob, "deploy-frontend.tar.gz");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.QWIKBUILD_PLATFORM_API_KEY}`,
      },
      body: formData,
    });

    // Read body as text first, then try to parse as JSON
    // (avoids "Body has already been read" error when response is non-JSON)
    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      return { success: false, error: `Server returned non-JSON response (${response.status}): ${responseText.slice(0, 500)}` };
    }

    if (!response.ok) {
      console.error(`Backend returned ${response.status}: ${JSON.stringify(responseData, null, 2)}`);
      return { success: false, error: responseData.detail || `HTTP ${response.status}` };
    }

    console.log("Backend upload completed successfully");
    return { success: true, data: responseData };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Main Deployment ────────────────────────────────────────────────────────

async function deploy() {
  let archivePath = null;

  try {
    console.log("Starting frontend deployment...");
    console.log(`   URL Slug: ${env.URL_SLUG}`);
    console.log(`   Backend: ${env.AGENTQ_API_URL}`);
    console.log(`   Mode: ${includeSource ? "full (source + dist)" : "dist only"}`);
    console.log("");

    // Step 1: Build frontend
    const buildResult = await buildFrontend();
    if (!buildResult.success) {
      console.error("\nFrontend build failed. Aborting deployment.");
      process.exit(1);
    }
    console.log("");

    // Step 2: Create archive
    const archiveResult = await createArchive();
    if (!archiveResult.success) {
      console.error("\nArchive creation failed. Aborting deployment.");
      process.exit(1);
    }
    archivePath = archiveResult.archivePath;
    console.log("");

    // Step 3: Upload to backend
    const uploadResult = await uploadToBackend(archivePath);
    if (!uploadResult.success) {
      console.error(`\nBackend upload failed: ${uploadResult.error}`);
      process.exit(1);
    }
    console.log("");

    // Summary
    console.log("Frontend deployment completed!");
    if (uploadResult.data) {
      const envPrefix = env.AGENTQ_API_URL.replace('https://consoleq.','').replace('qwikbuild.com/api','');
      console.log(`   Deployment URL: https://${env.URL_SLUG}.${envPrefix}qwikbuild.site`);
      console.log(`   Source files: ${uploadResult.data.source_uploaded || "N/A"}`);
      console.log(`   Dist files: ${uploadResult.data.dist_uploaded || "N/A"}`);
      console.log(`   Notification: ${uploadResult.data.notification_sent ? "sent" : "failed"}`);
    }

  } catch (error) {
    console.error("Deployment failed:", error.message);
    process.exit(1);
  } finally {
    // Clean up archive
    if (archivePath && existsSync(archivePath)) {
      try {
        unlinkSync(archivePath);
      } catch { /* ignore cleanup errors */ }
    }
  }
}

// Run
deploy().catch(error => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
