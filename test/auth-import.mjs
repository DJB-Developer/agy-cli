import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

async function withKeyring(fn) {
  let raw = null
  const writes = []
  const kit = await createBridgeKit({
    platform: "darwin",
    storedSignIn: "missing",
    onExecFile: async (file, args, input) => {
      assert.equal(file, "/usr/bin/security")
      if (args[0] === "-i") {
        writes.push(input)
        raw = input.match(/ -w (\S+)\n$/)[1]
        return { code: 0 }
      }
      if (args[0] === "delete-generic-password") { raw = null; return { code: 0 } }
      assert.equal(args[0], "find-generic-password")
      return { code: raw === null ? 44 : 0, stdout: raw ?? "" }
    },
  })
  try { await fn(kit, { writes, get raw() { return raw } }) } finally { await kit.dispose() }
}

test("import auth method verifies with agy, returns only its marker, and retires old sessions", async () => {
  await withKeyring(async (kit, store) => {
    const method = kit.plugin.auth.methods[1]
    assert.equal(method.type, "oauth")
    assert.equal(method.prompts[0].key, "refresh_token")
    const initial = await method.authorize({ refresh_token: '{"token":{"refresh_token":"first-account"}}' })
    assert.equal(initial.url, "")
    assert.equal(initial.method, "auto")
    const importing = initial.callback()
    assert.equal((await kit.request(baseBody())).status, 503)
    assert.match((await kit.plugin.auth.usage()).error, /in progress/)
    assert.match((await initial.callback()).error, /already in progress/)
    assert.deepEqual(await importing, { type: "success", key: "agy" })
    assert.equal(kit.modelsSpawns.length, 1)
    assert.ok(kit.acpSpawns.every(spawn => !spawn.args.includes("--login")))
    kit.defaultPrompt = async agent => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    assert.equal((await readSse(await kit.request(baseBody()))).error, null)
    const oldProcesses = [...kit.module.__agyTestAllProcs]
    assert.ok(oldProcesses.length > 0)
    const second = await method.authorize({ refresh_token: "second-account" })
    assert.deepEqual(await second.callback(), { type: "success", key: "agy" })
    assert.ok(oldProcesses.every(proc => proc.dead))
    const state = JSON.parse(fs.readFileSync(path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "sessions.json"), "utf8"))
    assert.deepEqual(state.entries, [])
    assert.equal(store.writes.length, 2)
  })
})

test("import failure restores sign-in and never reports success from a failed model listing", async () => {
  await withKeyring(async (kit, store) => {
    kit.modelsBehavior = { stdout: "", stderr: "first-account", code: 1 }
    const started = await kit.plugin.auth.methods[1].authorize({ refresh_token: "first-account" })
    const result = await started.callback()
    assert.equal(result.type, "failed")
    assert.match(result.error, /previous sign-in was restored/)
    assert.doesNotMatch(result.error, /first-account/)
    assert.equal(store.raw, null)
  })
})

test("invalid input does not run agy or touch the system keyring", async () => {
  await withKeyring(async (kit, store) => {
    assert.equal((await kit.plugin.auth.methods[1].authorize({ refresh_token: "{}" })).type, "failed")
    assert.equal(kit.execFiles.length, 0)
    assert.equal(kit.modelsSpawns.length, 0)
    assert.equal(store.writes.length, 0)
  })
})

test("an active request prevents account replacement", async () => {
  await withKeyring(async (kit, store) => {
    const proc = { turn: { finalized: false } }
    kit.module.__agyTestAllProcs.add(proc)
    try {
      const started = await kit.plugin.auth.methods[1].authorize({ refresh_token: "next-account" })
      assert.match((await started.callback()).error, /active requests/)
      assert.equal(store.writes.length, 0)
    } finally { kit.module.__agyTestAllProcs.delete(proc) }
  })
})

test("headless Linux auth entry imports without executing a keyring command", async () => {
  const kit = await createBridgeKit({ platform: "linux", env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    onExecFile: async () => assert.fail("headless import must not call secret-tool") })
  try {
    const started = await kit.plugin.auth.methods[1].authorize({ refresh_token: "1//docker-test" })
    assert.deepEqual(await started.callback(), { type: "success", key: "agy" })
    const file = path.join(kit.home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token.refresh_token, "1//docker-test")
    assert.equal(kit.execFiles.length, 0)
    assert.equal(kit.modelsSpawns.length, 1)
  } finally { await kit.dispose() }
})
