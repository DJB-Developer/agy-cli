import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import { createUsageReader } from "../usage.mjs"

test("unknown quota is neither exhausted nor a sign-out, with fresh results per read", async () => {
  const read = createUsageReader()
  const a = await read(), b = await read()
  assert.deepEqual(a.windows, [])
  assert.equal(a.signIn, "kept")
  assert.equal(a.plan, undefined)
  assert.match(a.error, /unavailable/)
  a.windows.push({ used: 100 })
  assert.deepEqual(b.windows, [])
})

test("a later local suspension is still reported and never cleared by refresh", async () => {
  let suspended = false, checks = 0
  const read = createUsageReader({ serviceStatus: {
    get: () => { checks++; return suspended },
    usage: () => ({ windows: [], error: "TOS_VIOLATION", signIn: "expired" }),
  } })
  assert.equal((await read()).signIn, "kept")
  suspended = true
  for (let i = 0; i < 3; i++) assert.equal((await read()).signIn, "expired")
  assert.equal(checks, 4)
})

test("published runtime excludes internal HTTP metadata readers and CLI quota fallback", () => {
  const root = new URL("../", import.meta.url)
  const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"))
  for (const file of ["quota-http.mjs", "plan.mjs"]) {
    assert.equal(pkg.files.includes(file), false)
    assert.equal(fs.existsSync(new URL(file, root)), false)
  }
  for (const file of pkg.files.filter(f => f.endsWith(".mjs"))) {
    const source = fs.readFileSync(new URL(file, root), "utf8")
    assert.doesNotMatch(source, /v1internal:|retrieveUserQuotaSummary|fetchAvailableModels|loadCodeAssist|readAccessToken/)
  }
  assert.doesNotMatch(fs.readFileSync(new URL("usage.mjs", root), "utf8"), /\b(?:fetch|spawn|execFile)\s*\(/)
})
