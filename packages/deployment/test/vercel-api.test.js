import { test } from "node:test";
import assert from "node:assert/strict";
import { Vercel } from "@vercel/sdk";
import { HTTPClient } from "@vercel/sdk/lib/http.js";
import { setProjectFunctionRegion, tolerateSchemaDrift } from "../bin/lib/vercel-api.js";

// A project whose Vercel Firewall was configured before Vercel added the
// `traffic_sources` managed rule: the live API omits it, the SDK schema
// requires it. This is the reply that broke deploys on 2026-11-12.
// Only the fields the SDK requires are kept, so `security` is the one it rejects.
const projectWithOldFirewall = {
  accountId: "team_x",
  id: "prj_x",
  name: "app-prod",
  nodeVersion: "24.x",
  alias: [],
  defaultResourceConfig: {
    fluid: true,
    functionDefaultRegions: ["sin1"],
    functionDefaultTimeout: 300,
    functionDefaultMemoryType: "standard",
    functionZeroConfigFailover: false,
    elasticConcurrencyEnabled: true,
  },
  resourceConfig: { fluid: true, functionDefaultRegions: ["sin1"], elasticConcurrencyEnabled: true },
  deploymentExpiration: {
    expirationDays: 30,
    expirationDaysProduction: 30,
    expirationDaysCanceled: 30,
    expirationDaysErrored: 30,
    deploymentsToKeep: 10,
  },
  security: {
    firewallEnabled: true,
    firewallConfigVersion: 6,
    botIdEnabled: false,
    ja3Enabled: true,
    ja4Enabled: true,
    firewallSeawallEnabled: false,
    securityPlus: false,
    attackModeEnabled: false,
    managedRules: {
      vercel_ruleset: { active: false },
      bot_filter: { active: false, action: "challenge" },
      ai_bots: { active: false, action: "deny" },
      owasp: { active: false },
    },
  },
};

function vercelReturning(body) {
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  return new Vercel({ bearerToken: "test", httpClient });
}

test("the raw SDK rejects a reply whose firewall config lacks traffic_sources", async () => {
  const vercel = vercelReturning(projectWithOldFirewall);
  await assert.rejects(
    vercel.projects.updateProject({ idOrName: "prj_x", requestBody: { serverlessFunctionRegion: "sin1" } }),
    { name: "ResponseValidationError" },
  );
});

test("setProjectFunctionRegion succeeds on that reply and warns once", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    await setProjectFunctionRegion("prj_x", ["sin1"], {
      vercel: vercelReturning(projectWithOldFirewall),
      teamId: "team_x",
    });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Setting the function region succeeded/);
  assert.match(warnings[0], /security/);
});

test("tolerateSchemaDrift returns the raw reply and rethrows other errors", async () => {
  const drift = Object.assign(new Error("Response validation failed"), {
    name: "ResponseValidationError",
    rawValue: { id: "dpl_1", url: "x.vercel.app" },
  });
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await tolerateSchemaDrift(Promise.reject(drift)), drift.rawValue);
  } finally {
    console.warn = original;
  }

  const http = Object.assign(new Error("Forbidden"), { name: "VercelError", statusCode: 403 });
  await assert.rejects(tolerateSchemaDrift(Promise.reject(http)), { message: "Forbidden" });
});
