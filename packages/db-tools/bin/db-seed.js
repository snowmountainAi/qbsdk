#!/usr/bin/env node

// qb-db-seed - Database seeding tool for QwikBuild projects
// Runs SQL seed files against the database using psql
// Usage: qb-db-seed [seed-file.sql]
// If no file provided, looks for backend/seed-data.sql

import { stat } from "fs/promises";
import { join, resolve, isAbsolute } from "path";
import { spawn } from "child_process";
import dotenv from "dotenv";

console.log("Database Seeding Tool");
console.log("=====================\n");

// Resolve paths from current working directory (project root)
const projectRoot = process.cwd();
const backendDir = join(projectRoot, "backend");
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
  console.error("\n\x1b[33m⚠ Action Required:\x1b[0m Provision a database first.");
  process.exit(1);
}

// Get seed file from command line argument or use default
const args = process.argv.slice(2);
let seedFile = args[0];

if (!seedFile) {
  // Check for common default seed file locations
  const defaultLocations = [
    join(backendDir, "data", "seed", "seed-data.sql"),
    join(backendDir, "seed-data.sql"),
    join(backendDir, "seed.sql"),
    join(projectRoot, "seed-data.sql"),
  ];

  for (const location of defaultLocations) {
    try {
      await stat(location);
      seedFile = location;
      console.log(`Found seed file: ${seedFile}\n`);
      break;
    } catch {
      // File doesn't exist, try next
    }
  }

  if (!seedFile) {
    console.error("\x1b[31m✗ Error: No seed file specified and no default seed file found.\x1b[0m");
    console.error("\nUsage: qb-db-seed <seed-file.sql>");
    console.error("\nOr create one of these files:");
    defaultLocations.forEach(loc => console.error(`  - ${loc}`));
    process.exit(1);
  }
} else {
  // Resolve relative paths from project root
  if (!isAbsolute(seedFile)) {
    seedFile = resolve(projectRoot, seedFile);
  }
}

// Verify seed file exists
try {
  await stat(seedFile);
} catch {
  console.error(`\x1b[31m✗ Error: Seed file not found: ${seedFile}\x1b[0m`);
  process.exit(1);
}

console.log(`Seeding database from: ${seedFile}\n`);

// Run psql with the seed file
async function runSeedFile() {
  return new Promise((resolve, reject) => {
    const proc = spawn("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", seedFile], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env
    });

    proc.on("error", (error) => {
      reject(new Error(`Failed to spawn psql: ${error.message}`));
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Seeding failed with exit code ${code}: ${stderr || stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

try {
  await runSeedFile();
  console.log("\n\x1b[32m✓ Database seeded successfully!\x1b[0m");
  process.exit(0);
} catch (error) {
  console.error(`\n\x1b[31m✗ Error seeding database: ${error.message}\x1b[0m`);
  process.exit(1);
}
