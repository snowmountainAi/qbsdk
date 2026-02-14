#!/usr/bin/env node

// qb-db-migrate - Database migration runner for QwikBuild projects
// Applies raw SQL migrations from backend/migrations/ using psql
// Tracks applied migrations in _migrations table
// Runs drizzle-kit pull after successful migrations

import { readFile, readdir, stat, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

console.log("Database Migration Runner (Database-First Approach)");
console.log("====================================================\n");

// Resolve paths from current working directory (project root)
const projectRoot = process.cwd();
const backendDir = join(projectRoot, "backend");
const migrationsDir = join(backendDir, "migrations");
const envFilePath = join(projectRoot, ".env");

// Load .env file
try {
  await stat(envFilePath);
  dotenv.config({ path: envFilePath, override: false });
} catch {
  dotenv.config({ override: false });
}

// Inherit environment variables from parent process
const env = { ...process.env };
const databaseUrl = env.DATABASE_URL;

if (!databaseUrl) {
  console.error("\x1b[31m✗ Error: DATABASE_URL is not present.\x1b[0m");
  process.exit(1);
}

const PULL_DELAY_SECONDS = parseInt(env.DB_PULL_DELAY_SECONDS || "5", 10);

async function runDrizzlePull() {
  return new Promise((resolve, reject) => {
    const configPath = join(backendDir, "drizzle.config.ts");
    // Cross-platform: use shell:true and pipe 'y' to stdin to auto-confirm prompts
    const proc = spawn("npx", ["drizzle-kit", "pull", "--config", configPath], {
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
      if (code !== 0) reject(new Error(`drizzle-kit pull failed with exit code ${code}`));
      else resolve();
    });
  });
}

async function runPsql(sql, errorMessage = "SQL execution failed") {
  return new Promise((resolve, reject) => {
    const proc = spawn("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-t", "-A"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to spawn psql: ${error.message}`));
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => stdout += data.toString());
    proc.stderr?.on("data", (data) => stderr += data.toString());

    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`${errorMessage}: ${stderr || stdout}`));
      else resolve(stdout.trim());
    });

    proc.stdin?.write(sql);
    proc.stdin?.end();
  });
}

async function ensureMigrationsTable() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `;
  try {
    await runPsql(createTableSql, "Failed to create _migrations table");
    console.log("✓ Migrations tracking table ready\n");
  } catch (error) {
    console.error(`Error setting up migrations table: ${error.message}`);
    process.exit(1);
  }
}

async function getAppliedMigrations() {
  try {
    const result = await runPsql("SELECT filename FROM _migrations ORDER BY filename;");
    return result ? result.split("\n").filter((f) => f.trim()) : [];
  } catch {
    return [];
  }
}

async function recordMigration(filename) {
  await runPsql(`INSERT INTO _migrations (filename) VALUES ('${filename.replace(/'/g, "''")}');`);
}

// Ensure migrations dir exists
try {
  await stat(migrationsDir);
} catch {
  await mkdir(migrationsDir, { recursive: true });
}

const sqlFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

if (sqlFiles.length === 0) {
  console.log("No SQL migration files found in backend/migrations/");
  process.exit(0);
}

await ensureMigrationsTable();
const appliedMigrations = await getAppliedMigrations();
const pendingMigrations = sqlFiles.filter((f) => !appliedMigrations.includes(f));

if (pendingMigrations.length === 0) {
  console.log("\x1b[32m✓ Database is up to date.\x1b[0m");
  // Output structured summary for parsing
  console.log(`\n__MIGRATION_SUMMARY__:${JSON.stringify({
    migrations_applied: 0,
    files_applied: [],
    already_applied: appliedMigrations,
    status: "up_to_date"
  })}`);
  process.exit(0);
}

const appliedThisRun = [];
for (const sqlFile of pendingMigrations) {
  console.log(`Applying: ${sqlFile}...`);
  try {
    const sqlContent = await readFile(join(migrationsDir, sqlFile), "utf-8");
    await new Promise((resolve, reject) => {
      const proc = spawn("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: env
      });

      proc.on("error", (error) => {
        reject(new Error(`Failed to spawn psql for migration ${sqlFile}: ${error.message}`));
      });

      let stderr = "";
      proc.stderr?.on("data", (data) => stderr += data.toString());
      proc.on("close", (code) => code !== 0 ? reject(new Error(stderr)) : resolve());
      proc.stdin?.write(sqlContent);
      proc.stdin?.end();
    });
    await recordMigration(sqlFile);
    appliedThisRun.push(sqlFile);
    console.log(`\x1b[32m✓ ${sqlFile} applied\x1b[0m`);
  } catch (error) {
    console.error(`\x1b[31mError applying ${sqlFile}: ${error.message}\x1b[0m`);
    // Output partial summary on failure
    console.log(`\n__MIGRATION_SUMMARY__:${JSON.stringify({
      migrations_applied: appliedThisRun.length,
      files_applied: appliedThisRun,
      failed_file: sqlFile,
      status: "failed"
    })}`);
    process.exit(1);
  }
}

console.log("\n🔄 Syncing schema...");
let schemaSynced = false;
try {
  await runDrizzlePull();
  schemaSynced = true;
  console.log("\x1b[32m✓ All migrations applied and schema synced!\x1b[0m");
} catch {
  console.error("\x1b[33m⚠ Migration successful but schema sync failed.\x1b[0m");
}
// Output structured summary for parsing
console.log(`\n__MIGRATION_SUMMARY__:${JSON.stringify({
  migrations_applied: appliedThisRun.length,
  files_applied: appliedThisRun,
  already_applied: appliedMigrations,
  schema_synced: schemaSynced,
  status: "success"
})}`);
process.exit(0);
