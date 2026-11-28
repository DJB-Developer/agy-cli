import { test } from "node:test"
import assert from "node:assert/strict"
import { createQuotaCooldown } from "../usage.mjs"
import { baseBody, createBridgeKit, readSse, MESSAGES_URL } from "./testkit.mjs"

const notice = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 136h30m57s."
const delay = (136 * 3600 + 30 * 60 + 57) * 1000
const body = extra => baseBody({ model: "agy-cli/gemini-4-argon", tools: [], ...extra })
async function withKit(fn) {
  const kit = await createBridgeKit({ platform: "linux" })
  try { await fn(kit) } finally { await kit.dispose() }
}
const fail = text => async agent => { for (const chunk of text) await agent.text(chunk); return { stopReason: "end_turn" } }
const healthy = async agent => { await agent.text("ok"); return { stopReason: "end_turn" } }

test("real quota notice creates an absolute local cooldown; repeated requests and usage reads never query or extend it", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = fail(notice)
    const first = await readSse(await kit.request(body()))
    const resetAt = new Date(kit.clock.now() + delay).toISOString()
    assert.equal(first.error.code, "QUOTA_EXHAUSTED")
    assert.equal(first.error.reset_at, resetAt)
    assert.equal(first.error.noRetry, undefined, "an empty failed opening permits host routing")
    const counts = () => [kit.promptSerial, kit.acpSpawns.length, kit.modelsSpawns.length, kit.otherSpawns.length]
    const before = counts()
    kit.defaultPrompt = healthy
    for (let i = 0; i < 3; i++) {
      kit.clock.advance(1000)
      const usage = await kit.plugin.auth.usage()
      assert.equal(usage.signIn, "kept")
      assert.equal(usage.windows[0].used, 100)
      assert.equal(usage.error, undefined, "an observed routing window is not a failed usage read")
      assert.ok(usage.windows[0].models.includes("gemini-4-argon-low"))
      assert.equal(usage.windows[0].resetsAt, resetAt)
      assert.equal(usage.windows[0].model, "gemini-4-argon")
      const response = await kit.request(body({ stream: false }), { headers: { "X-Magpie-Effort": "low" } })
      assert.equal(response.status, 429)
      assert.equal(response.headers.get("Retry-After"), String(delay / 1000 - i - 1))
      assert.equal((await response.json()).error.reset_at, resetAt)
    }
    assert.deepEqual(counts(), before)
    const other = await readSse(await kit.request(body({ model: "agy-cli/gemini-3.8-flash" })))
    assert.equal(other.error, null, "never infer account-wide exhaustion")
    kit.clock.advance(delay)
    assert.deepEqual((await kit.plugin.auth.usage()).windows, [], "expiry means unknown, not used:0")
    assert.equal((await readSse(await kit.request(body()))).error, null)
  })
})

test("ordinary 429, capacity, validation and quoted quota messages do not create quota locks", async () => {
  for (const text of [
    "⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).",
    "⚠ Our servers are experiencing high traffic right now, please try again in a minute.",
    "⚠ Verification Required",
    `Example: ${notice}`,
  ]) await withKit(async kit => {
    kit.defaultPrompt = fail(text)
    await readSse(await kit.request(body()))
    assert.deepEqual((await kit.plugin.auth.usage()).windows, [], text)
  })
})

test("missing reset is visible but never an indefinite lock", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = fail("⚠ Third-party quota reached. Please switch to Gemini models.")
    const error = (await readSse(await kit.request(body()))).error
    assert.equal(error.code, "QUOTA_EXHAUSTED")
    const usage = await kit.plugin.auth.usage()
    assert.equal(usage.windows[0].used, undefined)
    assert.equal(usage.windows[0].aside, true)
    assert.match(usage.windows[0].display, /unknown/)
    kit.defaultPrompt = healthy
    assert.equal((await readSse(await kit.request(body()))).error, null)
    assert.deepEqual((await kit.plugin.auth.usage()).windows, [], "a later successful request clears the unknown-reset observation")
  })
})

test("quota after visible output disallows transparent replay", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = fail("Already answered.\n" + notice)
    const response = await kit.request(body({ stream: false }))
    assert.equal(response.headers.get("x-should-retry"), "false")
    const result = await response.json()
    assert.equal(result.error.code, "QUOTA_EXHAUSTED")
    assert.equal(result.error.noRetry, true)
    assert.equal(kit.promptSerial, 1)
  })
})

test("explicit ACP request quota errors use the same local state", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async () => { throw new Error(notice) }
    const first = await readSse(await kit.request(body()))
    assert.equal(first.error.code, "QUOTA_EXHAUSTED")
    assert.equal((await kit.plugin.auth.usage()).windows[0].used, 100)
    assert.equal((await kit.request(body())).status, 429)
    assert.equal(kit.promptSerial, 1)
  })
})

test("named accounts have independent cooldowns and usage reads never start a request", async () => {
  await withKit(async kit => {
    const auths = []
    for (const name of ["one", "two"]) {
      const flow = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: `1//fake-${name}` })
      auths.push({ ...await flow.callback(), type: "api" })
    }
    const send = async (auth) => (await kit.plugin.auth.loader(async () => auth)).fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body()) })
    kit.defaultPrompt = fail(notice)
    assert.equal((await readSse(await send(auths[0]))).error.code, "QUOTA_EXHAUSTED")
    kit.defaultPrompt = healthy
    assert.equal((await readSse(await send(auths[1]))).error, null)
    assert.equal((await kit.plugin.auth.usage(async () => auths[0])).windows[0].used, 100)
    assert.deepEqual((await kit.plugin.auth.usage(async () => auths[1])).windows, [])
    assert.equal((await send(auths[0])).status, 429)
  })
})

test("state is bounded, isolated, and ignores old-identity completions or unclassified errors", () => {
  let now = 1000
  const state = createQuotaCooldown({ now: () => now })
  const first = state.sync("one")
  const failure = { statusCode: 429, code: "QUOTA_EXHAUSTED", resetAt: new Date(10000).toISOString() }
  state.observe("gemini-high", ["alias"], failure, first)
  assert.equal(state.get("gemini-low").resetAt, failure.resetAt)
  const view = state.windows(); view[0].models.push("polluted")
  assert.equal(state.get("polluted"), null)
  state.sync("two")
  state.observe("gemini-high", [], failure, first)
  assert.deepEqual(state.windows(), [])
  state.observe("gemini-high", [], { ...failure, code: "RESOURCE_EXHAUSTED" })
  assert.deepEqual(state.windows(), [])
  state.observe("gemini-high", [], failure)
  now = 10000
  assert.equal(state.get("gemini-high"), null)
  assert.deepEqual(state.windows(), [])
  for (let i = 0; i < 150; i++) state.observe(`model-${i}`, [], { ...failure, resetAt: undefined })
  assert.equal(state.windows().length, 128)
  const before = state.revision()
  state.observe("race", [], { ...failure, resetAt: undefined })
  state.succeeded("race", before)
  assert.ok(state.windows().some(w => w.model === "race"), "an earlier success cannot clear newer evidence")
})

test("a tool result already in flight is delivered once, and a later quota error forbids replay", async () => {
  await withKit(async kit => {
    let executed = 0
    kit.defaultPrompt = async agent => {
      await agent.tool("Edit", { text: "write once" })
      executed++
      await agent.text(notice)
      return { stopReason: "end_turn" }
    }
    const request = body({ tools: [{ name: "Edit", input_schema: { type: "object", properties: { text: { type: "string" } } } }] })
    const first = await readSse(await kit.request(request))
    const call = first.content.find(c => c.type === "tool_use")
    assert.ok(call)
    kit.prompts[1] = fail(notice)
    const concurrent = await readSse(await kit.request(body({ metadata: { user_id: "another-conversation" }, messages: [{ role: "user", content: "another request" }] })))
    assert.equal(concurrent.error.code, "QUOTA_EXHAUSTED")
    const next = { ...request, messages: [...request.messages, { role: "assistant", content: first.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "done" }] }] }
    const result = await readSse(await kit.request(next))
    assert.equal(result.error.code, "QUOTA_EXHAUSTED")
    assert.equal(result.error.noRetry, true)
    assert.equal(executed, 1)
    assert.equal(kit.promptSerial, 2)
    assert.equal((await kit.request(body())).status, 429)
  })
})

test("cancelled prompt does not cool an account", async () => {
  await withKit(async kit => {
    let entered
    const started = new Promise(resolve => { entered = resolve })
    kit.defaultPrompt = async agent => {
      entered()
      await agent.waitCancel()
      await agent.text(notice)
      return { stopReason: "cancelled" }
    }
    const controller = new AbortController()
    const response = await kit.request(body(), { signal: controller.signal })
    const drain = response.text().catch(() => "")
    await started
    controller.abort()
    await drain
    assert.deepEqual((await kit.plugin.auth.usage()).windows, [])
  })
})
