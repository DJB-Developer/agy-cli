import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse, MESSAGES_URL } from "./testkit.mjs"

test("quota refresh never calls vendor HTTP or CLI, even with valid credentials and repeated reads", async () => {
  let httpCalls = 0, keyringReads = 0
  const kit = await createBridgeKit({
    env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    fetch: async () => { httpCalls++; return Response.json({}) },
    onExecFile: () => { keyringReads++; return { stdout: "" } },
  })
  try {
    const auths = []
    for (const name of ["personal", "work"]) {
      const flow = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: `1//fake-${name}` })
      const saved = await flow.callback()
      assert.equal(saved.type, "success")
      auths.push({ ...saved, type: "api" })
      const tokenFile = path.join(kit.home, ".config", "magpie-agy-cli", "accounts", name, "antigravity-cli", "antigravity-oauth-token")
      const token = JSON.parse(fs.readFileSync(tokenFile, "utf8"))
      token.token.access_token = `fake-access-${name}`
      token.token.expiry = "2099-01-01T00:00:00Z"
      fs.writeFileSync(tokenFile, JSON.stringify(token))
    }
    const counts = () => [kit.acpSpawns.length, kit.modelsSpawns.length, kit.otherSpawns.length]
    const before = counts()
    const read = auth => kit.plugin.auth.usage(async () => auth)
    const results = await Promise.all([read(auths[0]), read(auths[1]), read(auths[0])])
    results.push(await read(auths[0]), await read({ type: "api", key: "agy" }))
    assert.equal(httpCalls, 0, "quota and plan HTTP must be removed, not just hidden from the UI")
    assert.equal(keyringReads, 0, "status-only reads do not extract access tokens")
    assert.deepEqual(counts(), before, "no /usage, model probe or inference keepalive")
    for (const result of results) {
      assert.deepEqual(result.windows, [])
      assert.equal(result.plan, undefined)
      assert.equal(result.signIn, "kept")
      assert.match(result.error, /unavailable|unsupported/i)
    }
    results[0].windows.push({ used: 100 })
    assert.deepEqual((await read(auths[0])).windows, [], "results must not share mutable quota state")

    kit.defaultPrompt = async agent => { await agent.text("ACP still works"); return { stopReason: "end_turn" } }
    const loaded = await kit.plugin.auth.loader(async () => auths[1])
    const reply = await readSse(await loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(baseBody()) }))
    assert.equal(reply.error, null)
    assert.equal(reply.content[0].text, "ACP still works")
    assert.equal(httpCalls, 0)
  } finally { await kit.dispose() }
})
