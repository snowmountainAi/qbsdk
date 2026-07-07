import { randomUUID } from "node:crypto";
import { Vercel } from "@vercel/sdk";
import { Framework, SkipAutoDetectionConfirmation } from "@vercel/sdk/models/createdeploymentvaluedeployments2.js";
import {
  TwoTarget,
  TwoType,
} from "@vercel/sdk/models/createprojectenvop.js";
import { parseBackendEnvFile } from "./parse-env-file.js";
import { resolveBackendRoot } from "./backend-path.js";

const MAX_PROJECT_NAME_LENGTH = 100;

const SECRET_KEY_PATTERN =
  /(?:secret|password|token|key|url|database|postgres|s3|jwt|api)/i;

const REQUIRED_PROJECT_ENV = {
  VERCEL_EXPERIMENTAL_BACKENDS: "1",
};

const backendProjectSettings = {
  framework: Framework.Hono,
  installCommand: "npm install",
  buildCommand: null,
};

const TERMINAL_READY_STATES = new Set(["READY", "ERROR", "CANCELED"]);

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

  await vercel.projects.createProjectEnv({
    idOrName: projectIdOrName,
    upsert: "true",
    teamId,
    requestBody: entries.map(([key, value]) => ({
      key,
      value,
      type: getEnvVarType(key),
      target: [TwoTarget.Production, TwoTarget.Preview, TwoTarget.Development],
    })),
  });

  return entries.length;
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
  } = options;

  if (!files?.length) {
    throw new Error("No deployment files collected");
  }

  const sanitizedName = sanitizeProjectName(deploymentName);

  if (projectId) {
    await syncBackendEnvToProject(projectId, { vercel, teamId, platformEnv });
  }

  const deployment = await vercel.deployments.createDeployment({
    requestBody: {
      name: sanitizedName,
      files,
      project: projectId,
      projectSettings: config,
      target: "production",
    },
    skipAutoDetectionConfirmation: config
      ? SkipAutoDetectionConfirmation.Zero
      : SkipAutoDetectionConfirmation.One,
    teamId,
  });

  const targetProjectId = projectId ?? deployment.projectId;

  if (!projectId) {
    await vercel.projects.updateProject({
      requestBody: { ssoProtection: null },
      idOrName: deployment.projectId,
      teamId,
    });

    await syncBackendEnvToProject(targetProjectId, { vercel, teamId, platformEnv });
  }

  let finalDeployment = deployment;

  if (!projectId) {
    finalDeployment = await vercel.deployments.createDeployment({
      requestBody: {
        deploymentId: deployment.id,
        name: sanitizedName,
        project: targetProjectId,
        target: "production",
      },
      teamId,
    });
  }

  if (domain) {
    await vercel.projects.addProjectDomain({
      idOrName: targetProjectId,
      requestBody: { name: domain },
      teamId,
    });
  }

  return {
    deployment: finalDeployment,
    projectId: targetProjectId,
    url: finalDeployment.url ? `https://${finalDeployment.url}` : undefined,
  };
}

export async function getDeploymentStatus(deploymentId, options = {}) {
  const { vercel = createVercelClient() } = options;
  const deployment = await vercel.deployments.getDeployment({
    idOrUrl: deploymentId,
  });

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
