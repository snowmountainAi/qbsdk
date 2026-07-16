import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { platformApiCall } from "../bin/lib/common.js";

function stubFetch() {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    };
  };
  return calls;
}

test("platformApiCall builds a v1 URL by default and sends no auth header", async () => {
  process.env.VITE_API_BASE_URL = "https://platform.example.com";
  process.env.VITE_APP_ID = "app-123";
  const calls = stubFetch();

  await platformApiCall("GET", "get-server-project");

  assert.equal(
    calls[0].url,
    "https://platform.example.com/api/apps/v1/app-123/get-server-project",
  );
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

test("platformApiCall targets the v3 namespace and sets the Bearer token", async () => {
  process.env.VITE_API_BASE_URL = "https://platform.example.com";
  process.env.VITE_APP_ID = "app-123";
  const calls = stubFetch();

  await platformApiCall(
    "POST",
    "set-server-url",
    { url: "https://x.vercel.app" },
    { apiVersion: "v3", apiKey: "deploy-tok" },
  );

  assert.equal(
    calls[0].url,
    "https://platform.example.com/api/apps/v3/app-123/set-server-url",
  );
  assert.equal(calls[0].opts.headers.Authorization, "Bearer deploy-tok");
  assert.equal(calls[0].opts.body, JSON.stringify({ url: "https://x.vercel.app" }));
});

test("deploy token formula is sha256(appId + DEPLOY_AUTH_SECRET) — cross-repo contract", () => {
  // Must match the platform's withDeployAuth (qwikbuild-next) and agentQ.
  const token = createHash("sha256")
    .update("app-123" + "test-deploy-secret")
    .digest("hex");
  assert.equal(
    token,
    "e62a16ac60f4b97ca842871a17e84794030a3617179c540bbc969c7579fcb08b",
  );
});
