import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

export const ROOT_DIR = process.cwd();

/**
 * Load .env from project root (if it exists), without overriding existing env vars.
 * This allows environment variables from shell/CI-CD to take precedence.
 */
export function loadEnv() {
  const rootEnvPath = join(ROOT_DIR, ".env");
  if (existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath, override: false });
  }
}

/**
 * Validate that required environment variables are set.
 * Exits with code 1 and a clear error message if any are missing.
 * @param {string[]} varNames - Array of env var names that must be set
 * @returns {Record<string, string>} Object mapping var names to their values
 */
export function requireEnvVars(varNames) {
  const result = {};
  const missing = [];

  for (const name of varNames) {
    const value = process.env[name];
    if (!value) {
      missing.push(name);
    } else {
      result[name] = value;
    }
  }

  if (missing.length > 0) {
    console.error("Error: Missing required environment variables:");
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }

  return result;
}

/**
 * Make an API call to the QwikBuild platform.
 * URL: ${VITE_API_BASE_URL}/api/apps/v1/${VITE_APP_ID}/${path}
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - Path after /api/apps/v1/{appId}/, e.g. "cron/create"
 * @param {object} [body] - JSON body (will be stringified)
 * @param {object} [options]
 * @param {string} [options.apiKey] - If provided, sent as Bearer token in Authorization header
 * @returns {Promise<Response>} Raw fetch Response — caller handles status/parsing
 */
export async function platformApiCall(method, path, body, options = {}) {
  const apiBaseUrl = process.env.VITE_API_BASE_URL;
  const appId = process.env.VITE_APP_ID;

  const url = `${apiBaseUrl}/api/apps/v1/${appId}/${path}`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (options.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  return fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
