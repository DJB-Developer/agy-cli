import assert from "node:assert/strict"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse, continueWithToolResults, sleep } from "./testkit.mjs"

async function withKit(options, fn) {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_STEP_USAGE: "0", ...options.env }, ...options })
  try { await fn(kit) } finally { await kit.dispose() }
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await sleep(5) }
  assert.fail("condition did not settle within 500ms")
}
const next = (body, reply) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: reply.content }, { role: "user", content: "next" }] })

test("explicit sessions with identical openings run independently and reuse only their own session", async () => {
  await withKit({}, async kit => {
    kit.defaultPrompt = async a => { await a.text(a.sessionId); return { stopReason: "end_turn" } }
    const bodies = ["one", "two"].map(session_id => baseBody({ tools: [], metadata: { user_id: "same-user", session_id } }))
    const replies = await Promise.all(bodies.map(async b => readSse(await kit.request(b))))
    assert.notEqual(replies[0].content[0].text, replies[1].content[0].text)
    for (let i = 0; i < 2; i++) {
      const follow = await readSse(await kit.request(next(bodies[i], replies[i])))
      assert.equal(follow.content[0].text, replies[i].content[0].text)
    }
    assert.equal(kit.acpSpawns.length, 2)
  })
})

test("a foreign user cannot submit another user's live tool result", async () => {
  await withKit({}, async kit => {
    let delivered = false
    kit.defaultPrompt = async a => { await a.tool("Read", { path: "/private" }); delivered = true; await a.text("done") }
    const body = baseBody({ metadata: { user_id: "owner", session_id: "chat" } })
    const first = await readSse(await kit.request(body))
    const follow = continueWithToolResults(body, first)
    const foreign = await kit.request({ ...follow, metadata: { user_id: "other", session_id: "chat" } })
    assert.equal(foreign.status, 409)
    assert.equal(delivered, false)
    const own = await readSse(await kit.request(follow))
    assert.equal(own.content[0].text, "done")
  })
})

test("already aborted requests do not start ACP or send a prompt", async () => {
  await withKit({}, async kit => {
    kit.defaultPrompt = async a => { await a.text("must not run") }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(kit.request(baseBody({ tools: [] }), { signal: controller.signal }), { name: "AbortError" })
    assert.equal(kit.acpSpawns.length, 0)
    assert.equal(kit.promptSerial, 0)
  })
})

test("abort during session creation stops that process without sending prompt", async () => {
  await withKit({ sessionNewDelayMs: 180 }, async kit => {
    kit.defaultPrompt = async a => { await a.text("must not run") }
    const controller = new AbortController()
    const pending = kit.request(baseBody({ tools: [] }), { signal: controller.signal })
    const rejected = assert.rejects(pending, { name: "AbortError" })
    await until(() => kit.acpLog.some(e => e.method === "session/new"))
    controller.abort()
    await rejected
    await until(() => kit.module.__agyTestAllProcs.size === 0)
    await sleep(200)
    assert.equal(kit.promptSerial, 0)
  })
})

test("body reader cancellation reaches ACP before its unfinished prompt returns", async () => {
  await withKit({}, async kit => {
    kit.defaultPrompt = async a => { await a.waitCancel(); return { stopReason: "cancelled" } }
    const response = await kit.request(baseBody({ tools: [] }))
    const reader = response.body.getReader()
    await reader.read()
    await until(() => kit.promptSerial === 1)
    const cancelled = reader.cancel()
    await until(() => kit.acpLog.some(e => e.method === "session/cancel"))
    await cancelled
    await until(() => [...kit.module.__agyTestAllProcs].every(p => !p.turn))
    assert.equal(kit.turns[0].waiters.length, 0)
  })
})

const timingRows = kit => kit.stderr.filter(s => s.includes('"event":"agy_bridge_request"')).map(s => JSON.parse(s.slice(s.indexOf("{"))))

test("timings cover cold/warm requests and never contain credentials, content or user IDs", async () => {
  await withKit({ captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1", AGY_BRIDGE_STEP_USAGE: "0" } }, async kit => {
    kit.defaultPrompt = async a => { await a.text("PRIVATE_OUTPUT"); return { stopReason: "end_turn" } }
    const body = baseBody({ tools: [], metadata: { user_id: "PRIVATE_USER", session_id: "PRIVATE_CHAT" }, messages: [{ role: "user", content: "PRIVATE_PROMPT" }] })
    const first = await readSse(await kit.request(body))
    await readSse(await kit.request(next(body, first)))
    const rows = timingRows(kit)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].session, "new")
    assert.equal(rows[1].session, "reused")
    for (const row of rows) {
      assert.equal(row.outcome, "completed")
      assert.ok(row.total_ms >= row.first_text_ms)
      assert.ok(row.first_text_ms >= row.acp_first_text_ms)
      assert.ok(row.acp_first_text_ms >= row.prompt_dispatch_ms)
      assert.ok(row.stages_ms.lock_wait >= 0)
      assert.equal(row.explicit_session, true)
    }
    for (const field of ["startup", "initialize", "session_new", "model_selection", "catalog"]) assert.ok(rows[0].stages_ms[field] >= 0, field)
    assert.equal(rows[1].stages_ms.startup, undefined)
    assert.ok(!kit.stderr.join("").includes("PRIVATE_"))
  })
})

test("Magpie timing switch overrides environment and can be changed without reload", async () => {
  const saved = { enabled: false }
  await withKit({ captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1" }, pluginInput: { magpie: { option(_p, key) { return key === "request_timings" && saved.enabled } } } }, async kit => {
    assert.equal(kit.plugin.auth.options.find(o => o.key === "request_timings").default, true)
    kit.defaultPrompt = async a => { await a.text("ok") }
    await readSse(await kit.request(baseBody({ tools: [] })))
    assert.equal(timingRows(kit).length, 0)
    saved.enabled = true
    await readSse(await kit.request(baseBody({ tools: [] })))
    assert.equal(timingRows(kit).length, 1)
  })
})

test("cancelled waiter does not interrupt the startup owner or release its lock early", async () => {
  await withKit({ sessionNewDelayMs: 100 }, async kit => {
    kit.defaultPrompt = async a => { await sleep(50); await a.text("owner") }
    const body = baseBody({ tools: [] })
    const owner = kit.request(body)
    await until(() => kit.acpLog.some(e => e.method === "session/new"))
    const controller = new AbortController()
    const waiter = assert.rejects(kit.request(body, { signal: controller.signal }), { name: "AbortError" })
    await sleep(10); controller.abort(); await waiter
    const third = await kit.request(body)
    assert.equal(third.status, 503)
    const reply = await readSse(await owner)
    assert.equal(reply.content[0].text, "owner")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(kit.promptSerial, 1)
    assert.equal(kit.acpLog.filter(e => e.method === "session/cancel").length, 0)
  })
})

test("cancel timeout kills an unresponsive prompt and frees capacity without parking it", async () => {
  await withKit({ env: { AGY_BRIDGE_CANCEL_SETTLE_MS: "30", AGY_BRIDGE_MAX_PROCS: "1" } }, async kit => {
    kit.prompts.push(async () => new Promise(() => {}))
    const response = await kit.request(baseBody({ tools: [] }))
    await until(() => kit.promptSerial === 1)
    await response.body.cancel()
    await until(() => kit.module.__agyTestAllProcs.size === 0)
    assert.equal(kit.timers.refed().length, 0, "stopped processes must not leave referenced stop/cancel timers")
    assert.equal(kit.acpLog.filter(e => e.method === "session/cancel").length, 1)
    assert.equal(kit.turns[0].waiters.length, 0)
    kit.defaultPrompt = async a => { await a.text("new") }
    const reply = await readSse(await kit.request(baseBody({ tools: [] })))
    assert.equal(reply.content[0].text, "new")
    assert.equal(kit.acpSpawns.length, 2)
  })
})

for (const stream of [true, false]) test(`abort in generation cleans up once (stream=${stream})`, async () => {
  await withKit({ captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1" } }, async kit => {
    kit.defaultPrompt = async a => { await a.waitCancel(); return { stopReason: "cancelled" } }
    const controller = new AbortController()
    const pending = kit.request(baseBody({ tools: [], stream }), { signal: controller.signal })
    const consumed = stream ? (await pending).text() : pending
    const rejected = assert.rejects(consumed)
    await until(() => kit.promptSerial === 1)
    controller.abort("PRIVATE_REASON")
    await rejected
    await until(() => [...kit.module.__agyTestAllProcs].every(p => !p.turn))
    const rows = timingRows(kit)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].outcome, "cancelled")
    assert.equal(kit.acpLog.filter(e => e.method === "session/cancel").length, 1)
    assert.equal(kit.turns[0].waiters.length, 0)
    assert.ok(!kit.stderr.join("").includes("PRIVATE_REASON"))
  })
})

for (const change of ["session", "rename"]) test(`tool ownership remains scoped with ${change} changes`, async () => {
  await withKit({}, async kit => {
    let delivered = 0
    kit.defaultPrompt = async a => { await a.tool("Read", { path: "/private" }); delivered++; await a.text("done") }
    const body = baseBody({ metadata: { user_id: "owner", session_id: "chat" } })
    const first = await readSse(await kit.request(body))
    const follow = continueWithToolResults(body, first)
    let foreign = structuredClone(follow)
    foreign.metadata.session_id = "other-chat"
    if (change === "rename") {
      foreign = JSON.parse(JSON.stringify(foreign).replaceAll(first.content.find(b => b.type === "tool_use").id, "renamed"))
      // A separate complete history may replay in a separate session, never feed the owner's tool.
      kit.prompts.push(async a => { await a.text("separate replay") })
      const response = await kit.request(foreign)
      if (response.status === 200) await readSse(response)
    } else assert.equal((await kit.request(foreign)).status, 409)
    assert.equal(delivered, 0)
    await readSse(await kit.request(follow))
    assert.equal(delivered, 1)
  })
})

test("sixteen distinct session IDs have independent ACP sessions at concurrency 16", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "16" } }, async kit => {
    kit.defaultPrompt = async a => { await sleep(15); await a.text(a.sessionId) }
    const replies = await Promise.all(Array.from({ length: 16 }, (_, i) => kit.request(baseBody({ tools: [], metadata: { user_id: "owner", session_id: String(i) } })).then(readSse)))
    assert.equal(new Set(replies.map(r => r.content[0].text)).size, 16)
    assert.equal(kit.acpSpawns.length, 16)
  })
})

for (const failure of [false, true]) test(`parked session resumes or reports bounded fallback (failure=${failure})`, async () => {
  await withKit({ captureStderr: true, sessionResume: true, sessionResumeError: failure ? { code: -32000, message: "PRIVATE_RESUME_ERROR" } : null,
    env: { AGY_BRIDGE_TIMINGS: "1", AGY_BRIDGE_STEP_USAGE: "0" } }, async kit => {
    kit.defaultPrompt = async a => { await a.text(a.sessionId) }
    const body = baseBody({ tools: [], metadata: { user_id: "owner", session_id: "chat" } })
    const first = await readSse(await kit.request(body))
    kit.clock.advance(11 * 60 * 1000)
    await readSse(await kit.request(baseBody({ tools: [], messages: [{ role: "user", content: "evict idle" }] })))
    const reply = await readSse(await kit.request(next(body, first)))
    if (failure) assert.notEqual(reply.content[0].text, first.content[0].text)
    else assert.equal(reply.content[0].text, first.content[0].text)
    const row = timingRows(kit).at(-1)
    assert.equal(row.session, failure ? "new" : "resumed")
    assert.equal(row.resume, failure ? "failed_new_session" : "resumed")
    assert.ok(row.stages_ms.session_resume >= 0)
    assert.ok(!kit.stderr.join("").includes("PRIVATE_RESUME_ERROR"))
  })
})

for (const tamper of ["binding", "workspace", "history", "legacy", "future", "session-path"]) test(`parked state rejects ${tamper} mismatch instead of resuming`, async () => {
  await withKit({ sessionResume: true, captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1" } }, async kit => {
    kit.defaultPrompt = async a => { await a.text(a.sessionId) }
    const body = baseBody({ tools: [], metadata: { user_id: "owner", session_id: "chat" } })
    const first = await readSse(await kit.request(body))
    const runtime = kit.module.__agyTestRuntimes.get("default")
    const proc = [...runtime.allProcs][0]
    const entry = runtime.parked.get(proc.convKey)
    assert.ok(entry)
    if (tamper === "binding") entry.binding = "different-account"
    if (tamper === "workspace") entry.workDir = "/different-workspace"
    if (tamper === "history") { entry.historyHash = "different"; entry.historyHashSansInputs = "different" }
    if (tamper === "legacy") delete entry.binding
    if (tamper === "future") entry.at = kit.clock.now() + 60_000
    if (tamper === "session-path") entry.sessionId = "../another-session"
    // Retire the live process without re-parking over the mutated checkpoint.
    runtime.pool.delete(proc.convKey)
    await proc.stop()
    const reply = await readSse(await kit.request(next(body, first)))
    assert.notEqual(reply.content[0].text, first.content[0].text)
    assert.equal(kit.acpLog.filter(e => e.method === "session/resume").length, 0)
  })
})

test("invalid session metadata is rejected before CLI and tuple identity cannot collide with user text", async () => {
  await withKit({}, async kit => {
    for (const session_id of [{}, 3, "x".repeat(1025)]) {
      const response = await kit.request(baseBody({ metadata: { session_id } }))
      assert.equal(response.status, 400)
    }
    assert.equal(kit.acpSpawns.length, 0)
    const key = kit.module.__agyTestConversationKey
    assert.notEqual(key(baseBody({ metadata: { user_id: '["u","s"]' } })), key(baseBody({ metadata: { user_id: "u", session_id: "s" } })))
  })
})

test("Request object body, headers and abort signal are honoured", async () => {
  await withKit({}, async kit => {
    kit.defaultPrompt = async a => { await a.waitCancel(); return { stopReason: "cancelled" } }
    const controller = new AbortController()
    const request = new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(baseBody({ tools: [] })), signal: controller.signal })
    const response = await kit.fetch(request)
    const rejected = assert.rejects(response.text())
    await until(() => kit.promptSerial === 1)
    controller.abort()
    await rejected
    await until(() => kit.acpLog.some(e => e.method === "session/cancel"))
  })
})

test("a checkpoint copied between accounts cannot resume the other profile's ACP session", async () => {
  await withKit({ captureStderr: true, sessionResume: true, env: { AGY_BRIDGE_TIMINGS: "1" } }, async kit => {
    const clients = []
    for (const name of ["account-a", "account-b"]) {
      const login = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: `1//test-${name}` })
      const auth = await login.callback()
      assert.equal(auth.type, "success")
      clients.push(await kit.plugin.auth.loader(async () => ({ ...auth, type: "api" })))
    }
    const request = (client, body) => client.fetch("agy://local/v1/messages", { method: "POST", body: JSON.stringify(body) })
    kit.defaultPrompt = async a => { await a.text(a.sessionId) }
    const body = baseBody({ tools: [], metadata: { user_id: "owner", session_id: "same" } })
    const first = await readSse(await request(clients[0], body))
    await clients[1].fetch("agy://local/v1/messages/count_tokens", { method: "POST", body: JSON.stringify(body) })
    const runtimes = [...kit.module.__agyTestRuntimes.entries()]
    const a = runtimes.find(([key]) => key.endsWith("account-a"))[1]
    const b = runtimes.find(([key]) => key.endsWith("account-b"))[1]
    const [key, entry] = [...a.parked][0]
    b.parked.set(key, { ...entry })
    const other = await readSse(await request(clients[1], next(body, first)))
    assert.notEqual(other.content[0].text, first.content[0].text)
    assert.equal(timingRows(kit).at(-1).resume, "binding_mismatch")
    assert.equal(kit.acpLog.filter(e => e.method === "session/resume").length, 0)
    const own = await readSse(await request(clients[0], next(body, first)))
    assert.equal(own.content[0].text, first.content[0].text)
  })
})

test("timing logs have their own bounded budget and report suppression", async () => {
  await withKit({ captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1" } }, async kit => {
    for (let i = 0; i < 125; i++) assert.equal((await kit.request({ messages: "invalid" })).status, 400)
    assert.equal(timingRows(kit).length, 120)
    kit.clock.advance(60_000)
    await kit.request({ messages: "invalid" })
    assert.equal(timingRows(kit).at(-1).suppressed, 5)
    assert.equal(kit.acpSpawns.length, 0)
  })
})

test("Magpie's forwarded session and subagent headers isolate identical Chat API openings", async () => {
  await withKit({ captureStderr: true, env: { AGY_BRIDGE_TIMINGS: "1" } }, async kit => {
    kit.defaultPrompt = async a => { await a.text(a.sessionId) }
    const body = baseBody({ tools: [] })
    const headers = [
      { "X-Magpie-Session": "PRIVATE_CHAT_ONE" },
      { "X-Magpie-Session": "PRIVATE_CHAT_TWO" },
      { "X-Magpie-Session": "PRIVATE_CHAT_ONE", "X-Magpie-Subagent": "PRIVATE_AGENT" },
    ]
    const replies = await Promise.all(headers.map(async h => readSse(await kit.request(body, { headers: h }))))
    assert.equal(new Set(replies.map(r => r.content[0].text)).size, 3)
    for (let i = 0; i < headers.length; i++) {
      const reply = await readSse(await kit.request(next(body, replies[i]), { headers: headers[i] }))
      assert.equal(reply.content[0].text, replies[i].content[0].text)
    }
    assert.ok(timingRows(kit).every(row => row.explicit_session && row.identity_source === "magpie_header"))
    assert.ok(!kit.stderr.join("").includes("PRIVATE_"))
  })
})

test("direct tool IDs cannot bypass the Magpie session header scope", async () => {
  await withKit({}, async kit => {
    let delivered = false
    kit.defaultPrompt = async a => { await a.tool("Read", { path: "/private" }); delivered = true; await a.text("done") }
    const body = baseBody()
    const headers = { "X-Magpie-Session": "owner-chat" }
    const first = await readSse(await kit.request(body, { headers }))
    const follow = continueWithToolResults(body, first)
    assert.equal((await kit.request(follow, { headers: { "X-Magpie-Session": "other-chat" } })).status, 409)
    assert.equal(delivered, false)
    await readSse(await kit.request(follow, { headers }))
    assert.equal(delivered, true)
  })
})

test("cancelled tool-recovery waiter cannot reclaim its still-valid owner after the lock is released", async () => {
  await withKit({}, async kit => {
    let delivered = false
    kit.defaultPrompt = async a => { await a.tool("Read", { path: "/owner" }); delivered = true; await a.text("done") }
    const body = baseBody({ metadata: { session_id: "recovery" } })
    const first = await readSse(await kit.request(body))
    const follow = continueWithToolResults(body, first)
    const bad = structuredClone(follow)
    bad.messages.at(-2).content.find(b => b.type === "tool_use").id = "unmatched"
    bad.messages.at(-2).content.find(b => b.type === "tool_use").input.path = "/edited"
    bad.messages.at(-1).content[0].tool_use_id = "unmatched"
    assert.equal((await kit.request(bad)).status, 409)
    assert.equal((await kit.request(bad)).status, 409)
    const runtime = kit.module.__agyTestRuntimes.get("default")
    const proc = [...runtime.allProcs][0]
    const original = proc.turn
    let release, entered
    const ready = new Promise(r => { entered = r })
    const gate = new Promise(r => { release = r })
    const holding = runtime.withAcquireLock(proc.convKey, async () => { entered(); await gate })
    await ready
    const controller = new AbortController()
    const pending = assert.rejects(kit.request(bad, { signal: controller.signal }), { name: "AbortError" })
    await sleep(20)
    controller.abort()
    await pending
    release(); await holding; await sleep(30)
    assert.equal(delivered, false)
    assert.equal(proc.turn, original)
    assert.equal(proc.dead, false)
    await readSse(await kit.request(follow))
    assert.equal(delivered, true)
  })
})
