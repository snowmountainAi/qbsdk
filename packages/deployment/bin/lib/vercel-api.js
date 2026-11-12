import { randomUUID } from "node:crypto";
import { Vercel } from "@vercel/sdk";

// The SDK's enums are plain string maps, and the generated files that export
// them get renamed between SDK releases (createdeploymentvaluedeployments2.js
// is gone in 1.28.61). Importing them pinned this package to one SDK build, so
// the values the Vercel API accepts are spelled out here instead.
const Framework = { Hono: "hono" };
const SkipAutoDetectionConfirmation = { Zero: "0", One: "1" };
const TwoTarget = { Production: "production", Preview: "preview", Development: "development" };
const TwoType = { Encrypted: "encrypted", Plain: "plain" };
import { parseBackendEnvFile } from "./parse-env-file.js";

/**
 * Await an SDK call, but accept Vercel's reply when only the SDK's response
 * schema rejects it. By then the request has succeeded; the SDK's generated
 * schema just lags the live API (a new nodeVersion such as "26.x", or a
 * project firewall config without `managedRules.traffic_sources`). Failing
 * there aborted deploys that Vercel had already accepted. Matched by name so
 * no SDK-internal module is imported.
 */
export async function tolerateSchemaDrift(promise, label = "Vercel API call") {
  try {
    return await promise;
  } catch (error) {
    if (error?.name === "ResponseValidationError" && error.rawValue !== undefined) {
      const paths = (error.cause?.issues ?? [])
        .flatMap((issue) => [issue, ...(issue.unionErrors ?? []).flatMap((u) => u.issues ?? [])])
        .map((issue) => (issue.path ?? []).join("."))
        .filter(Boolean);
      const where = [...new Set(paths)].slice(0, 3).join(", ");
      console.warn(
        `Warning: ${label} succeeded, but the Vercel SDK did not recognise part of the reply` +
          `${where ? ` (${where})` : ""}; continuing with the raw reply.`,
      );
      return error.rawValue;
    }
    throw error;
  }
}
import { resolveBackendRoot } from "./backend-path.js";

const MAX_PROJECT_NAME_LENGTH = 100;

const SECRET_KEY_PATTERN =
  /(?:secret|password|token|key|url|database|postgres|s3|jwt|api)/i;

const REQUIRED_PROJECT_ENV = {
  VERCEL_EXPERIMENTAL_BACKENDS: "1",
};

/**
 * Default to a single Function region colocated with our Neon DBs in
 * Singapore. Pro can use up to 3 regions; override with --regions /
 * VERCEL_REGIONS, or set "regions" in vercel.json.
 */
export const DEFAULT_FUNCTION_REGIONS = ["sin1"];

const backendProjectSettings = {
  framework: Framework.Hono,
  installCommand: "npm install",
  buildCommand: null,
};

const TERMINAL_READY_STATES = new Set(["READY", "ERROR", "CANCELED"]);

/**
 * Normalize a regions value from CLI, env, or vercel.json into a string[].
 * @param {string | string[] | undefined | null} value
 * @returns {string[] | undefined}
 */
export function parseRegions(value) {
  if (value == null || value === "") {
    return undefined;
  }

  const list = Array.isArray(value)
    ? value
    : String(value)
        .split(/[,\s]+/)
        .map((region) => region.trim())
        .filter(Boolean);

  return list.length > 0 ? list : undefined;
}

function readVercelJsonRegions(files = []) {
  const entry = files.find((file) => file.file === "vercel.json");
  if (!entry?.data) {
    return undefined;
  }

  try {
    return parseRegions(JSON.parse(entry.data).regions);
  } catch {
    return undefined;
  }
}

/**
 * Ensure the deployment payload's vercel.json includes the resolved regions.
 * @param {Array<{ file: string, data: string }>} files
 * @param {string[]} regions
 */
function withRegionsInVercelJson(files, regions) {
  const nextFiles = [...files];
  const index = nextFiles.findIndex((file) => file.file === "vercel.json");
  let config = { version: 2 };

  if (index >= 0) {
    try {
      config = JSON.parse(nextFiles[index].data);
    } catch {
      config = { version: 2 };
    }
  }

  const updated = {
    ...config,
    regions,
  };
  const entry = {
    file: "vercel.json",
    data: `${JSON.stringify(updated, null, 2)}\n`,
  };

  if (index >= 0) {
    nextFiles[index] = entry;
  } else {
    nextFiles.unshift(entry);
  }

  return nextFiles;
}

function sanitizeProjectName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROJECT_NAME_LENGTH);
}

function getEnvVarType(key) {
  if (key in REQUIRED_PROJECT_ENV) {
    return TwoType.Plain;
  }

  return SECRET_KEY_PATTERN.test(key) ? TwoType.Encrypted : TwoType.Plain;
}

/**
 * Merge backend .env with platform/runtime vars required at deploy time.
 */
export function buildDeployEnv(platformEnv = {}) {
  const backendEnv = parseBackendEnvFile();

  const merged = {
    ...REQUIRED_PROJECT_ENV,
    ...backendEnv,
    ...platformEnv,
  };

  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

export function createVercelClient(token = process.env.VERCEL_TOKEN) {
  if (!token) {
    throw new Error("VERCEL_TOKEN is required");
  }

  return new Vercel({ bearerToken: token });
}

/**
 * Push env vars from backend/.env (plus required overrides) to a Vercel project.
 */
export async function syncBackendEnvToProject(projectIdOrName, options = {}) {
  const {
    vercel = createVercelClient(),
    teamId = process.env.VERCEL_TEAM_ID,
    platformEnv = {},
  } = options;

  const env = buildDeployEnv(platformEnv);
  const entries = Object.entries(env);

  if (entries.length === 0) {
    return 0;
  }

  await tolerateSchemaDrift(
    vercel.projects.createProjectEnv({
      idOrName: projectIdOrName,
      upsert: "true",
      teamId,
      requestBody: entries.map(([key, value]) => ({
        key,
        value,
        type: getEnvVarType(key),
        target: [TwoTarget.Production, TwoTarget.Preview, TwoTarget.Development],
      })),
    }),
    "Syncing project env",
  );

  return entries.length;
}

/**
 * Pin the project's serverless Function compute region.
 *
 * IMPORTANT: on non-Enterprise Vercel plans the compute region is a PROJECT
 * setting (`serverlessFunctionRegion`, which also drives Fluid Compute's
 * `functionDefaultRegions`). The per-deployment `regions` field and a `regions`
 * key in vercel.json are NOT honored for Function compute — a deployment always
 * runs in the project's region. So to actually control where the backend runs,
 * qbsdk sets it on the project here, BEFORE building the deployment. Idempotent.
 */
export async function setProjectFunctionRegion(projectIdOrName, regions, options = {}) {
  const {
    vercel = createVercelClient(),
    teamId = process.env.VERCEL_TEAM_ID,
  } = options;
  const region = (Array.isArray(regions) && regions[0]) || DEFAULT_FUNCTION_REGIONS[0];
  if (!projectIdOrName || !region) return;
  await tolerateSchemaDrift(
    vercel.projects.updateProject({
      idOrName: projectIdOrName,
      teamId,
      requestBody: { serverlessFunctionRegion: region },
    }),
    "Setting the function region",
  );
}

/**
 * Create a Vercel deployment from collected backend files.
 * Mirrors lib/deploy-files.ts in the Next.js app.
 */
export async function deployBackendFiles(options = {}) {
  const {
    files,
    deploymentName = randomUUID(),
    projectId = process.env.VERCEL_PROJECT_ID || process.env.DEPLOY_FILES_PROJECT_ID,
    domain,
    vercel = createVercelClient(),
    teamId = process.env.VERCEL_TEAM_ID,
    platformEnv = {},
    config = backendProjectSettings,
    regions:
      explicitRegions = parseRegions(process.env.VERCEL_REGIONS) ??
      DEFAULT_FUNCTION_REGIONS,
  } = options;

  if (!files?.length) {
    throw new Error("No deployment files collected");
  }

  const regions = parseRegions(explicitRegions) ?? DEFAULT_FUNCTION_REGIONS;
  const deploymentFiles = withRegionsInVercelJson(files, regions);
  const sanitizedName = sanitizeProjectName(deploymentName);

  if (projectId) {
    // Pin the compute region on the project BEFORE building — this is what
    // Vercel actually honors (the per-deployment `regions` below is ignored).
    await setProjectFunctionRegion(projectId, regions, { vercel, teamId });
    await syncBackendEnvToProject(projectId, { vercel, teamId, platformEnv });
  }

  const deployment = await tolerateSchemaDrift(
    vercel.deployments.createDeployment({
      requestBody: {
        name: sanitizedName,
        files: deploymentFiles,
        project: projectId,
        projectSettings: config,
        target: "production",
        regions,
      },
      skipAutoDetectionConfirmation: config
        ? SkipAutoDetectionConfirmation.Zero
        : SkipAutoDetectionConfirmation.One,
      teamId,
    }),
    "Creating the deployment",
  );

  const targetProjectId = projectId ?? deployment.projectId;

  // Disable Vercel deployment protection (SSO / "Vercel Authentication") so the
  // app's public API is reachable without a Vercel login. Vercel turns this ON
  // by default for new projects. This must run for BOTH a provided projectId
  // (consoleq-provisioned) and an auto-created one — previously it only ran in
  // the auto-create branch, so once get-server-project returned a real project
  // id the deployments came up protected.
  await tolerateSchemaDrift(
    vercel.projects.updateProject({
      requestBody: { ssoProtection: null },
      idOrName: targetProjectId,
      teamId,
    }),
    "Turning off deployment protection",
  );

  let finalDeployment = deployment;

  if (!projectId) {
    // The project was auto-created by the first deployment above; now that it
    // exists, pin its compute region, sync the runtime env, and redeploy so the
    // app boots in the right region with its env.
    await setProjectFunctionRegion(targetProjectId, regions, { vercel, teamId });
    await syncBackendEnvToProject(targetProjectId, { vercel, teamId, platformEnv });
    finalDeployment = await tolerateSchemaDrift(
      vercel.deployments.createDeployment({
        requestBody: {
          deploymentId: deployment.id,
          name: sanitizedName,
          project: targetProjectId,
          target: "production",
          regions,
        },
        teamId,
      }),
      "Redeploying with env",
    );
  }

  if (domain) {
    await tolerateSchemaDrift(
      vercel.projects.addProjectDomain({
        idOrName: targetProjectId,
        requestBody: { name: domain },
        teamId,
      }),
      "Adding the domain",
    );
  }

  return {
    deployment: finalDeployment,
    projectId: targetProjectId,
    url: finalDeployment.url ? `https://${finalDeployment.url}` : undefined,
    regions,
  };
}

export async function getDeploymentStatus(deploymentId, options = {}) {
  const { vercel = createVercelClient() } = options;
  const deployment = await tolerateSchemaDrift(
    vercel.deployments.getDeployment({
      idOrUrl: deploymentId,
    }),
    "Reading the deployment status",
  );

  return {
    readyState: deployment.readyState,
    url: deployment.url,
    id: deployment.id,
  };
}

/**
 * Poll until the deployment reaches a terminal ready state.
 */
export async function waitForDeploymentReady(deploymentId, options = {}) {
  const {
    vercel = createVercelClient(),
    pollMs = 2000,
    maxAttempts = 60,
    onUpdate,
  } = options;

  let latest = await getDeploymentStatus(deploymentId, { vercel });
  onUpdate?.(latest);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (TERMINAL_READY_STATES.has(latest.readyState)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
    latest = await getDeploymentStatus(deploymentId, { vercel });
    onUpdate?.(latest);
  }

  if (latest.readyState === "READY") {
    return latest;
  }

  if (latest.readyState === "ERROR" || latest.readyState === "CANCELED") {
    throw new Error(`Deployment ${latest.readyState.toLowerCase()}`);
  }

  throw new Error("Deployment timed out");
}
