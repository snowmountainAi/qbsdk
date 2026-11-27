import { test } from "node:test";
import assert from "node:assert/strict";
import { publicEnv, withPublicViteAliases } from "../bin/lib/common.js";

test("publicEnv keeps only non-empty PUBLIC_* names", () => {
  const env = {
    PUBLIC_SUPPORT_EMAIL: "help@example.com",
    PUBLIC_MAX_UPLOAD_MB: "25",
    PUBLIC_EMPTY: "",
    PUBLIC_lower: "no",
    PUBLICX: "no",
    MY_PUBLIC_THING: "no",
    VITE_PUBLIC_ALREADY: "no",
    DATABASE_URL: "postgres://secret",
  };
  assert.deepEqual(publicEnv(env), {
    PUBLIC_SUPPORT_EMAIL: "help@example.com",
    PUBLIC_MAX_UPLOAD_MB: "25",
  });
});

test("withPublicViteAliases adds VITE_PUBLIC_* and keeps everything else", () => {
  const env = { PUBLIC_A: "1", PUBLIC_B: "2", PATH: "/bin", VITE_APP_ID: "app" };
  const { env: out, names } = withPublicViteAliases(env);
  assert.deepEqual(names, ["PUBLIC_A", "PUBLIC_B"]);
  assert.equal(out.PUBLIC_A, "1");
  assert.equal(out.VITE_PUBLIC_A, "1");
  assert.equal(out.VITE_PUBLIC_B, "2");
  assert.equal(out.PATH, "/bin");
  assert.equal(out.VITE_APP_ID, "app");
  assert.equal(env.VITE_PUBLIC_A, undefined, "input is not mutated");
});

test("an existing VITE_PUBLIC_* wins over the alias", () => {
  const { env: out } = withPublicViteAliases({ PUBLIC_A: "from-public", VITE_PUBLIC_A: "explicit" });
  assert.equal(out.VITE_PUBLIC_A, "explicit");
});

test("no PUBLIC_* variables leaves the env unchanged", () => {
  const env = { PATH: "/bin" };
  const { env: out, names } = withPublicViteAliases(env);
  assert.deepEqual(names, []);
  assert.deepEqual(out, env);
});
