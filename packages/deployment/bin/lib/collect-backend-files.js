import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
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

  files.push(readInlinedFile(join(distDir, ".cervel.json"), ".cervel.json"));
  files.push(readInlinedFile(join(distDir, "rolldown_runtime.js"), "rolldown_runtime.js"));
  files.push(...walkDirectory(join(distDir, "src"), join(distDir, "src"), "src"));

  return files;
}

function walkDirectory(absoluteDir, baseDir, deploymentPrefix) {
  if (!existsSync(absoluteDir)) {
    throw new Error(`Built backend output not found: ${absoluteDir}`);
  }

  const files = [];
  const entries = readdirSync(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDirectory(absolutePath, baseDir, deploymentPrefix));
      continue;
    }

    const relativePath = relative(baseDir, absolutePath).replace(/\\/g, "/");
    files.push(readInlinedFile(absolutePath, `${deploymentPrefix}/${relativePath}`));
  }

  return files;
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
