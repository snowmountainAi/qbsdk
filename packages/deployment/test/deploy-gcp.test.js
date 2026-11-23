import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, normalizeTier } from "../bin/deploy-gcp.js";

test("tier defaults to QB_TIER, then production; prod is an alias", () => {
  assert.equal(parseArgs(["server"]).opts.tier, "production");
  assert.equal(parseArgs(["server"], { QB_TIER: "dev" }).opts.tier, "dev");
  assert.equal(parseArgs(["server", "--tier", "staging"], { QB_TIER: "dev" }).opts.tier, "staging");
  assert.equal(normalizeTier("prod"), "production");
  assert.throws(() => normalizeTier("qa"), /Unknown tier/);
});

test("logs options are validated", () => {
  const { opts } = parseArgs(["logs", "--since=2h", "--severity", "error", "--limit", "50"]);
  assert.deepEqual([opts.since, opts.severity, opts.limit], ["2h", "ERROR", 50]);
  assert.throws(() => parseArgs(["logs", "--since", "yesterday"]), /--since/);
  assert.throws(() => parseArgs(["logs", "--severity", "LOUD"]), /--severity/);
  assert.throws(() => parseArgs(["logs", "--limit", "5000"]), /--limit/);
  assert.equal(parseArgs(["logs", "--since", "2026-11-23T08:00:00Z"]).opts.since, "2026-11-23T08:00:00Z");
});

test("unknown commands and options are rejected", () => {
  assert.throws(() => parseArgs(["deploy"]), /Unknown command/);
  assert.throws(() => parseArgs(["status", "--since", "1h"]), /not an option/);
  assert.throws(() => parseArgs(["server", "--tier"]), /needs a value/);
  assert.throws(() => parseArgs(["server", "extra"]), /Unexpected argument/);
});

test("frontend takes --tier and the --no-build switch", () => {
  const { opts } = parseArgs(["frontend", "--no-build", "--tier", "dev"]);
  assert.equal(opts["no-build"], true);
  assert.equal(opts.tier, "dev");
  assert.throws(() => parseArgs(["server", "--no-build"]), /not an option/);
});
