import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveBackendRoot } from "./backend-path.js";

/**
 * Parse KEY=VALUE lines from backend .env into a plain object.
 */
export function parseEnvContent(content) {
  const env = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value === "") {
      continue;
    }

    env[key] = value;
  }

  return env;
}

export function parseBackendEnvFile(backendRoot = resolveBackendRoot()) {
  const envPath = join(backendRoot, ".env");
  if (!existsSync(envPath)) {
    return {};
  }

  return parseEnvContent(readFileSync(envPath, "utf-8"));
}
