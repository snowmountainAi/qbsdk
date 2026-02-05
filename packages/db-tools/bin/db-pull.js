#!/usr/bin/env node

// qb-db-pull - Pull database schema using drizzle-kit
// Syncs the TypeScript schema from the database state
// Usage: qb-db-pull

import { stat } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

console.log("Database Schema Pull Tool");
console.log("=========================\n");

// Resolve paths from current working directory (project root)
const projectRoot = process.cwd();
const backendDir = join(projectRoot, "backend");
const envFilePath = join(projectRoot, ".env");
const drizzleConfigPath = join(backendDir, "drizzle.config.ts");

// Load .env file
try {
  await stat(envFilePath);
  dotenv.config({ path: envFilePath, override: false });
} catch {
  dotenv.config({ override: false });
}

// Inherit environment variables from parent process
const env = { ...process.env };

if (!env.DATABASE_URL) {
  console.error("\x1b[31m✗ Error: DATABASE_URL is not present.\x1b[0m");
  process.exit(1);
}

// Check if drizzle config exists
try {
  await stat(drizzleConfigPath);
} catch {
  console.error(`\x1b[31m✗ Error: Drizzle config not found: ${drizzleConfigPath}\x1b[0m`);
  process.exit(1);
}

console.log("Running drizzle-kit pull...\n");

async function runDrizzlePull() {
  return new Promise((resolve, reject) => {
    // Cross-platform: use shell:true and pipe 'y' to stdin to auto-confirm prompts
    const proc = spawn("npx", ["drizzle-kit", "pull", "--config", drizzleConfigPath], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      cwd: projectRoot,
      env: env
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to spawn drizzle-kit: ${error.message}`));
    });

    proc.stdout?.on("data", (data) => process.stdout.write(data));
    proc.stderr?.on("data", (data) => process.stderr.write(data));

    // Auto-confirm any prompts by sending 'y' repeatedly
    const confirmInterval = setInterval(() => {
      if (proc.stdin?.writable) {
        proc.stdin.write("y\n");
      }
    }, 100);

    proc.on("close", (code) => {
      clearInterval(confirmInterval);
      if (code !== 0) reject(new Error(`drizzle-kit pull failed with exit code ${code}`));
      else resolve();
    });
  });
}

try {
  await runDrizzlePull();
  console.log("\n\x1b[32m✓ Schema pull complete!\x1b[0m");
  process.exit(0);
} catch (error) {
  console.error(`\n\x1b[31m✗ Operation failed: ${error.message}\x1b[0m`);
  process.exit(1);
}
