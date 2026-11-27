import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";

export const ROOT_DIR = process.cwd();

// Public settings an app wants in both its backend and its frontend build, e.g.
// PUBLIC_SUPPORT_EMAIL. Uppercase letters, digits and underscores after the prefix.
const PUBLIC_ENV_KEY = /^PUBLIC_[A-Z0-9_]+$/;

/**
 * The non-empty PUBLIC_* variables in `env`.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
export function publicEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => PUBLIC_ENV_KEY.test(key) && value !== undefined && value !== ""),
  );
}

/**
 * Env for the frontend build: `env` plus a VITE_PUBLIC_* alias for every PUBLIC_*
 * variable. Vite exposes only VITE_* to browser code by default, so the alias is
 * what `import.meta.env.VITE_PUBLIC_X` reads. An alias already set is left alone.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ env: Record<string, string | undefined>, names: string[] }}
 */
export function withPublicViteAliases(env = process.env) {
  const out = { ...env };
  const names = [];
  for (const [key, value] of Object.entries(publicEnv(env))) {
    names.push(key);
    const alias = `VITE_${key}`;
    if (out[alias] === undefined || out[alias] === "") out[alias] = value;
  }
  return { env: out, names: names.sort() };
}

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
 * URL: ${VITE_API_BASE_URL}/api/apps/${apiVersion}/${VITE_APP_ID}/${path}
 *
 * @param {string} method - HTTP method (GET, POST, etc.)
 * @param {string} path - Path after /api/apps/{version}/{appId}/, e.g. "request-template-approval"
 * @param {object} [body] - JSON body (will be stringified)
 * @param {object} [options]
 * @param {string} [options.apiKey] - If provided, sent as Bearer token in Authorization header
 * @param {string} [options.apiVersion] - API namespace segment, default "v1". Use "v3" for the authenticated Vercel deploy endpoints.
 * @returns {Promise<Response>} Raw fetch Response — caller handles status/parsing
 */
export async function platformApiCall(method, path, body, options = {}) {
  const apiBaseUrl = process.env.VITE_API_BASE_URL;
  const appId = process.env.VITE_APP_ID;
  const apiVersion = options.apiVersion || "v1";

  const url = `${apiBaseUrl}/api/apps/${apiVersion}/${appId}/${path}`;
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
