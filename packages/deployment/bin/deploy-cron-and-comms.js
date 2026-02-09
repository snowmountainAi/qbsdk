#!/usr/bin/env node
// Deploy cron jobs and communication templates from backend/src/cron_n_comm_config.ts
// Usage: npx qb-deploy-cron-and-comms
// Requires: VITE_API_BASE_URL, VITE_APP_ID, QWIKBUILD_PLATFORM_API_KEY as environment variables

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars(["VITE_API_BASE_URL", "VITE_APP_ID", "QWIKBUILD_PLATFORM_API_KEY"]);

// Dynamically import CONFIG from the project's backend config
let CONFIG;
const configPath = join(ROOT_DIR, "backend", "src", "cron_n_comm_config.ts");
if (!existsSync(configPath)) {
  console.error(`Error: Config file not found at: ${configPath}`);
  console.error("Expected file: backend/src/cron_n_comm_config.ts");
  process.exit(1);
}

try {
  const configModule = await import(pathToFileURL(configPath).href);
  CONFIG = configModule.CONFIG;
  if (!CONFIG) {
    throw new Error("CONFIG export not found in config file");
  }
} catch (error) {
  console.error(`Error loading config from ${configPath}:`, error.message);
  process.exit(1);
}

async function sendCronConfig() {
  try {
    const config = CONFIG;

    if (!config.cron || !Array.isArray(config.cron)) {
      throw new Error('Config file must contain a "cron" array');
    }

    console.log(`\nFound ${config.cron.length} cron job(s) to create:`);
    config.cron.forEach((job, index) => {
      console.log(`  ${index + 1}. ${job.name} - ${job.schedule}`);
    });

    if (config.cron.length === 0) {
      console.log("No cron jobs to deploy. Skipping deployment.");
      return;
    }

    console.log(`Sending cron config to platform...`);

    const response = await platformApiCall("POST", "cron/create", config.cron, {
      apiKey: env.QWIKBUILD_PLATFORM_API_KEY,
    });

    // Check if response is JSON
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const responseText = await response.text();
      console.error("Error: Server returned non-JSON response");
      console.error("Content-Type:", contentType);
      console.error("Response body:", responseText);
      throw new Error("Non-JSON response received");
    }

    const responseData = await response.json();

    if (!response.ok) {
      console.error("API Error:", response.status, response.statusText);
      console.error("Response:", JSON.stringify(responseData, null, 2));
      throw new Error(`API request failed: ${response.status}`);
    }

    // Display results
    console.log("Success! Cron schedules created:");
    console.log(`   Overall success: ${responseData.success}`);
    console.log(`   Message: ${responseData.message}`);

    if (responseData.results) {
      console.log("Individual results:");
      responseData.results.forEach((result, index) => {
        const status = result.success ? "OK" : "FAIL";
        console.log(
          `   ${status} ${result.name}: ${
            result.success ? "Created" : result.error
          }`
        );
        if (result.ruleArn) {
          console.log(`      ARN: ${result.ruleArn}`);
        }
      });
    }
  } catch (error) {
    console.error("Error deploying cron jobs:", error.message);
    throw error;
  }
}

async function sendTemplatesForApproval() {
  try {
    const config = CONFIG;

    if (
      !config.communication_templates ||
      !Array.isArray(config.communication_templates)
    ) {
      throw new Error('Config file must contain a "communication_templates" array');
    }

    if (config.communication_templates.length === 0) {
      console.log("\nNo templates found to submit for approval. Skipping.");
      return;
    }

    console.log(
      `\nFound ${config.communication_templates.length} template(s) to submit for approval:`
    );
    config.communication_templates.forEach((template, index) => {
      const name = template.friendly_name || `template_${index + 1}`;
      console.log(`  ${index + 1}. ${name}`);
    });

    console.log(`Sending templates to platform...`);

    const response = await platformApiCall("POST", "request-template-approval", config.communication_templates, {
      apiKey: env.QWIKBUILD_PLATFORM_API_KEY,
    });

    let responseData;
    try {
      responseData = await response.json();
    } catch (e) {
      const text = await response.text();
      console.error("API Error:", response.status, response.statusText);
      console.error("Response:", text);
      throw new Error(`Failed to parse response: ${text}`);
    }

    if (!response.ok) {
      console.error("API Error:", response.status, response.statusText);
      console.error("Response:", JSON.stringify(responseData, null, 2));
      throw new Error(`API request failed: ${response.status}`);
    }

    // Display results
    console.log("Success! Templates submitted for approval:");
    console.log(`   Overall success: ${responseData.success}`);
    console.log(`   Message: ${responseData.message}`);

    if (responseData.results) {
      console.log("Individual results:");
      responseData.results.forEach((result, index) => {
        const status = result.success ? "OK" : "FAIL";
        const name =
          result.name ||
          config.communication_templates[index]?.friendly_name ||
          `template_${index + 1}`;
        console.log(
          `   ${status} ${name}: ${result.success ? "Submitted" : result.error}`
        );
        if (result.id) {
          console.log(`      ID: ${result.id}`);
        }
      });
    }
  } catch (error) {
    console.error("Error deploying communication templates:", error.message);
    throw error;
  }
}

// Main function to run both deployments
async function deployAll() {
  console.log("Starting deployment of cron jobs and communication templates...\n");

  let hasFailure = false;

  try {
    await sendCronConfig();
    console.log("Cron deployment completed successfully!");
  } catch (error) {
    console.error("\nCron deployment failed:", error.message);
    hasFailure = true;
  }

  try {
    await sendTemplatesForApproval();
    console.log("Communication template deployment completed successfully!");
  } catch (error) {
    console.error("\nCommunication template deployment failed:", error.message);
    hasFailure = true;
  }

  if (hasFailure) {
    console.error("\nDeployment completed with failures. Exiting with error code.");
    process.exit(1);
  }

  console.log("\nAll deployments completed successfully!");
}

// Run the script
deployAll().catch(e => { console.error(e); process.exit(1); });
