import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, MESSAGES_URL } from "./testkit.mjs"

const hostInput = saved => ({ magpie: { option(provider, key) {
  assert.equal(provider, "agy-cli")
  assert.equal(key, "minimal_agent")
  return saved.on
} } })
async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try { await fn(kit) } finally { await kit.dispose() }
}
function modeOf(kit, agent) {
  const proc = [...kit.module.__agyTestRuntimes.values()].flatMap(r => [...r.allProcs])
    .find(p => p.token === agent.env.AGY_BRIDGE_TOKEN)
  const config = fs.readFileSync(path.join(proc.workspace, ".agents", "agents", "magpie-bridge", "agent.md"), "utf8")
  return config.includes("excludeDefaultComponents: true")
}
const next = (body, reply) => ({ ...body, messages: [...body.messages,
  { role: "assistant", content: reply.content }, { role: "user", content: "continue" }] })
const answerMode = kit => async agent => {
  await agent.text(JSON.stringify({ minimal: modeOf(kit, agent), session: agent.sessionId }))
  return { stopReason: "end_turn" }
}
async function readMode(response) {
  const reply = await readSse(await response)
  assert.equal(reply.error, null)
  return { reply, ...JSON.parse(reply.content.find(b => b.type === "text").text) }
}

test("Magpie exposes a localized switch and UI false overrides environment true", async () => {
  await withKit({ env: { AGY_BRIDGE_MINIMAL_AGENT: "1" }, pluginInput: hostInput({ on: false }) }, async kit => {
    const option = kit.plugin.auth.options.find(o => o.key === "minimal_agent")
    assert.equal(option.default, true)
    assert.equal(option.labels.zh, "精简 Agent 提示词")
    kit.defaultPrompt = answerMode(kit)
    assert.equal((await readMode(kit.request(baseBody({ tools: [] })))).minimal, false)
    assert.equal(kit.env.AGY_BRIDGE_MINIMAL_AGENT, "1", "UI never changes the process environment")
  })
})

test("saving a changed switch rebuilds the next turn, while unchanged mode reuses its session", async () => {
  const saved = { on: false }
  await withKit({ pluginInput: hostInput(saved), sessionResume: true }, async kit => {
    kit.defaultPrompt = answerMode(kit)
    let body = baseBody({ tools: [] })
    let previous = await readMode(kit.request(body))
    assert.equal(previous.minimal, false)
    for (const on of [false, true, true, false]) {
      const changed = saved.on !== on
      saved.on = on
      body = next(body, previous.reply)
      const current = await readMode(kit.request(body))
      assert.equal(current.minimal, on)
      if (changed) assert.notEqual(current.session, previous.session)
      else assert.equal(current.session, previous.session)
      previous = current
    }
    assert.equal(kit.acpLog.filter(e => e.method === "session/resume").length, 0,
      "switching mode must not resume a session with the old prompt")
  })
})

for (const enabled of [false, true]) test(`older hosts keep the environment fallback (${enabled})`, async () => {
  await withKit({ env: { AGY_BRIDGE_MINIMAL_AGENT: enabled ? "1" : "0" } }, async kit => {
    assert.equal(kit.plugin.auth.options[0].default, enabled)
    kit.defaultPrompt = answerMode(kit)
    assert.equal((await readMode(kit.request(baseBody({ tools: [] })))).minimal, enabled)
  })
})

test("a pending tool call finishes in its original mode after the switch changes", async () => {
  const saved = { on: false }
  await withKit({ pluginInput: hostInput(saved) }, async kit => {
    kit.defaultPrompt = async agent => {
      assert.equal(modeOf(kit, agent), false)
      const result = await agent.tool("Read", { path: "/test" })
      assert.equal(result.result.content[0].text, "tool-ok")
      assert.equal(modeOf(kit, agent), false)
      await agent.text("finished")
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    saved.on = true
    const continued = continueWithToolResults(body, first, () => "tool-ok")
    const done = await readSse(await kit.request(continued))
    assert.equal(done.error, null)
    assert.equal(done.content.find(b => b.type === "text").text, "finished")
    kit.defaultPrompt = answerMode(kit)
    assert.equal((await readMode(kit.request(next(continued, done)))).minimal, true)
  })
})

test("named accounts share the UI switch and host reload respects saved mode and session compatibility", async () => {
  const saved = { on: true }
  await withKit({ pluginInput: hostInput(saved), sessionResume: true }, async kit => {
    kit.defaultPrompt = answerMode(kit)
    const auths = []
    const body = baseBody({ tools: [] })
    const firsts = []
    for (const name of ["personal", "work"]) {
      const flow = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: `1//test-${name}` })
      const result = await flow.callback()
      assert.equal(result.type, "success")
      const auth = { type: "api", key: result.key }
      auths.push(auth)
      const loader = await kit.plugin.auth.loader(async () => auth)
      const first = await readMode(loader.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body) }))
      assert.equal(first.minimal, true)
      firsts.push(first)
    }
    for (const on of [true, false]) {
      saved.on = on
      await withKit({ pluginInput: hostInput(saved), sessionResume: true, env: {
        AGY_PATH: kit.agyPath, AGY_BRIDGE_ACCOUNTS_DIR: path.join(kit.home, ".config", "magpie-agy-cli", "accounts"),
      } }, async restarted => {
        restarted.defaultPrompt = answerMode(restarted)
        const loader = await restarted.plugin.auth.loader(async () => auths[on ? 0 : 1])
        const first = firsts[on ? 0 : 1]
        const result = await readMode(loader.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(next(body, first.reply)) }))
        assert.equal(result.minimal, on)
        const resumes = restarted.acpLog.filter(e => e.method === "session/resume")
        assert.equal(resumes.length, on ? 1 : 0)
        if (on) assert.equal(resumes[0].params.sessionId, first.session)
      })
    }
  })
})
