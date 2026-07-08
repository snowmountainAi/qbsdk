import { execFile } from "node:child_process";
import { cpSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { ROOT_DIR } from "./common.js";
import { resolveBackendRoot } from "./backend-path.js";

const execFileAsync = promisify(execFile);

const ROOT_FILES = ["package.json", "package-lock.json", "vercel.json"];

/**
 * Build the backend with cervel and collect files for a Vercel deployment.
 * @param {string} [backendRoot]
 * @returns {Promise<Array<{ file: string, data: string }>>}
 */
export async function collectBackendFiles(backendRoot = resolveBackendRoot()) {
  const distDir = join(backendRoot, "dist");
  copySharedIntoBackend(backendRoot);
  await buildBackend(backendRoot);

  const files = [];

  for (const name of ROOT_FILES) {
    if (name === "package.json") {
      files.push(readDeployPackageJson(join(backendRoot, "package.json")));
      continue;
    }

    const absolutePath = join(backendRoot, name);
    if (!existsSync(absolutePath)) {
      continue;
    }

    files.push(readInlinedFile(absolutePath, name));
  }

  // Collect the ENTIRE built output (dist/), preserving each file's path
  // relative to dist/. cervel's emitted layout varies by version — v0.1.29
  // produces `.cervel.json`, `_virtual/rolldown_runtime.mjs`, and
  // `src/**/*.mjs` where the src modules import the runtime by relative path
  // (`../../_virtual/rolldown_runtime.mjs`). Cherry-picking known filenames
  // (e.g. a root `rolldown_runtime.js`) breaks those imports and is brittle
  // across cervel versions; uploading the tree verbatim keeps them resolvable.
  if (!existsSync(distDir)) {
    throw new Error(`Built backend output not found: ${distDir}`);
  }
  files.push(...walkDirectory(distDir, distDir, ""));

  return files;
}

function walkDirectory(absoluteDir, baseDir, deploymentPrefix) {
  const files = [];
  const entries = readdirSync(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDirectory(absolutePath, baseDir, deploymentPrefix));
      continue;
    }

    const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");
    const deploymentPath = deploymentPrefix
      ? `${deploymentPrefix}/${relativePath}`
      : relativePath;
    files.push(readInlinedFile(absolutePath, deploymentPath));
  }

  return files;
}

function copySharedIntoBackend(backendRoot) {
  const sharedSource = join(ROOT_DIR, "shared");
  if (!existsSync(sharedSource)) {
    return;
  }

  const sharedTarget = join(backendRoot, "shared");
  cpSync(sharedSource, sharedTarget, { recursive: true, force: true });
  console.log("   Copied shared/ into backend/shared");
}

async function buildBackend(backendRoot) {
  const builtEntry = join(backendRoot, "dist", "src", "main.js");

  try {
    await execFileAsync("npx", ["cervel", "build", "src/main.ts"], {
      cwd: backendRoot,
      env: {
        ...process.env,
        VERCEL_EXPERIMENTAL_BACKENDS: "1",
      },
    });
  } catch (error) {
    if (!existsSync(builtEntry)) {
      throw error;
    }
  }
}

function readDeployPackageJson(packageJsonPath) {
  const raw = readFileSync(packageJsonPath, "utf-8");
  const pkg = JSON.parse(raw);

  if (pkg.scripts) {
    delete pkg.scripts.build;
    delete pkg.scripts["build:local"];
  }

  if (pkg.devDependencies) {
    delete pkg.devDependencies.vercel;
    delete pkg.devDependencies.typescript;
  }

  return {
    file: "package.json",
    data: `${JSON.stringify(pkg, null, 2)}\n`,
  };
}

function readInlinedFile(absolutePath, deploymentPath) {
  return {
    file: deploymentPath,
    data: readFileSync(absolutePath, "utf-8"),
  };
}
