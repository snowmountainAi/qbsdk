#!/usr/bin/env node

// qb-db-pull - Pull database schema using drizzle-kit
// Syncs the TypeScript schema from the database state
// Usage: qb-db-pull
//
// drizzle-kit picks the first Postgres driver it can import: pg, postgres,
// @vercel/postgres, then @neondatabase/serverless. This package depends on pg
// so the pull never falls through to the Neon websocket driver, which can hang
// with no output. The pull also has a time limit (DB_PULL_TIMEOUT_SECONDS,
// default 150) and keeps its output, so a failure always says why.

import { stat } from "fs/promises";
import { createWriteStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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

const TIMEOUT_SECONDS = Math.max(10, parseInt(env.DB_PULL_TIMEOUT_SECONDS || "150", 10) || 150);
const LOG_PATH = join(tmpdir(), "qb-db-pull.last.log");
const isWindows = process.platform === "win32";

console.log(`Running drizzle-kit pull (time limit ${TIMEOUT_SECONDS}s)...\n`);

// Last lines of the output, without spinner redraws and colour codes.
function tidy(text) {
  const seen = new Set();
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !seen.has(line) && seen.add(line))
    .slice(-40)
    .join("\n");
}

function hint(output) {
  if (output.includes("@neondatabase/serverless")) {
    return "\nHint: drizzle-kit used the '@neondatabase/serverless' websocket driver, which can hang. " +
      "Make sure 'pg' can be imported from drizzle-kit (this package depends on it; reinstall dependencies).";
  }
  return "";
}

async function runDrizzlePull() {
  const log = createWriteStream(LOG_PATH, { flags: "w" });
  let output = "";
  const keep = (data) => {
    const text = data.toString();
    log.write(text);
    output = (output + text).slice(-20000);
  };

  return new Promise((resolve, reject) => {
    const started = Date.now();
    // Cross-platform: use shell:true and pipe 'y' to stdin to auto-confirm prompts.
    // detached (not on Windows) puts npx, the shell and drizzle-kit in one process
    // group, so a timeout stops all of them.
    const proc = spawn("npx", ["drizzle-kit", "pull", "--config", drizzleConfigPath], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      cwd: projectRoot,
      env: env,
      detached: !isWindows
    });

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWindows) proc.kill("SIGKILL");
        else process.kill(-proc.pid, "SIGKILL");
      } catch {
        try { proc.kill("SIGKILL"); } catch {}
      }
    }, TIMEOUT_SECONDS * 1000);

    proc.on("error", (error) => {
      clearTimeout(killer);
      reject(new Error(`Failed to spawn drizzle-kit: ${error.message}`));
    });

    proc.stdout?.on("data", (data) => { keep(data); process.stdout.write(data); });
    proc.stderr?.on("data", (data) => { keep(data); process.stderr.write(data); });

    // Suppress EPIPE errors on stdin — these occur when drizzle-kit closes
    // its stdin before we stop writing auto-confirm "y\n" below.
    proc.stdin?.on("error", (err) => {
      if (err.code === "EPIPE") return; // Expected when child closes stdin
      console.error(`stdin error: ${err.message}`);
    });

    // Auto-confirm any prompts by sending 'y' repeatedly
    const confirmInterval = setInterval(() => {
      if (proc.stdin?.writable) {
        proc.stdin.write("y\n");
      }
    }, 100);

    proc.on("close", (code) => {
      clearInterval(confirmInterval);
      clearTimeout(killer);
      log.end();
      const secs = Math.round((Date.now() - started) / 1000);
      const last = tidy(output) || "(drizzle-kit printed nothing)";
      if (timedOut) {
        reject(new Error(
          `drizzle-kit pull timed out after ${TIMEOUT_SECONDS}s and was stopped. ` +
          `Full output: ${LOG_PATH}\n--- last output ---\n${last}${hint(output)}`
        ));
      } else if (code !== 0) {
        reject(new Error(
          `drizzle-kit pull failed with exit code ${code} after ${secs}s. ` +
          `Full output: ${LOG_PATH}\n--- last output ---\n${last}${hint(output)}`
        ));
      } else {
        console.log(`\ndrizzle-kit pull finished in ${secs}s`);
        resolve();
      }
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
