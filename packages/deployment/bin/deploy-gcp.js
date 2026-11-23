#!/usr/bin/env node
// Deploy and inspect a GCP-template app backend on Google Cloud Run.
//
// The sandbox holds no Google credentials. `server` packs backend/ and shared/
// and sends them to AgentQ, which builds the image with Cloud Build and deploys
// the app tier's Cloud Run service. `status` and `logs` read that service.
//
// Usage:
//   npx qb-deploy-gcp server   [--tier dev|staging|production]
//   npx qb-deploy-gcp frontend [--tier ...] [--no-build]
//   npx qb-deploy-gcp status [--tier ...]
//   npx qb-deploy-gcp logs   [--tier ...] [--since 1h] [--severity ERROR] [--limit 200] [--build <id>]
//   npx qb-deploy-gcp help
//
// Tier: --tier, else QB_TIER (set by the platform for tier work), else production.
//
// Required env vars:
//   AGENTQ_API_URL     - AgentQ backend base URL
//   URL_SLUG           - Project URL slug
//   DEPLOY_AUTH_TOKEN  - Per-app deploy token, sha256(appId + DEPLOY_AUTH_SECRET)

import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, ROOT_DIR } from "./lib/common.js";

const COMMANDS = ["server", "frontend", "status", "logs", "help"];
const BOOLEAN_FLAGS = ["no-build"];
const TIERS = ["production", "dev", "staging"];
const SEVERITIES = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"];
const POLL_MS = 4000;
const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;

export function parseArgs(argv, env = {}) {
  const [command = "help", ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    if (BOOLEAN_FLAGS.includes(a.slice(2))) { opts[a.slice(2)] = true; continue; }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    let value = eq === -1 ? rest[i + 1] : a.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
      i++;
    }
    opts[key] = value;
  }
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Use: ${COMMANDS.join(", ")}`);
  const allowed = { server: ["tier"], frontend: ["tier", "no-build"], status: ["tier"], logs: ["tier", "since", "severity", "limit", "build"], help: [] }[command];
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) throw new Error(`--${k} is not an option of "${command}"`);
  }
  opts.tier = normalizeTier(opts.tier ?? env.QB_TIER);
  if (opts.severity) {
    opts.severity = opts.severity.toUpperCase();
    if (!SEVERITIES.includes(opts.severity)) throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`);
  }
  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("--limit must be a whole number from 1 to 1000");
    opts.limit = n;
  }
  if (opts.since !== undefined && !/^(\d+[mhd]|\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2}))$/.test(opts.since)) {
    throw new Error("--since must be like 30m, 2h, 1d or 2026-11-23T08:00:00Z");
  }
  return { command, opts };
}

export function normalizeTier(tier) {
  const t = (tier || "production").trim().toLowerCase();
  const n = t === "prod" ? "production" : t;
  if (!TIERS.includes(n)) throw new Error(`Unknown tier "${tier}". Use dev, staging or production`);
  return n;
}

function config() {
  const missing = ["AGENTQ_API_URL", "URL_SLUG", "DEPLOY_AUTH_TOKEN"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Error: missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  return {
    base: `${process.env.AGENTQ_API_URL.replace(/\/+$/, "")}/projects/${encodeURIComponent(process.env.URL_SLUG)}/gcp`,
    headers: { Authorization: `Bearer ${process.env.DEPLOY_AUTH_TOKEN}` },
  };
}

async function api(cfg, path, init = {}) {
  const res = await fetch(`${cfg.base}${path}`, { ...init, headers: { ...cfg.headers, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 500) }; }
  if (!res.ok) {
    const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    const err = new Error(`${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ─── server ────────────────────────────────────────────────────────────────

// tar writes to stdout: no archive path for tar to misread (GNU tar takes
// "C:\..." for a remote host) and nothing left in tmp.
function createArchive(dirs = null) {
  if (!dirs) {
    if (!existsSync(join(ROOT_DIR, "backend", "package.json"))) {
      throw new Error("backend/package.json not found. Run this from the project root.");
    }
    dirs = ["backend", ...(existsSync(join(ROOT_DIR, "shared")) ? ["shared"] : [])];
  }
  const args = [
    "-czf", "-",
    "--exclude=node_modules", "--exclude=.env", "--exclude=.env.*",
    "--exclude=.vercel", "--exclude=.git",
    // Build output is never part of the backend source (but is the frontend upload).
    ...(dirs.includes("dist") ? [] : ["--exclude=dist"]),
    ...dirs,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { cwd: ROOT_DIR, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar failed (${code}): ${err.trim()}`))));
  });
}

async function deployServer(cfg, opts) {
  console.log(`Deploying backend to Cloud Run (tier: ${opts.tier})`);
  const archive = await createArchive();
  console.log(`Uploading ${(archive.length / 1024).toFixed(0)} KB of source`);
  const form = new FormData();
  form.append("file", new Blob([archive], { type: "application/gzip" }), "backend.tar.gz");
  const start = await api(cfg, `/backend/deploy${query({ tier: opts.tier })}`, { method: "POST", body: form });
  console.log(`Build ${start.deployId} started for service ${start.service} (${start.region})`);

  let cursor;
  let phase = "building";
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let p;
    try {
      p = await api(cfg, `/backend/deploys/${start.deployId}${query({ after: cursor })}`);
    } catch (e) {
      if (e.status >= 500 || e.cause) { console.log(`   (progress check failed, retrying: ${e.message})`); continue; }
      throw e;
    }
    for (const line of p.logs || []) console.log(`   | ${line.text}`);
    cursor = p.cursor || cursor;
    if (p.phase !== phase) {
      phase = p.phase;
      if (phase === "deploying") console.log("Build succeeded. Deploying the new revision...");
    }
    if (phase === "done") {
      console.log(`Deployed revision ${p.revision}`);
      console.log(`Backend URL: ${p.url}`);
      return 0;
    }
    if (phase === "failed") {
      console.error(`Deploy failed: ${p.error}`);
      console.error(`Build log: npx qb-deploy-gcp logs --tier ${opts.tier} --build ${start.deployId}`);
      return 1;
    }
  }
  console.error(`Timed out waiting for the deploy. Check: npx qb-deploy-gcp status --tier ${opts.tier}`);
  return 1;
}

// ─── frontend ──────────────────────────────────────────────────────────────

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT_DIR, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} failed (${code})`))));
  });
}

async function deployFrontend(cfg, opts) {
  console.log(`Deploying frontend (tier: ${opts.tier})`);
  if (!opts["no-build"]) {
    console.log("Building: pnpm run frontend:build");
    await run("pnpm", ["run", "frontend:build"]);
  }
  if (!existsSync(join(ROOT_DIR, "dist", "index.html"))) {
    throw new Error("dist/index.html not found. The build writes to dist/ at the project root.");
  }
  const archive = await createArchive(["dist"]);
  console.log(`Uploading ${(archive.length / 1024).toFixed(0)} KB`);
  const form = new FormData();
  form.append("file", new Blob([archive], { type: "application/gzip" }), "dist.tar.gz");
  const r = await api(cfg, `/frontend/deploy${query({ tier: opts.tier })}`, { method: "POST", body: form });
  console.log(`Release ${r.release} is live (${r.files} files, ${r.seconds}s)`);
  console.log(`Frontend URL: ${r.url}`);
  if (r.firstDeploy) {
    console.log("First deploy of this app's hostname: it can take 2-5 minutes to reach every edge.");
  }
  return 0;
}

// ─── status / logs ─────────────────────────────────────────────────────────

async function status(cfg, opts) {
  const s = await api(cfg, `/backend/status${query({ tier: opts.tier })}`);
  if (!s.exists) {
    console.log(`No service yet for tier ${opts.tier}. Deploy with: npx qb-deploy-gcp server --tier ${opts.tier}`);
  } else {
    console.log(`Service:   ${s.service} (${s.region}, tier ${s.tier})`);
    console.log(`URL:       ${s.url}`);
    console.log(`Ready:     ${s.ready ? "yes" : "NO"}${s.readyMessage ? ` (${s.readyMessage})` : ""}`);
    console.log(`Serving:   ${s.latestRevision || "-"}`);
    if (s.latestCreatedRevision && s.latestCreatedRevision !== s.latestRevision) {
      console.log(`Newest:    ${s.latestCreatedRevision} (not serving: it failed to start)`);
    }
    console.log(`Updated:   ${s.updateTime}`);
  }
  if (s.lastBuild) {
    console.log(`Last build: ${s.lastBuild.id} ${s.lastBuild.status} (${s.lastBuild.createTime})`);
  }
  return 0;
}

async function logs(cfg, opts) {
  const r = await api(cfg, `/backend/logs${query({ tier: opts.tier, since: opts.since, severity: opts.severity, limit: opts.limit, build: opts.build })}`);
  if (!r.logs.length) {
    console.log(opts.build ? "No log lines for that build." : "No log lines in that window. Try --since 6h.");
    return 0;
  }
  for (const l of r.logs) {
    console.log(opts.build ? l.text : `${(l.time || "").slice(0, 19).replace("T", " ")} ${l.severity.padEnd(7)} ${l.text}`);
  }
  return 0;
}

function help() {
  console.log(`qb-deploy-gcp: deploy and inspect this app's backend on Google Cloud Run

  npx qb-deploy-gcp server   [--tier dev|staging|production]
  npx qb-deploy-gcp frontend [--tier ...] [--no-build]
  npx qb-deploy-gcp status [--tier ...]
  npx qb-deploy-gcp logs   [--tier ...] [--since 1h] [--severity ERROR] [--limit 200] [--build <id>]

Tier defaults to QB_TIER, else production.`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  loadEnv();
  let parsed;
  try {
    parsed = parseArgs(argv, process.env);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return 2;
  }
  const { command, opts } = parsed;
  if (command === "help") return help();
  const cfg = config();
  try {
    if (command === "server") return await deployServer(cfg, opts);
    if (command === "frontend") return await deployFrontend(cfg, opts);
    if (command === "status") return await status(cfg, opts);
    return await logs(cfg, opts);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    return 1;
  }
}

// Run when executed (npx goes through a symlink in node_modules/.bin), not when imported by tests.
const invoked = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href; } catch { return false; }
})();
if (invoked) {
  main().then((code) => process.exit(code));
}
