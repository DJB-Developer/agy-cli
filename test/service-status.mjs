import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createServiceStatus, isServiceSuspension, TOS_MESSAGE } from "../service-status.mjs"
import { createUsageReader } from "../usage.mjs"

const detail = { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }
test("a persisted suspension notifies the host on reads as well as detection", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quarantine-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "service-status.json")
  let notified = 0
  const options = { onSuspended: () => { notified++ } }
  const status = createServiceStatus(file, options)
  assert.equal(status.get(), false)
  assert.equal(notified, 0)
  status.mark()
  assert.equal(notified, 1, "detecting TOS must initiate host account quarantine")
  const restored = createServiceStatus(file, options)
  assert.equal(restored.get(), true)
  assert.equal(notified, 2, "old suspended accounts must also be removed from routing")
})
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

test("local usage reads preserve persisted suspension across a new runtime", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-service-test-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "service-status.json")
  const serviceStatus = createServiceStatus(file)
  const read = createUsageReader({ serviceStatus })
  assert.equal((await read()).signIn, "kept")
  serviceStatus.mark()
  const result = await read()
  assert.equal(result.signIn, "expired")
  assert.equal(result.plan, undefined)
  assert.deepEqual(result.windows, [])
  const restored = createUsageReader({ serviceStatus: createServiceStatus(file) })
  assert.equal((await restored()).signIn, "expired")
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
