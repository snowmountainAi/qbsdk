import { test } from "node:test";
import assert from "node:assert/strict";
import { psqlUrl, psqlArgs } from "../bin/psql-url.js";

test("no-verify becomes require for libpq", () => {
  assert.equal(
    psqlUrl("postgresql://u:p@10.0.0.1:5432/db?sslmode=no-verify"),
    "postgresql://u:p@10.0.0.1:5432/db?sslmode=require",
  );
});

test("other URLs are unchanged", () => {
  const neon = "postgresql://u:p@ep-x.neon.tech/db?sslmode=require";
  assert.equal(psqlUrl(neon), neon);
});

test("options come before the connection string", () => {
  assert.deepEqual(psqlArgs("postgresql://h/db", "-v", "ON_ERROR_STOP=1"), [
    "-v", "ON_ERROR_STOP=1", "-d", "postgresql://h/db",
  ]);
});
