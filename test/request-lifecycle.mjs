import assert from "node:assert/strict"
import { test } from "node:test"
import { createRequestTrace, waitWithSignal } from "../request-lifecycle.mjs"

test("monotonic spans, TTFT and end-to-end latency are distinct and emitted once", async () => {
  let time = 0
  const rows = []
  const trace = createRequestTrace({ enabled: true, now: () => time, emit: row => rows.push(row) })
  await trace.measure("catalog", async () => { time = 4 })
  await trace.measure("startup", async () => { time = 14 })
  time = 30; trace.output("thinking")
  time = 50; trace.output("text")
  time = 70; trace.finish("completed", 200)
  trace.finish("error", 500)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].total_ms, 70)
  assert.equal(rows[0].first_output_ms, 30)
  assert.equal(rows[0].first_text_ms, 50)
  assert.equal(rows[0].after_first_output_ms, 40)
  assert.deepEqual(rows[0].stages_ms, { catalog: 4, startup: 10 })
})

test("diagnostics are opt-in, record failed spans, tolerate failing writers", async () => {
  const rows = []
  createRequestTrace({ emit: row => rows.push(row) }).finish("completed", 200)
  assert.equal(rows.length, 0)
  let time = 0
  const trace = createRequestTrace({ enabled: true, now: () => time, emit: row => rows.push(row) })
  await assert.rejects(trace.measure("startup", async () => { time = 9; throw new Error("secret") }))
  trace.finish("error", 502)
  assert.equal(rows[0].stages_ms.startup, 9)
  assert.equal(rows[0].first_text_ms, null)
  assert.ok(!JSON.stringify(rows).includes("secret"))
  assert.doesNotThrow(() => createRequestTrace({ enabled: true, emit() { throw new Error() } }).finish("error", 502))
})

test("cancelling a wait never cancels its shared owner or leaks listeners", async () => {
  const controller = new AbortController()
  let resolve, add = 0, remove = 0
  const signal = controller.signal
  const nativeAdd = signal.addEventListener.bind(signal), nativeRemove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (...args) => { add++; return nativeAdd(...args) }
  signal.removeEventListener = (...args) => { remove++; return nativeRemove(...args) }
  const owner = new Promise(r => { resolve = r })
  const result = assert.rejects(waitWithSignal(owner, signal), { name: "AbortError" })
  controller.abort("sensitive reason")
  await result
  resolve("owner-finished")
  assert.equal(await owner, "owner-finished")
  await Promise.resolve()
  assert.ok(remove >= add)
})

test("abort diagnostics snapshot unfinished spans without waiting for shared work", async () => {
  const rows = []
  let time = 0, resolve
  const trace = createRequestTrace({ enabled: true, now: () => time, emit: row => rows.push(row) })
  const pending = trace.measure("startup", () => new Promise(r => { resolve = r }))
  time = 12
  trace.finish("cancelled", 499)
  assert.equal(rows[0].stages_ms.startup, 12)
  time = 100; resolve(); await pending
  assert.equal(rows[0].stages_ms.startup, 12)
  assert.equal(rows.length, 1)
})

test("a queued cancellation captures elapsed wait without releasing the real lock", () => {
  let time = 0
  const rows = []
  const trace = createRequestTrace({ enabled: true, now: () => time, emit: row => rows.push(row) })
  const end = trace.span("lock_wait")
  time = 23
  trace.finish("cancelled", 499)
  assert.equal(rows[0].stages_ms.lock_wait, 23)
  time = 100; end(); end()
  assert.equal(rows[0].stages_ms.lock_wait, 23)
})
