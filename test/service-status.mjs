import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createServiceStatus, isServiceSuspension, TOS_MESSAGE } from "../service-status.mjs"
import { createUsageReader } from "../usage.mjs"

const detail = { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }
test("classify explicit TOS denial, not generic permissions, region or quota errors", () => {
  const error = { code: 403, status: "PERMISSION_DENIED", details: [detail] }
  assert.equal(isServiceSuspension({ error }), true)
  assert.equal(isServiceSuspension(JSON.stringify({ error })), true)
  assert.equal(isServiceSuspension(TOS_MESSAGE), true)
  for (const other of [null, "403", "TOS_VIOLATION", "not eligible for your region", "quota exhausted",
    { error: { ...error, code: 429 } }, { error: { ...error, status: "UNAUTHENTICATED" } },
    { error: { ...error, details: [{ reason: "TOS_VIOLATION" }] } },
    { error: { ...error, details: [{ ...detail, reason: "ACCESS_DENIED" }] } }]) {
    assert.equal(isServiceSuspension(other), false, JSON.stringify(other))
  }
})

test("late quota success cannot clear suspension, including across a new runtime", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-service-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "service-status.json")
  const serviceStatus = createServiceStatus(file)
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  const read = createUsageReader(() => "/fake/agy", {
    signIn: async () => ({ state: "present", fp: "test", canRenew: true }), serviceStatus,
    queryUsage: async () => { started(); await new Promise(resolve => { release = resolve }); return { windows: [{ used: 0 }], plan: "Pro" } },
  })
  const pending = read()
  await entered
  serviceStatus.mark()
  release()
  const result = await pending
  assert.equal(result.signIn, "expired")
  assert.equal(result.plan, undefined)
  assert.deepEqual(result.windows, [])
  assert.equal(createServiceStatus(file).get(), true)
  assert.equal((await read()).signIn, "expired")
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
