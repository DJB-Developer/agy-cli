import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchAccountPlan, planOf } from "../plan.mjs"
import { readAccessToken } from "../signin.mjs"

test("plans prefer paid names, fall back to current tier, never infer eligible subscriptions", () => {
  assert.equal(planOf({ paidTier: { name: "Google AI Ultra" }, currentTier: { name: "Free" } }), "Google AI Ultra")
  assert.equal(planOf({ paidTier: { id: "g1-ultra-tier" }, currentTier: { name: "Free" } }), "Google AI Ultra")
  assert.equal(planOf({ paid_tier: { id: "g1-ultra-lite-tier" } }), "Google AI Ultra Lite")
  assert.equal(planOf({ currentTier: { id: "free-tier" } }), "Free")
  assert.equal(planOf({ paidTier: { id: "new-tier" } }), "new-tier")
  assert.equal(planOf({ paidTier: { id: "__proto__" } }), "__proto__")
  assert.equal(planOf({ paidTier: { id: "constructor" } }), "constructor")
  for (const data of [null, {}, { allowedTiers: [{ name: "Ultra" }] },
    { currentTier: { name: {}, id: [] } }, { currentTier: { name: "x".repeat(257) } }, { paidTier: { name: "bad\nname" } }]) {
    assert.equal(planOf(data), "")
  }
})

test("metadata call uses only the selected access token and does not retain a stale plan", async () => {
  const calls = []
  let name = "Google AI Pro"
  const options = {
    geminiDir: "/profiles/a", env: {},
    readToken: async options => { assert.equal(options.geminiDir, "/profiles/a"); return "fake-access-a" },
    fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ paidTier: { name } }) },
  }
  assert.equal(await fetchAccountPlan(options), "Google AI Pro")
  name = "Google AI Ultra"
  assert.equal(await fetchAccountPlan(options), "Google AI Ultra")
  name = ""
  assert.equal(await fetchAccountPlan(options), "")
  assert.equal(calls.length, 3)
  for (const { url, init } of calls) {
    assert.equal(url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
    assert.equal(init.method, "POST")
    assert.equal(init.headers.Authorization, "Bearer fake-access-a")
    assert.deepEqual(JSON.parse(init.body), { metadata: { ideType: "ANTIGRAVITY" } })
    assert.equal(init.redirect, "error")
    assert.doesNotMatch(init.body, /token|refresh|prompt|message/)
  }
})

test("missing tokens, HTTP failures, malformed and oversized bodies omit plan without exposing errors", async () => {
  let calls = 0
  assert.equal(await fetchAccountPlan({ readToken: async () => "", fetch: () => { calls++ } }), "")
  assert.equal(calls, 0)
  for (const fetch of [
    async () => { throw Error("private credential") },
    async () => new Response("private error", { status: 401 }),
    async () => new Response("private error", { status: 403 }),
    async () => new Response("private error", { status: 429 }),
    async () => new Response("not json"),
    async () => new Response("x".repeat(64 * 1024 + 1)),
    async () => Response.json({}),
  ]) assert.equal(await fetchAccountPlan({ readToken: async () => "fake", fetch }), "")
  assert.equal(await fetchAccountPlan({ readToken: async () => { throw Error("private read error") } }), "")
})

test("deadline bounds credential reads and HTTP, and cancellation prevents late requests", async () => {
  let release, calls = 0
  const started = Date.now()
  assert.equal(await fetchAccountPlan({ timeoutMs: 25,
    readToken: () => new Promise(resolve => { release = resolve }),
    fetch: () => { calls++; return Response.json({}) },
  }), "")
  assert.ok(Date.now() - started < 1000)
  release("late-token")
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0)
  let httpSignal
  assert.equal(await fetchAccountPlan({ timeoutMs: 25, readToken: async () => "fake",
    fetch: async (_url, init) => { httpSignal = init.signal; return new Promise(() => {}) },
  }), "")
  assert.equal(httpSignal.aborted, true)
  const controller = new AbortController()
  const pending = fetchAccountPlan({ signal: controller.signal, readToken: () => new Promise(() => {}) })
  controller.abort()
  assert.equal(await pending, "")
  assert.equal(await fetchAccountPlan({ signal: controller.signal, readToken: () => { calls++ } }), "")
  assert.equal(calls, 0)
})

test("named credential files are isolated, unchanged, and never fall back to the default account", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-plan-test-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const fileOf = name => path.join(root, name, "antigravity-cli", "antigravity-oauth-token")
  const store = async (name, token) => {
    await fs.mkdir(path.dirname(fileOf(name)), { recursive: true })
    await fs.writeFile(fileOf(name), JSON.stringify({ token }), { mode: 0o600 })
  }
  await store("a", { access_token: "access-a", refresh_token: "refresh-a", expiry: "2099-01-01T00:00:00Z" })
  await store("b", { access_token: "access-b" })
  const original = await fs.readFile(fileOf("a"), "utf8")
  let keyringReads = 0
  const read = name => readAccessToken({ geminiDir: path.join(root, name), env: {},
    exec: async () => { keyringReads++; return { code: 0, stdout: original } },
  })
  assert.deepEqual(await Promise.all([read("a"), read("b")]), ["access-a", "access-b"])
  assert.equal(await read("missing"), "")
  assert.equal(await fs.readFile(fileOf("a"), "utf8"), original)
  for (const token of [{ refresh_token: "refresh-only" }, { access_token: "expired", expiry: "2000-01-01" }, { access_token: "bad\nheader" }]) {
    await store("b", token)
    assert.equal(await read("b"), "")
  }
  await fs.writeFile(fileOf("b"), "not-json")
  assert.equal(await read("b"), "")
  assert.equal(keyringReads, 0)
  assert.equal(await readAccessToken({ geminiDir: path.join(root, "a"), env: { GEMINI_API_KEY: "fake" } }), "")
})

test("default credentials support headless Linux and native keyrings without writes", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-plan-default-"))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const raw = JSON.stringify({ token: { access_token: "default-access", refresh_token: "not-for-api" } })
  const directory = path.join(home, ".gemini", "antigravity-cli")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "antigravity-oauth-token"), raw)
  assert.equal(await readAccessToken({ platform: "linux", env: {}, home }), "default-access")
  for (const [platform, stdout] of [
    ["darwin", "go-keyring-base64:" + Buffer.from(raw).toString("base64")],
    ["darwin", "go-keyring-encoded:" + Buffer.from(raw).toString("hex")],
    ["win32", "OK " + Buffer.from(raw).toString("base64")],
    ["linux", raw],
  ]) assert.equal(await readAccessToken({ platform, env: { DBUS_SESSION_BUS_ADDRESS: "test" }, home,
    exec: async () => ({ code: 0, stdout }),
  }), "default-access")
  // A locked keyring must not silently use the headless file's account.
  assert.equal(await readAccessToken({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "test" }, home,
    exec: async () => ({ code: 1, stdout: "", stderr: "locked" }),
  }), "")
})
