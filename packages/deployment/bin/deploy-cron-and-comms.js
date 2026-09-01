#!/usr/bin/env node
// Deploy communication templates from backend/src/cron_n_comm_config.ts
// Usage: npx qb-deploy-cron-and-comms
// Requires: VITE_API_BASE_URL, VITE_APP_ID, QWIKBUILD_PLATFORM_API_KEY as environment variables

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, requireEnvVars, platformApiCall, ROOT_DIR } from "./lib/common.js";

loadEnv();

const env = requireEnvVars(["VITE_API_BASE_URL", "VITE_APP_ID", "QWIKBUILD_PLATFORM_API_KEY"]);
// Indicators for agents

console.log("==========================")
console.log("Deploying communication templates to Qwikbuild")
console.log("==========================")


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
    console.log("Template submission response:");
    console.log(`   Overall success: ${responseData.success}`);
    console.log(`   Message: ${responseData.message}`);

    let hasTemplateFailures = false;
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
        if (!result.success) {
          hasTemplateFailures = true;
          console.log(`      FIX: Check Twilio template rules — common issues:`);
          console.log(`           - Body must START and END with text (not variables)`);
          console.log(`           - Variables cannot be adjacent (need words between them)`);
          console.log(`           - Need at least (2x+1) non-variable words for x variables`);
          console.log(`           - No URL shorteners, no all-caps, no HTML/Markdown`);
          console.log(`           Use the comms_integration skill for full Twilio template guidelines.`);
        }
      });
    }

    if (hasTemplateFailures) {
      throw new Error("Some templates failed to deploy. See errors above.");
    }
  } catch (error) {
    console.error("Error deploying communication templates:", error.message);
    throw error;
  }
}

async function deployAll() {
  console.log("Starting deployment of communication templates...\n");

  try {
    await sendTemplatesForApproval();
    console.log("\nCommunication template deployment completed successfully!");
  } catch (error) {
    console.error("\nCommunication template deployment failed:", error.message);
    process.exit(1);
  }
}

// Run the script
deployAll().catch(e => { console.error(e); process.exit(1); });
