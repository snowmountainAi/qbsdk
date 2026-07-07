import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./common.js";

const DEFAULT_CANDIDATES = ["backend"];

/**
 * Resolve the backend directory inside a QwikBuild project.
 * Uses BACKEND_DIR when set, otherwise picks the first existing candidate.
 */
export function resolveBackendRoot(rootDir = ROOT_DIR) {
  const custom = process.env.BACKEND_DIR;
  if (custom) {
    const resolved = join(rootDir, custom);
    if (!existsSync(resolved)) {
      throw new Error(`BACKEND_DIR does not exist: ${resolved}`);
    }
    return resolved;
  }

  for (const dir of DEFAULT_CANDIDATES) {
    const candidate = join(rootDir, dir);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No backend directory found. Set BACKEND_DIR or create one of: ${DEFAULT_CANDIDATES.join(", ")}`,
  );
}
