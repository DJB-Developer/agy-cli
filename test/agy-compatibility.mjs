import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse, tick } from "./testkit.mjs"

const CLIENT_INFO = { name: "t3-code", version: "0.1.12" }
const unsupported = ["1.4.11", "1.4.12", "1.5.0", "v1.5.0", "agy_acp_server_1.5.0", "  agy_acp_server_1.5.0  ", "1.5.0-rc.1"]
const allowed = ["1.5.1", "1.5.12", "1.6.0", "1.10.0", "2.0.0", "v1.5.1", "agy_acp_server_1.5.1", "  v1.5.1  ", "1.5.1-rc.1", "1.5.1+build", "custom-build", "1.5", "", null, undefined]
const body = stream => baseBody({ tools: [], stream })

async function withKit(version, fn) {
  let externalCalls = 0
  const kit = await createBridgeKit({
    sessionResume: true,
    fetch: async () => { externalCalls++; throw new Error("unexpected external HTTP") },
  })
  // Assign after construction so null/undefined exercise the real wire values,
  // not the testkit's default version.
  kit.agentVersion = version
  kit.defaultPrompt = async agent => { await agent.text("ok"); return { stopReason: "end_turn" } }
  try {
    await fn(kit)
    assert.equal(externalCalls, 0, "compatibility checks must stay local to ACP")
  } finally { await kit.dispose() }
}

function assertIdentity(kit) {
  const inits = kit.acpLog.filter(entry => entry.method === "initialize")
  assert.ok(inits.length > 0)
  for (const init of inits) assert.deepEqual(JSON.parse(JSON.stringify(init.params.clientInfo)), CLIENT_INFO)
}

async function assertUnsupported(response, version) {
  assert.equal(response.status, 400, "an incompatible binary is not a transient upstream 502")
  assert.equal(response.headers.get("x-should-retry"), "false")
  assert.equal(response.headers.get("X-Magpie-Sign-In"), null, "version mismatch is not a sign-out")
  const result = await response.json()
  assert.equal(result.error.code, "AGY_VERSION_UNSUPPORTED")
  assert.equal(result.error.noRetry, true)
  assert.ok(result.error.message.includes(`agy ${version} is older than 1.5.1`))
  assert.match(result.error.message, /Update agy/)
}

for (const version of unsupported) {
  for (const stream of [true, false]) test(`unsupported agy ${version} rejects before session creation (stream=${stream})`, async () => {
    await withKit(version, async kit => {
      await assertUnsupported(await kit.request(body(stream)), version)
      assertIdentity(kit)
      assert.deepEqual(kit.acpLog.map(entry => entry.method), ["initialize"])
      assert.equal(kit.children.size, 0, "rejected ACP process is stopped")
      assert.equal(kit.module.__agyTestAllProcs.size, 0, "rejected process releases pool capacity")
      const workspace = kit.acpSpawns[0]?.cwd
      assert.ok(workspace, "check the rejected process's actual workspace, not the shared nc shim directory")
      assert.equal(fs.existsSync(workspace), false, "rejected workspace is removed")
      assert.equal((await kit.plugin.auth.usage()).signIn, "kept", "no suspension is persisted")
    })
  })

  test(`model probe of unsupported agy ${version} only initializes, then closes`, async () => {
    await withKit(version, async kit => {
      await kit.models()
      await kit.plugin.provider.warming?.()
      await tick()
      assertIdentity(kit)
      assert.deepEqual(kit.acpLog.map(entry => entry.method), ["initialize"])
      assert.equal(kit.children.size, 0)
      assert.equal(kit.promptSerial, 0, "model discovery cannot send a prompt")
    })
  })
}

for (const version of allowed) test(`agy ${String(version)} keeps the configured identity for probe and chat`, async () => {
  await withKit(version, async kit => {
    await kit.models()
    await kit.plugin.provider.warming?.()
    assert.equal(kit.promptSerial, 0)
    const reply = await readSse(await kit.request(body(true)))
    assert.equal(reply.error, null)
    assert.equal(reply.content[0].text, "ok")
    assert.equal(kit.acpLog.filter(entry => entry.method === "initialize").length, 2)
    assert.ok(fs.existsSync(kit.acpSpawns.at(-1).cwd), "a live supported session retains its workspace")
    assertIdentity(kit)
  })
})

test("a rejected runtime can be upgraded without clearing credentials or suspension state", async () => {
  await withKit("1.5.0", async kit => {
    await assertUnsupported(await kit.request(body(false)), "1.5.0")
    kit.agentVersion = "1.5.1"
    const reply = await readSse(await kit.request(body(true)))
    assert.equal(reply.content[0].text, "ok")
    assert.equal(kit.promptSerial, 1)
    assert.equal((await kit.plugin.auth.usage()).signIn, "kept")
    assertIdentity(kit)
  })
})

test("a downgraded runtime cannot resume a checkpoint made with a supported runtime", async () => {
  await withKit("1.5.1", async kit => {
    const firstBody = body(true)
    const first = await readSse(await kit.request(firstBody))
    const runtime = kit.module.__agyTestRuntimes.get("default")
    const proc = [...runtime.allProcs][0]
    assert.ok(runtime.parked.get(proc.convKey), "start with a resumable checkpoint")
    runtime.pool.delete(proc.convKey)
    await proc.stop()
    kit.acpLog.length = 0
    kit.agentVersion = "1.5.0"
    await assertUnsupported(await kit.request({ ...firstBody, messages: [...firstBody.messages,
      { role: "assistant", content: first.content }, { role: "user", content: "next" },
    ] }), "1.5.0")
    assert.deepEqual(kit.acpLog.map(entry => entry.method), ["initialize"])
    assert.equal(kit.children.size, 0)
    assert.equal(kit.promptSerial, 1, "no second prompt or fallback session")
  })
})
