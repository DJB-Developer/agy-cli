import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"
import { TOS_MESSAGE } from "../service-status.mjs"

const notices = [
  { text: `⚠ PERMISSION_DENIED (code 403): ${TOS_MESSAGE}`, status: 403, code: "TOS_VIOLATION", noRetry: true },
  { text: `⚠ ${TOS_MESSAGE}`, status: 403, code: "TOS_VIOLATION", noRetry: true },
  { text: "⚠ Verification Required", status: 403, code: "VALIDATION_REQUIRED", noRetry: true },
  { text: "⚠ Individual quota reached. Resets in 1h2m3.5s.", status: 429, reset: 3723500 },
  { text: "⚠ Third-party quota reached. Please switch to Gemini models. Resets in 1h2m3.5s.", status: 429, reset: 3723500 },
  { text: "⚠ Our servers are experiencing high traffic right now, please try again in a minute. (UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server)", status: 503 },
]
async function withKit(fn) {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_STEP_USAGE: "0" } })
  try { await fn(kit) } finally { await kit.dispose() }
}
for (const notice of notices) for (const stream of [true, false]) for (const split of [false, true]) {
  test(`native ending ${notice.text.slice(0, 45)} stream=${stream} split=${split}`, async () => {
    await withKit(async kit => {
      kit.defaultPrompt = async agent => {
        for (const chunk of split ? [...notice.text] : ["\n" + notice.text + "\n"]) await agent.text(chunk)
        return { stopReason: "end_turn" }
      }
      const response = await kit.request(baseBody({ tools: [], stream }))
      const reply = stream ? await readSse(response) : await response.json()
      assert.equal(reply.error?.status, notice.status)
      assert.equal(reply.error?.code, notice.code)
      assert.equal(reply.error?.noRetry, notice.noRetry)
      assert.equal(reply.error?.reset_at, notice.reset ? new Date(kit.clock.now() + notice.reset).toISOString() : undefined)
      if (!stream) {
        assert.equal(response.status, notice.status)
        assert.equal(response.headers.get("x-should-retry"), notice.noRetry ? "false" : null)
        assert.equal(response.headers.get("Retry-After"), notice.reset ? "3724" : null)
      }
      assert.equal(kit.promptSerial, 1, "no transparent replay")
      kit.defaultPrompt = async agent => { await agent.text("healthy"); return { stopReason: "end_turn" } }
      const next = await kit.request(baseBody({ tools: [], stream: false }))
      if (notice.code === "TOS_VIOLATION") {
        assert.equal(next.status, 403)
        assert.equal(next.headers.get("x-should-retry"), "false")
        assert.equal(kit.promptSerial, 1, "persistent ban blocks another prompt")
      } else {
        assert.equal(next.status, 200, "verification, quota and capacity must not persist a TOS ban")
      }
    })
  })
}
for (const notice of notices) test(`quoted warning stays content: ${notice.text.slice(0, 45)}`, async () => {
  await withKit(async kit => {
    for (const text of [`Example: ${notice.text}`, `${notice.text}\nThis is a quoted example, not a service refusal.`]) {
      kit.defaultPrompt = async agent => {
        for (const chunk of [...text]) await agent.text(chunk)
        return { stopReason: "end_turn" }
      }
      const reply = await readSse(await kit.request(baseBody({ tools: [], metadata: { user_id: text } })))
      assert.equal(reply.error, null)
      assert.equal(reply.content.map(c => c.text || "").join(""), text)
    }
  })
})
test("a requested home/ancestor is not added to agy's workspace; a project still is", async () => {
  await withKit(async kit => {
    const project = path.join(kit.home, "project")
    fs.mkdirSync(project)
    for (const directory of [kit.home, path.dirname(kit.home), project]) {
      kit.defaultPrompt = async agent => { await agent.text("ok"); return { stopReason: "end_turn" } }
      await readSse(await kit.request(baseBody({ tools: [], metadata: { user_id: directory } }), { headers: { "x-magpie-work-dir": directory } }))
      const args = kit.acpSpawns.at(-1).args
      assert.equal(args.includes("--add-dir"), directory === project)
      if (directory === project) assert.equal(args[args.indexOf("--add-dir") + 1], project)
    }
  })
})
test("identical openings in different folders keep separate reusable sessions", async () => {
  await withKit(async kit => {
    const dirs = ["project-a", "project-b"].map(name => path.join(kit.home, name))
    dirs.forEach(dir => fs.mkdirSync(dir))
    kit.defaultPrompt = async agent => { await agent.text(agent.sessionId); return { stopReason: "end_turn" } }
    const body = baseBody({ tools: [] })
    const replies = []
    for (const dir of dirs) replies.push(await readSse(await kit.request(body, { headers: { "x-magpie-work-dir": dir } })))
    assert.notEqual(replies[0].content[0].text, replies[1].content[0].text)
    for (let i = 0; i < dirs.length; i++) {
      const follow = { ...body, messages: [...body.messages, { role: "assistant", content: replies[i].content }, { role: "user", content: "next" }] }
      const reply = await readSse(await kit.request(follow, { headers: { "x-magpie-work-dir": dirs[i] } }))
      assert.equal(reply.content[0].text, replies[i].content[0].text)
    }
    assert.equal(kit.acpSpawns.length, 2)
  })
})
