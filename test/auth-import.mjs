import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, MESSAGES_URL, modelsOutput } from "./testkit.mjs"

const profileOf = args => args.find(arg => arg.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length)
const nameOf = args => path.basename(profileOf(args) || "default")
const rootOf = kit => path.join(kit.home, ".config", "magpie-agy-cli", "accounts")
const fileOf = (kit, name) => path.join(rootOf(kit), name, "antigravity-cli", "antigravity-oauth-token")
const authOf = result => ({ ...result, type: "api" })
async function add(kit, name, token = `1//test-${name}`) {
  const started = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: token })
  assert.equal(started.method, "auto", started.error)
  return started.callback()
}
async function client(kit, auth) {
  const loaded = await kit.plugin.auth.loader(typeof auth === "function" ? auth : async () => auth)
  return body => loaded.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body) })
}
function setAccess(kit, name, { access = `access-${name}`, expiry = "2099-01-01T00:00:00Z" } = {}) {
  kit.env.AGY_BRIDGE_STORED_SIGNIN = ""
  const file = fileOf(kit, name)
  const saved = JSON.parse(fs.readFileSync(file, "utf8"))
  saved.token.access_token = access
  saved.token.expiry = expiry
  fs.writeFileSync(file, JSON.stringify(saved))
}
const summary = (remaining = 0.8) => ({ groups: [
  { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: remaining }] },
  { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 0 }] },
] })
async function withKit(options, fn) {
  let unexpectedHttp = 0
  const kit = await createBridgeKit({
    fetch: async () => { unexpectedHttp++; throw Error("Unexpected external HTTP") },
    // Keep the old transport healthy for reverse checks: failures must prove
    // that quota reads still spawned CLI, not merely that its version was absent.
    onSpawn: (_file, args) => args.includes("--version") ? { stdout: "1.5.9\n" }
      : args.includes("/usage") ? { stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: summary() } }) } : 0,
    ...options,
  })
  try { await fn(kit); assert.equal(unexpectedHttp, 0, "tests must not make unmocked HTTP requests") }
  finally { await kit.dispose() }
}

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform}: two token imports keep separate private credentials and never access the keyring`, async () => {
    await withKit({ platform, onExecFile: () => assert.fail("named profiles must never access the keyring") }, async kit => {
      assert.equal(kit.plugin.auth.single, false)
      const [a, b] = await Promise.all([add(kit, "personal"), add(kit, "work", '{"token":{"refresh_token":"1//test-work"}}')])
      assert.deepEqual(a, { type: "success", key: "agy:personal", metadata: { email: "personal" } })
      assert.equal(b.key, "agy:work")
      assert.equal(JSON.parse(fs.readFileSync(fileOf(kit, "personal"))).token.refresh_token, "1//test-personal")
      assert.equal(JSON.parse(fs.readFileSync(fileOf(kit, "work"))).token.refresh_token, "1//test-work")
      assert.equal(fs.statSync(fileOf(kit, "work")).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.dirname(fileOf(kit, "work"))).mode & 0o777, 0o700)
      assert.equal(kit.modelsSpawns.length, 2)
      assert.ok(kit.modelsSpawns.every(s => s.args[0].startsWith("--gemini_dir=") && s.args[1] === "models"))
      assert.deepEqual(new Set(kit.modelsSpawns.map(s => nameOf(s.args))), new Set(["personal", "work"]))
      assert.ok(kit.modelsSpawns.every(s => s.env.WSL_INTEROP === "1"))
      assert.equal(kit.acpSpawns.length, 0, "import validation must not leave background probes")
      assert.equal(kit.execFiles.length, 0)
    })
  })
}

test("Magpie uses HTTP quota and optional HTTP plans without spawning CLI queries or blocking ACP chat", async () => {
  const calls = []
  let mode = "ok", planSignal
  await withKit({
    env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    fetch: async (url, init) => {
      calls.push({ url, token: init.headers.Authorization })
      assert.equal(init.headers["User-Agent"], undefined, "do not send the unverified Hub identity")
      if (url.endsWith(":retrieveUserQuotaSummary")) return Response.json(summary())
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: {} })
      assert.equal(url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
      assert.deepEqual(JSON.parse(init.body), { metadata: { ideType: "ANTIGRAVITY" } })
      if (mode === "network") throw Error("private network error")
      if (mode === "invalid") return new Response("invalid json")
      if (mode === "timeout") { planSignal = init.signal; return new Promise(() => {}) }
      if (typeof mode === "number") return new Response("private upstream error", { status: mode })
      return Response.json({ paidTier: { id: init.headers.Authorization === "Bearer access-a" ? "g1-pro-tier" : "g1-ultra-tier" } })
    },
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    setAccess(kit, "a"); setAccess(kit, "b")
    assert.equal(calls.length, 0, "import must not perform HTTP metadata probes")
    await Promise.all([kit.plugin.provider.models({}, { auth: authOf(a) }), kit.plugin.provider.models({}, { auth: authOf(b) })])
    await kit.plugin.provider.warming?.()
    const reads = kit.otherSpawns.length
    const readA = () => kit.plugin.auth.usage(async () => authOf(a))
    const [usageA, usageB, duplicateA] = await Promise.all([readA(), kit.plugin.auth.usage(async () => authOf(b)), readA()])
    assert.equal(usageA.plan, "Google AI Pro", usageA.error)
    assert.equal(usageB.plan, "Google AI Ultra", usageB.error)
    assert.equal(duplicateA.plan, usageA.plan)
    const planCalls = () => calls.filter(call => call.url.endsWith(":loadCodeAssist"))
    assert.equal(planCalls().length, 2, "one plan query per account, including concurrent callers")
    const keys = calls.map(call => `${call.token} ${call.url}`)
    assert.equal(new Set(keys).size, keys.length, "concurrent callers share the whole metadata query")
    assert.deepEqual(new Set(calls.map(call => call.token)), new Set(["Bearer access-a", "Bearer access-b"]))
    assert.equal(kit.otherSpawns.length, reads, "HTTP metadata must not spawn --version or /usage")
    assert.deepEqual(usageA.windows.map(w => w.used), [20, 100])
    assert.ok(usageA.windows.every(w => !w.aside && w.models.length), JSON.stringify(usageA.windows))
    assert.ok(usageA.windows[0].models.every(id => id.startsWith("gemini-")))
    assert.ok(usageA.windows[1].models.every(id => /^(claude|gpt)-/.test(id)))
    for (mode of [401, 403, 429, 500, "network", "invalid", "timeout"]) {
      kit.clock.advance(10 * 60_000)
      const failed = await readA()
      assert.equal(failed.plan, undefined, `omit stale plan on ${mode}`)
      assert.deepEqual(failed.windows, usageA.windows)
      assert.equal(failed.signIn, "kept")
      assert.equal(failed.error, undefined)
      assert.equal(kit.otherSpawns.length, reads)
    }
    assert.equal(planSignal.aborted, true)
    mode = "ok"
    kit.clock.advance(10 * 60_000)
    assert.equal((await readA()).plan, "Google AI Pro", "plan failure must not trigger auth backoff")
    const before = calls.length
    kit.defaultPrompt = async agent => { await agent.text("CLI reply"); return { stopReason: "end_turn" } }
    const request = await client(kit, authOf(a))
    const reply = await readSse(await request(baseBody()))
    assert.equal(reply.content[0].text, "CLI reply")
    assert.ok(kit.acpSpawns.some(spawn => nameOf(spawn.args) === "a" && spawn.args.includes("acp")))
    assert.equal(calls.length, before, "chat must not call HTTP metadata or inference endpoints")
  })
})

test("failed and duplicate imports leave existing accounts and live requests untouched", async () => {
  await withKit({}, async kit => {
    assert.equal((await add(kit, "existing")).type, "success")
    const previous = fs.readFileSync(fileOf(kit, "existing"), "utf8")
    const active = { turn: { finalized: false } }
    kit.module.__agyTestAllProcs.add(active)
    try {
      assert.equal((await add(kit, "other")).type, "success", "adding an account is safe while the default account is busy")
      assert.match((await add(kit, "existing", "replacement-token")).error, /already exists/)
      kit.modelsBehavior = { code: 1, stdout: "", stderr: "must-not-leak-the-token" }
      const failed = await add(kit, "broken", "must-not-leak-the-token")
      assert.equal(failed.type, "failed")
      assert.doesNotMatch(failed.error, /must-not-leak/)
      assert.equal(fs.existsSync(path.join(rootOf(kit), "broken")), false)
      assert.equal(fs.readFileSync(fileOf(kit, "existing"), "utf8"), previous)
    } finally { kit.module.__agyTestAllProcs.delete(active) }
  })
})

test("a removed Magpie row can reattach its saved profile without replacing credentials or service state", async () => {
  await withKit({}, async kit => {
    const original = await add(kit, "restore-me")
    assert.equal(original.type, "success")
    // Magpie owns its account rows; removing one leaves this CLI profile on disk.
    const tokenBefore = fs.readFileSync(fileOf(kit, "restore-me"), "utf8")
    const statusFile = path.join(rootOf(kit), "restore-me", "bridge-state", "service-status.json")
    const status = JSON.stringify({ version: 1, reason: "TOS_VIOLATION" })
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.writeFileSync(statusFile, status)
    const duplicate = await add(kit, "restore-me", "1//replacement-token")
    assert.equal(duplicate.type, "failed")
    assert.match(duplicate.error, /Use a saved named account/)
    assert.match(duplicate.error, /removing.*Magpie.*does not delete/i)
    assert.doesNotMatch(duplicate.error, /1\/\/replacement-token/)
    const saved = await kit.plugin.auth.methods[3].authorize({ name: "RESTORE-ME" })
    assert.equal(saved.method, "auto", saved.error)
    assert.deepEqual(await saved.callback(), original)
    assert.equal(fs.readFileSync(fileOf(kit, "restore-me"), "utf8"), tokenBefore)
    assert.equal(fs.readFileSync(statusFile, "utf8"), status, "reattaching must not clear a suspension")
    assert.equal(kit.modelsSpawns.length, 1, "restoring a reference does not import or revalidate another token")
    const usage = await kit.plugin.auth.usage(async () => authOf(await saved.callback()))
    assert.match(usage.error, /TOS_VIOLATION/)
    assert.equal(kit.acpSpawns.length, 0, "restoring a reference does not restart a blocked account")
  })
})

test("invalid names/tokens fail before IO, and a callback cannot import twice", async () => {
  await withKit({}, async kit => {
    const method = kit.plugin.auth.methods[1]
    for (const name of ["", "../outside", "a/b", "default", "CON", "a.b"]) {
      assert.equal((await method.authorize({ name, refresh_token: "1//test" })).type, "failed")
    }
    assert.equal((await method.authorize({ name: "test", refresh_token: "{}" })).type, "failed")
    assert.equal(kit.modelsSpawns.length, 0)
    const pending = await method.authorize({ name: "test", refresh_token: "1//test" })
    const [first, again] = await Promise.all([pending.callback(), pending.callback()])
    assert.deepEqual(first, again)
    assert.equal(kit.modelsSpawns.length, 1)
    const duplicate = await Promise.all([add(kit, "race"), add(kit, "race")])
    assert.equal(duplicate.filter(r => r.type === "success").length, 1)
  })
})

test("identical concurrent conversations and tool continuations stay in their account's process", async () => {
  await withKit({}, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    const [requestA, requestB] = await Promise.all([client(kit, authOf(a)), client(kit, authOf(b))])
    const replies = new Map()
    kit.defaultPrompt = async agent => {
      const name = nameOf(agent.args)
      const result = await agent.tool("Read", { path: `/${name}` })
      replies.set(name, result.result.content[0].text)
      await agent.text(`${name}:${agent.sessionId}`)
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const [firstA, firstB] = await Promise.all([requestA(body).then(readSse), requestB(body).then(readSse)])
    assert.equal(firstA.stopReason, "tool_use")
    assert.equal(firstB.stopReason, "tool_use")
    const [doneA, doneB] = await Promise.all([
      requestA(continueWithToolResults(body, firstA, () => "result-a")).then(readSse),
      requestB(continueWithToolResults(body, firstB, () => "result-b")).then(readSse),
    ])
    assert.equal(doneA.error, null)
    assert.equal(doneB.error, null)
    assert.equal(replies.get("a"), "result-a")
    assert.equal(replies.get("b"), "result-b")
    assert.match(doneA.content.find(b => b.type === "text").text, /^a:/)
    assert.match(doneB.content.find(b => b.type === "text").text, /^b:/)
    const sessions = ["a", "b"].map(name => JSON.parse(fs.readFileSync(path.join(rootOf(kit), name, "bridge-state", "sessions.json"))))
    assert.notDeepEqual(sessions[0].entries, sessions[1].entries)
    const procs = [...kit.module.__agyTestRuntimes.values()].flatMap(r => [...r.allProcs])
    assert.equal(procs.length, 2)
    assert.notEqual(procs[0].sessionId, procs[1].sessionId)
    assert.notEqual(procs[0].child.args.find(a => a.startsWith("--gemini_dir=")), procs[1].child.args.find(a => a.startsWith("--gemini_dir=")))
  })
})

test("a bare 429 stops only the failing account while another account's tool turn continues", { timeout: 5000 }, async () => {
  await withKit({}, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    const [requestA, requestB] = await Promise.all([client(kit, authOf(a)), client(kit, authOf(b))])
    kit.defaultPrompt = async agent => {
      if (nameOf(agent.args) === "a") {
        await agent.text("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).")
        await new Promise(() => {})
      }
      const result = await agent.tool("Read", { path: "/b" })
      await agent.text(result.result.content[0].text)
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const firstB = await readSse(await requestB(body))
    const procB = [...kit.module.__agyTestRuntimes.values()].flatMap(r => [...r.allProcs])
      .find(proc => nameOf(proc.child.args) === "b")
    const failed = await readSse(await requestA(body))
    assert.equal(failed.error?.type, "rate_limit_error")
    assert.equal(procB.dead, false)
    assert.equal(procB.stopping, false)
    const doneB = await readSse(await requestB(continueWithToolResults(body, firstB, () => "only-b-result")))
    assert.equal(doneB.error, null)
    assert.equal(doneB.content.find(part => part.type === "text").text, "only-b-result")
    assert.equal(kit.acpSpawns.filter(spawn => nameOf(spawn.args) === "b").length, 1)
    const liveA = [...kit.module.__agyTestRuntimes.values()].flatMap(r => [...r.pool.values()])
      .filter(proc => nameOf(proc.child.args) === "a")
    assert.equal(liveA.length, 0, "failed account's process is dropped from its own pool")
  })
})

test("tool-result images steer within each named account's session without crossing profiles", { timeout: 10000 }, async () => {
  await withKit({ supportsImages: true }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    const requests = await Promise.all([client(kit, authOf(a)), client(kit, authOf(b))])
    const sessions = new Map(), delivered = new Map(), images = new Map()
    kit.defaultPrompt = async agent => {
      const name = nameOf(agent.args)
      const image = agent.prompt.find(part => part.type === "image")
      if (image) {
        assert.equal(agent.sessionId, sessions.get(name))
        images.set(name, image.data)
        await agent.text(`image-for-${name}`)
        return { stopReason: "end_turn" }
      }
      sessions.set(name, agent.sessionId)
      agent.update({ sessionUpdate: "tool_call", toolCallId: "image-read", status: "in_progress" })
      const reply = await agent.tool("Read", { path: `/${name}.png` })
      delivered.set(name, reply.result.content)
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "image-read", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    }
    const body = baseBody()
    const first = await Promise.all(requests.map(request => request(body).then(readSse)))
    const names = ["a", "b"]
    const done = await Promise.all(requests.map((request, i) => request(continueWithToolResults(body, first[i], () => [
      { type: "text", text: `read-${names[i]}` },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(`image-${names[i]}`).toString("base64") } },
    ])).then(readSse)))
    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      assert.equal(done[i].error, null)
      assert.equal(done[i].content.find(part => part.type === "text").text, `image-for-${name}`)
      assert.equal(images.get(name), Buffer.from(`image-${name}`).toString("base64"))
      assert.deepEqual(delivered.get(name), [{ type: "text", text: `read-${name}` }, { type: "text", text: kit.module.IMAGE_FOLLOWS }])
      assert.equal(kit.acpSpawns.filter(spawn => nameOf(spawn.args) === name).length, 1)
    }
    assert.notEqual(sessions.get("a"), sessions.get("b"))
  })
})

test("models and usage are scoped to host-selected auth and conflicting API environment cannot override it", async () => {
  await withKit({ env: { AGY_BRIDGE_STORED_SIGNIN: "", GEMINI_API_KEY: "global-key", AGY_ADC_AUTH: "1", WSL_INTEROP: "real-wsl" },
    fetch: async (url, init) => {
      assert.ok(["Bearer access-a", "Bearer access-b"].includes(init.headers.Authorization))
      if (url.endsWith(":loadCodeAssist")) return Response.json({})
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: {} })
      assert.ok(url.endsWith(":retrieveUserQuotaSummary"))
      return Response.json(summary(init.headers.Authorization === "Bearer access-a" ? 0.8 : 0.3))
    },
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    setAccess(kit, "a"); setAccess(kit, "b")
    const rows = args => ["high", "low"].map(effort => [`gemini-3.8-flash-${nameOf(args)}-${effort}`, `Account ${nameOf(args)} (${effort})`])
    kit.modelsBehavior = ({ args }) => ({ stdout: modelsOutput(rows(args)) })
    kit.offeredModels = rows
    const [modelsA, modelsB] = await Promise.all([
      kit.plugin.provider.models({}, { auth: authOf(a) }), kit.plugin.provider.models({}, { auth: authOf(b) }),
    ])
    assert.ok(modelsA["gemini-3.8-flash-a"])
    assert.equal(modelsA["gemini-3.8-flash-b"], undefined)
    assert.ok(modelsB["gemini-3.8-flash-b"])
    const queries = kit.modelsSpawns.length
    const [usageA, usageB] = await Promise.all([
      kit.plugin.auth.usage(async () => authOf(a)), kit.plugin.auth.usage(async () => authOf(b)),
    ])
    assert.equal(usageA.windows[0]?.used, 20, usageA.error)
    assert.equal(usageB.windows[0]?.used, 70, usageB.error)
    assert.equal(usageA.windows[0].aside, false)
    assert.equal(usageB.windows[0].aside, false)
    assert.deepEqual(usageA.windows[0].models, ["gemini-3.8-flash-a-high", "gemini-3.8-flash-a-low", "gemini-3.8-flash-a"])
    assert.deepEqual(usageB.windows[0].models, ["gemini-3.8-flash-b-high", "gemini-3.8-flash-b-low", "gemini-3.8-flash-b"])
    assert.equal(kit.modelsSpawns.length, queries, "usage must not start another model listing")
    assert.ok(kit.modelsSpawns.every(s => s.env.WSL_INTEROP === "real-wsl" && !s.env.GEMINI_API_KEY))
  })
})

test("missing/invalid selected accounts fail closed, and getAuth is re-read for each request", async () => {
  await withKit({}, async kit => {
    const a = await add(kit, "a")
    let auth = authOf(a)
    const request = await client(kit, () => auth)
    kit.defaultPrompt = async agent => { await agent.text(nameOf(agent.args)); return { stopReason: "end_turn" } }
    assert.equal((await request(baseBody())).status, 200)
    const count = kit.acpSpawns.length
    fs.unlinkSync(fileOf(kit, "a"))
    assert.equal((await request(baseBody())).status, 401)
    assert.equal(kit.acpSpawns.length, count)
    assert.equal((await kit.plugin.auth.usage(async () => auth)).signIn, "expired")
    await assert.rejects(kit.plugin.provider.models({}, { auth }), /missing|unreadable/)
    auth = { type: "api", key: "agy:%2e%2e%2foutside" }
    assert.equal((await request(baseBody())).status, 401)
    auth = null
    assert.equal((await request(baseBody())).status, 401)
    auth = { type: "api", key: "agy" }
    const legacy = await readSse(await request(baseBody()))
    assert.equal(legacy.error, null)
    assert.equal(legacy.content[0].text, "default")
    assert.ok(kit.acpSpawns.some(s => !profileOf(s.args)))
  })
})

test("named Google sign-in saves its own profile and saved-account registration needs no new login", async () => {
  await withKit({ onLogin: ({ child, args, opts }) => {
    assert.equal(opts.env.WSL_INTEROP, "1")
    setImmediate(() => child.stdout.emit("data", "https://accounts.google.com/o/oauth2/auth?test=1\n"))
    child.onStdin = code => {
      assert.equal(code, "test-code\n")
      const file = path.join(profileOf(args), "antigravity-cli", "antigravity-oauth-token")
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ token: { refresh_token: "1//browser-test" } }))
      child.finish(0)
    }
  } }, async kit => {
    const flow = await kit.plugin.auth.methods[2].authorize({ name: "browser" })
    assert.match(flow.url, /^https:\/\/accounts.google.com/)
    const result = await flow.callback("test-code")
    assert.equal(result.key, "agy:browser", result.error)
    const saved = await kit.plugin.auth.methods[3].authorize({ name: "browser" })
    assert.deepEqual(await saved.callback(), result)
    assert.equal(kit.acpSpawns.filter(s => s.args.includes("--login")).length, 1)
  })
})

test("another account cannot consume a live tool result, even with the original call ID and history", async () => {
  await withKit({}, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    const requestA = await client(kit, authOf(a))
    const requestB = await client(kit, authOf(b))
    let replyA
    kit.defaultPrompt = async agent => {
      if (nameOf(agent.args) === "a") replyA = await agent.tool("Read", { path: "/a" })
      await agent.text(nameOf(agent.args))
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const first = await readSse(await requestA(body))
    const next = continueWithToolResults(body, first, () => "private-result")
    const replayB = await readSse(await requestB(next))
    assert.equal(replayB.error, null)
    assert.equal(replayB.content[0].text, "b")
    assert.equal(replyA, undefined, "B must not deliver a result to A's MCP socket")
    const doneA = await readSse(await requestA(next))
    assert.equal(doneA.error, null)
    assert.equal(replyA.result.content[0].text, "private-result")
  })
})

test("a restarted host resumes only the selected profile's saved session", async () => {
  await withKit({ sessionResume: true }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    kit.defaultPrompt = async agent => { await agent.text("same-answer"); return { stopReason: "end_turn" } }
    const body = baseBody({ tools: [] })
    const requestA = await client(kit, authOf(a)), requestB = await client(kit, authOf(b))
    const [firstA, firstB] = await Promise.all([requestA(body).then(readSse), requestB(body).then(readSse)])
    const saved = Object.fromEntries(["a", "b"].map(name => [name,
      JSON.parse(fs.readFileSync(path.join(rootOf(kit), name, "bridge-state", "sessions.json"))).entries[0].sessionId,
    ]))
    assert.notEqual(saved.a, saved.b)
    await withKit({ sessionResume: true, env: { AGY_BRIDGE_ACCOUNTS_DIR: rootOf(kit), AGY_PATH: kit.agyPath } }, async restarted => {
      restarted.defaultPrompt = async agent => { await agent.text(agent.sessionId); return { stopReason: "end_turn" } }
      for (const [result, first, name] of [[b, firstB, "b"], [a, firstA, "a"]]) {
        const request = await client(restarted, authOf(result))
        const continued = { ...body, messages: [...body.messages, { role: "assistant", content: first.content }, { role: "user", content: "continue" }] }
        const done = await readSse(await request(continued))
        assert.equal(done.error, null)
        assert.equal(done.content[0].text, saved[name])
      }
      assert.deepEqual(restarted.acpLog.filter(e => e.method === "session/resume").map(e => e.params.sessionId), [saved.b, saved.a])
    })
  })
})

test("upgrading prompt rewrites rebuilds only the affected account's legacy parked session", async () => {
  // Model a pre-0.2.7 host: its saved identity used the client's raw instructions.
  await withKit({ sessionResume: true, indexTransform: source => source.replace(
    "instructionsHash: digest(sentInstructionsIdentity(proc.instructions))",
    "instructionsHash: digest(instructionsIdentity(proc.instructions))",
  ) }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    kit.defaultPrompt = async agent => { await agent.text("saved-answer"); return { stopReason: "end_turn" } }
    const bodies = [
      baseBody({ tools: [], system: "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.\nRules." }),
      baseBody({ tools: [], system: "You are a test agent.\nRules." }),
    ]
    const auths = [a, b]
    const firsts = []
    for (let i = 0; i < auths.length; i++) firsts.push(await readSse(await (await client(kit, authOf(auths[i])))(bodies[i])))
    const savedB = JSON.parse(fs.readFileSync(path.join(rootOf(kit), "b", "bridge-state", "sessions.json"))).entries[0].sessionId
    await withKit({ sessionResume: true, env: { AGY_BRIDGE_ACCOUNTS_DIR: rootOf(kit), AGY_PATH: kit.agyPath } }, async restarted => {
      restarted.defaultPrompt = async agent => { await agent.text("continued"); return { stopReason: "end_turn" } }
      for (let i = 0; i < auths.length; i++) {
        const request = await client(restarted, authOf(auths[i]))
        const body = bodies[i]
        const continued = { ...body, messages: [...body.messages, { role: "assistant", content: firsts[i].content }, { role: "user", content: "continue" }] }
        const done = await readSse(await request(continued))
        assert.equal(done.error, null)
        assert.equal(done.content[0].text, "continued")
      }
      assert.deepEqual(restarted.acpLog.filter(e => e.method === "session/resume").map(e => e.params.sessionId), [savedB],
        "unchanged account B resumes; account A must not resume stale raw instructions")
      assert.equal(restarted.acpLog.filter(e => e.method === "session/new").length, 1)
    })
  })
})

test("cancelling a named browser login stops only that profile and removes its unpublished credentials", async () => {
  await withKit({ onLogin: ({ child }) => {
    setImmediate(() => child.stdout.emit("data", "https://accounts.google.com/o/oauth2/auth?test=cancel\n"))
  } }, async kit => {
    const [first, second] = await Promise.all([
      kit.plugin.auth.methods[2].authorize({ name: "first" }),
      kit.plugin.auth.methods[2].authorize({ name: "second" }),
    ])
    assert.ok(first.url && second.url)
    const controller = new AbortController()
    controller.abort()
    const result = await first.callback("unused-code", { signal: controller.signal })
    assert.equal(result.type, "failed")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(path.join(rootOf(kit), "first")), false)
    assert.equal(fs.existsSync(path.join(rootOf(kit), "second")), true)
    assert.equal([...kit.children].filter(c => c.args.includes("--login")).length, 1)
    await second.callback("unused-code", { signal: controller.signal })
  })
})

test("a late browser close cannot delete a new import after its error cleanup", async () => {
  await withKit({ onLogin: ({ child }) => {
    setImmediate(() => child.stdout.emit("data", "https://accounts.google.com/o/oauth2/auth?test=error\n"))
  } }, async kit => {
    const flow = await kit.plugin.auth.methods[2].authorize({ name: "retry" })
    assert.ok(flow.url)
    const old = [...kit.children].find(child => child.args.includes("--login"))
    old.emit("error", new Error("test login failure"))
    assert.equal(fs.existsSync(path.join(rootOf(kit), "retry")), false)
    assert.equal((await add(kit, "retry")).type, "success")
    old.finish(1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fs.existsSync(fileOf(kit, "retry")), true)
  })
})

test("Magpie's named-account HTTP quota hook exposes the original error with credentials removed", async () => {
  const calls = []
  await withKit({ fetch: async url => {
    calls.push(url)
    if (url.endsWith(":loadCodeAssist")) return Response.json({ paidTier: { id: "g1-pro-tier" } })
    return Response.json({ error: { code: 403, message: "Your current account is not eligible: country association unavailable", refresh_token: "private-account-token" } }, { status: 403 })
  } }, async kit => {
    const saved = await add(kit, "quota-ui")
    setAccess(kit, "quota-ui")
    const count = kit.otherSpawns.length
    const result = await kit.plugin.auth.usage(async () => authOf(saved))
    assert.equal(result.signIn, "kept")
    assert.match(result.error, /HTTP.*redacted/i)
    assert.match(result.error, /country association unavailable/)
    assert.doesNotMatch(result.error, /private-account-token/)
    assert.equal(result.plan, "Google AI Pro", "quota errors must not discard a successfully queried plan")
    assert.ok(calls.length > 0)
    assert.equal(kit.otherSpawns.length, count)
    assert.equal(fs.existsSync(path.join(rootOf(kit), "quota-ui", "bridge-state", "service-status.json")), false)
  })
})

for (const failure of [401, 403, 429, "expired"]) {
  test(`HTTP quota ${failure} does not poison CLI authentication or infer a service ban`, async () => {
    let calls = 0
    await withKit({ fetch: async url => {
      calls++
      if (url.endsWith(":loadCodeAssist")) return Response.json({})
      return Response.json({ error: { message: "Metadata not available" } }, { status: failure })
    } }, async kit => {
      const saved = await add(kit, "recoverable")
      setAccess(kit, "recoverable", { expiry: failure === "expired" ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z" })
      const before = kit.otherSpawns.length
      const result = await kit.plugin.auth.usage(async () => authOf(saved))
      assert.equal(result.signIn, "kept", result.error)
      assert.ok(result.error)
      assert.deepEqual(result.windows, [])
      assert.equal(kit.otherSpawns.length, before, "metadata failures cannot launch hidden CLI prompts")
      if (failure === "expired") assert.equal(calls, 0, "expired credentials must not be sent to HTTP")
      else assert.ok(calls > 0)
      const httpBeforeChat = calls
      const request = await client(kit, authOf(saved))
      kit.defaultPrompt = async agent => { await agent.text("CLI still usable"); return { stopReason: "end_turn" } }
      const reply = await readSse(await request(baseBody()))
      assert.equal(reply.error, null)
      assert.equal(reply.content[0].text, "CLI still usable")
      assert.equal(calls, httpBeforeChat)
      assert.equal(fs.existsSync(path.join(rootOf(kit), "recoverable", "bridge-state", "service-status.json")), false)
    })
  })
}

const TOS_MESSAGE = "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
test("quota-detected TOS automatically turns off that Magpie account and keeps its credentials", async () => {
  const calls = []
  await withKit({
    env: { MAGPIE_WEB_KEY: "test-only-admin-key-123456" },
    pluginInput: { magpie: { option: (_provider, key) => key === "auto_disable_suspended" } },
    httpRequest: (options, callback) => {
      const req = new EventEmitter()
      req.destroy = () => {}
      req.end = body => {
        calls.push({ options, body: JSON.parse(body) })
        setImmediate(() => {
          const res = Object.assign(new EventEmitter(), { statusCode: 200, resume() {} })
          callback(res)
        })
      }
      return req
    },
    fetch: async url => url.endsWith(":loadCodeAssist") ? Response.json({})
      : new Response(TOS_MESSAGE, { status: 403 }),
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "blocked"), add(kit, "healthy")])
    setAccess(kit, "blocked")
    const read = () => kit.plugin.auth.usage(async () => authOf(a))
    const usage = await read()
    assert.equal(usage.signIn, "expired")
    assert.match(usage.error, /TOS_VIOLATION/)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { agent: "plugin:agy-cli", user: "blocked" })
    assert.equal(calls[0].options.hostname, "127.0.0.1")
    assert.equal(calls[0].options.port, 3430)
    assert.equal(calls[0].options.path, "/api/login/off")
    await new Promise(resolve => setImmediate(resolve))
    assert.match((await read()).error, /is disabled in Magpie routing/)
    const request = await client(kit, authOf(a))
    const before = kit.acpSpawns.length
    const denied = await request(baseBody())
    assert.equal(denied.status, 403)
    assert.equal((await denied.json()).error.status, 403)
    assert.equal(kit.acpSpawns.length, before)
    assert.equal(calls.length, 1)
    assert.ok(fs.existsSync(fileOf(kit, "blocked")), "disable is not credential deletion")
    kit.defaultPrompt = async agent => { await agent.text("healthy reply"); return { stopReason: "end_turn" } }
    const next = await client(kit, authOf(b))
    assert.equal((await readSse(await next(baseBody()))).content[0].text, "healthy reply")
    assert.equal(calls.length, 1, "healthy account must never be disabled")
  })
})

test("TOS warning becomes a permission error, persists per account, and never becomes a successful reply", async () => {
  await withKit({}, async kit => {
    const [a, b] = await Promise.all([add(kit, "suspended"), add(kit, "healthy")])
    const requestA = await client(kit, authOf(a))
    const requestB = await client(kit, authOf(b))
    kit.defaultPrompt = async agent => {
      const warning = "\n⚠ " + TOS_MESSAGE + "\n"
      for (const char of warning) await agent.text(char)
      return { stopReason: "end_turn" }
    }
    const response = await requestA(baseBody({ stream: false }))
    assert.equal(response.status, 403, "CLI suspension must not be a successful assistant answer")
    const error = (await response.json()).error
    assert.equal(error.type, "permission_error")
    assert.equal(error.code, "TOS_VIOLATION")
    assert.match(error.message, /violation of Terms of Service/)
    const usage = await kit.plugin.auth.usage(async () => authOf(a))
    assert.match(usage.error, /violation of Terms of Service/)
    assert.equal(usage.signIn, "expired", "report unusable sign-in separately from routing quarantine")
    const before = kit.acpSpawns.length
    assert.equal((await requestA(baseBody())).status, 403)
    assert.equal(kit.acpSpawns.length, before, "do not start another CLI for suspended account")
    kit.defaultPrompt = async agent => { await agent.text("healthy reply"); return { stopReason: "end_turn" } }
    const reply = await readSse(await requestB(baseBody()))
    assert.equal(reply.content[0].text, "healthy reply")
  })
})

test("a suspension warning split at every character without a leading newline is still an error", async () => {
  await withKit({}, async kit => {
    kit.defaultPrompt = async agent => {
      for (const char of "⚠ " + TOS_MESSAGE) await agent.text(char)
      return { stopReason: "end_turn" }
    }
    const reply = await readSse(await kit.request(baseBody()))
    assert.equal(reply.error?.status, 403)
    assert.equal(reply.error?.code, "TOS_VIOLATION")
    assert.equal(reply.content.length, 0)
  })
})

for (const mode of ["attempt", "rpc", "log"]) {
  test(`TOS ${mode} fails as 403, blocks after restart and token refresh, and has explicit recovery`, { timeout: 5000 }, async () => {
    await withKit({}, async kit => {
      const a = await add(kit, "suspended")
      const request = await client(kit, authOf(a))
      kit.defaultPrompt = async agent => {
        if (mode === "rpc") throw new Error(TOS_MESSAGE)
        if (mode === "log") {
          const logfile = agent.args[agent.args.indexOf("--log-file") + 1]
          const error = { code: 403, status: "PERMISSION_DENIED", message: "Service disabled",
            padding: "x".repeat(1100), details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }] }
          fs.appendFileSync(logfile, `E123] agent executor error: ${JSON.stringify({ error })}\nE123] agent executor error: retry failed\n`)
          await agent.text("\n⚠ Agent execution terminated due to error.\n")
          return { stopReason: "end_turn" }
        }
        await agent.text("\n⚠ API error (attempt 1): " + TOS_MESSAGE)
        await new Promise(() => {})
      }
      const reply = await readSse(await request(baseBody()))
      assert.equal(reply.error?.status, 403)
      assert.equal(reply.error?.code, "TOS_VIOLATION")
      assert.equal(reply.content.length, 0)
      const statusFile = path.join(rootOf(kit), "suspended", "bridge-state", "service-status.json")
      const saved = fs.readFileSync(statusFile, "utf8")
      assert.equal(JSON.parse(saved).reason, "TOS_VIOLATION")
      assert.doesNotMatch(saved, /token|@gmail|access-/)
      const tokenFile = fileOf(kit, "suspended")
      const token = JSON.parse(fs.readFileSync(tokenFile, "utf8"))
      token.token.access_token = "new-access-token"
      token.token.expiry = "2099-01-01T00:00:00Z"
      fs.writeFileSync(tokenFile, JSON.stringify(token))
      assert.equal((await request(baseBody())).status, 403)
      await kit.finishChildren()
      const opts = { env: { AGY_BRIDGE_ACCOUNTS_DIR: rootOf(kit), AGY_PATH: kit.agyPath } }
      await withKit(opts, async restarted => {
        const ask = await client(restarted, authOf(a))
        const result = await ask(baseBody())
        assert.equal(result.status, 403)
        assert.equal(result.headers.get("X-Magpie-Sign-In"), "expired")
        assert.equal(restarted.acpSpawns.length, 0)
        assert.equal((await restarted.plugin.auth.usage(async () => authOf(a))).signIn, "expired")
      })
      // Operator recovery after appeal, with the old hosts stopped.
      fs.rmSync(statusFile)
      await withKit(opts, async recovered => {
        recovered.defaultPrompt = async agent => { await agent.text("restored"); return { stopReason: "end_turn" } }
        const ask = await client(recovered, authOf(a))
        assert.equal((await readSse(await ask(baseBody()))).content[0].text, "restored")
      })
    })
  })
}

for (const detail of ["PERMISSION_DENIED (code 403): access denied", "Eligibility check failed: not currently available in your location.", "RESOURCE_EXHAUSTED (code 429): quota exhausted"]) {
  test(`non-suspension CLI error does not persist a ban: ${detail}`, async () => {
    await withKit({}, async kit => {
      kit.defaultPrompt = async () => { throw new Error(detail) }
      const failed = await readSse(await kit.request(baseBody()))
      assert.ok(failed.error)
      assert.notEqual(failed.error.code, "TOS_VIOLATION")
      kit.defaultPrompt = async agent => { await agent.text("still usable"); return { stopReason: "end_turn" } }
      assert.equal((await readSse(await kit.request(baseBody()))).content[0].text, "still usable")
    })
  })
}

test("quoting the TOS warning within an explanation is ordinary answer text", async () => {
  for (const text of [`agy says: ⚠ ${TOS_MESSAGE}`, `⚠ ${TOS_MESSAGE}\nThis is an example, not your account status.`]) {
    await withKit({}, async kit => {
      kit.defaultPrompt = async agent => { for (const c of text) await agent.text(c); return { stopReason: "end_turn" } }
      const reply = await readSse(await kit.request(baseBody()))
      assert.equal(reply.error, null)
      assert.equal(reply.content.map(b => b.text || "").join(""), text)
    })
  }
})

test("explicit HTTP quota suspension overrides another endpoint and a successful plan", async () => {
  await withKit({
    fetch: async url => url.endsWith(":loadCodeAssist") ? Response.json({ paidTier: { id: "g1-pro-tier" } })
      : url.startsWith("https://daily-cloudcode-pa.googleapis.com/") ? Response.json(summary())
      : new Response(TOS_MESSAGE, { status: 403 }),
  }, async kit => {
    const a = await add(kit, "a")
    setAccess(kit, "a")
    const usage = await kit.plugin.auth.usage(async () => authOf(a))
    assert.equal(usage.signIn, "expired")
    assert.match(usage.error, /TOS_VIOLATION/)
    const request = await client(kit, authOf(a))
    assert.equal((await request(baseBody())).status, 403)
    assert.equal(kit.acpSpawns.length, 0)
  })
})

test("structured suspension in ACP error data blocks the account during session setup", async () => {
  await withKit({ sessionNewError: { code: -32603, message: "Upstream error", data: { error: {
    code: 403, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }],
  } } } }, async kit => {
    const result = await kit.request(baseBody())
    assert.equal(result.status, 403)
    assert.equal((await result.json()).error.code, "TOS_VIOLATION")
    assert.equal((await kit.plugin.auth.usage()).signIn, "expired")
  })
})

test("concurrent model openings keep each profile's CLI and tool results separate", { timeout: 10000 }, async () => {
  await withKit({ offeredModels: [
    ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ] }, async kit => {
    const accounts = await Promise.all([add(kit, "a"), add(kit, "b")])
    const clients = await Promise.all(accounts.map(a => client(kit, authOf(a))))
    let entered = 0, release
    const ready = new Promise(resolve => { release = resolve })
    kit.defaultPrompt = async agent => {
      if (++entered === 4) release()
      await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 1000))])
      const result = await agent.tool("Read", { path: `/${nameOf(agent.args)}/${agent.sessionId}` })
      await agent.text(`${nameOf(agent.args)}:${agent.sessionId}:${result.result.content[0].text}`)
      return { stopReason: "end_turn" }
    }
    const requests = clients.flatMap((ask, i) => ["gemini-3.8-flash", "claude-sonnet-5-5"].map(model => ({
      ask, account: ["a", "b"][i], body: baseBody({ model }),
    })))
    const first = await Promise.all(requests.map(async r => {
      const response = await r.ask(r.body)
      assert.equal(response.status, 200)
      return readSse(response)
    }))
    assert.equal(entered, 4, "all four model/profile turns overlap")
    assert.ok(first.every(reply => reply.stopReason === "tool_use"))
    assert.equal(new Set(first.map(reply => reply.content.find(block => block.type === "tool_use").id)).size, 4)
    const done = await Promise.all(requests.map((r, i) =>
      r.ask(continueWithToolResults(r.body, first[i], () => `private-result-${i}`)).then(readSse)))
    for (const [i, reply] of done.entries()) {
      assert.equal(reply.error, null)
      const text = reply.content.filter(block => block.type === "text").map(block => block.text).join("")
      assert.ok(text.startsWith(requests[i].account + ":"), text)
      assert.ok(text.endsWith(`:private-result-${i}`), text)
      for (let j = 0; j < done.length; j++) if (j !== i) assert.ok(!text.includes(`private-result-${j}`), text)
    }
    assert.equal(entered, 4, "tool continuation must reuse its original CLI turn")
  })
})

test("quota refresh observes explicit plan HTTP TOS suspension even when HTTP quota succeeds", async () => {
  const httpCalls = []
  await withKit({
    env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    fetch: async (url, init) => {
      httpCalls.push({ url, token: init.headers.Authorization })
      if (url.endsWith(":retrieveUserQuotaSummary")) return Response.json(summary())
      if (url.endsWith(":fetchAvailableModels")) return Response.json({ models: {} })
      assert.equal(url, "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
      if (init.headers.Authorization === "Bearer access-a") return Response.json({ error: {
        code: 403, status: "PERMISSION_DENIED", message: "Service disabled",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }],
        refresh_token: "must-not-reach-status-or-ui",
      } }, { status: 403 })
      return Response.json({ paidTier: { id: "g1-pro-tier" } })
    },
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    setAccess(kit, "a"); setAccess(kit, "b")
    const readA = () => kit.plugin.auth.usage(async () => authOf(a))
    const before = kit.otherSpawns.length
    const [suspended, healthy, duplicate] = await Promise.all([readA(), kit.plugin.auth.usage(async () => authOf(b)), readA()])
    const plans = httpCalls.filter(call => call.url.endsWith(":loadCodeAssist"))
    assert.equal(plans.length, 2, "both accounts must actually reach the metadata endpoint")
    assert.equal(suspended.signIn, "expired", "quota success must not hide an explicit plan suspension")
    assert.match(suspended.error, /403.*TOS_VIOLATION/)
    assert.doesNotMatch(suspended.error, /must-not-reach/)
    assert.equal(duplicate.error, suspended.error)
    assert.equal(suspended.plan, undefined)
    assert.equal(healthy.signIn, "kept")
    assert.equal(healthy.plan, "Google AI Pro")
    assert.equal(healthy.windows[0].used, 20)
    assert.equal(kit.otherSpawns.length, before)
    const keys = httpCalls.map(call => `${call.token} ${call.url}`)
    assert.equal(new Set(keys).size, keys.length, "coalesce concurrent refreshes")
    assert.equal(kit.acpSpawns.length, 0, "status refresh must not send an inference probe")
    const persisted = fs.readFileSync(path.join(rootOf(kit), "a", "bridge-state", "service-status.json"), "utf8")
    assert.equal(JSON.parse(persisted).reason, "TOS_VIOLATION")
    assert.doesNotMatch(persisted, /access-a|refresh_token|must-not-reach/)
    const httpBefore = httpCalls.length
    assert.equal((await readA()).signIn, "expired")
    const requestA = await client(kit, authOf(a))
    assert.equal((await requestA(baseBody())).status, 403)
    assert.equal(httpCalls.length, httpBefore)
    assert.equal(kit.otherSpawns.length, before)
    kit.defaultPrompt = async agent => { await agent.text("healthy CLI reply"); return { stopReason: "end_turn" } }
    const requestB = await client(kit, authOf(b))
    assert.equal((await readSse(await requestB(baseBody()))).content[0].text, "healthy CLI reply")
    assert.equal(httpCalls.length, httpBefore, "chat remains CLI-only")
  })
})

test("model fallback marker stays with its account and clears after that account warms", async () => {
  await withKit({}, async kit => {
    const a = await add(kit, "a"), b = await add(kit, "b")
    const marker = Symbol.for("magpie.fellBack")
    const rows = args => ["high", "low"].map(effort => [`gemini-test-${nameOf(args)}-${effort}`, `Account ${nameOf(args)} (${effort})`])
    kit.offeredModels = rows
    kit.modelsBehavior = ({ args }) => nameOf(args) === "b" ? { code: 1 } : { stdout: modelsOutput(rows(args)) }
    const models = account => kit.plugin.provider.models({}, { auth: authOf(account) })
    await models(a)
    await kit.plugin.provider.warming?.()
    const ready = await models(a)
    assert.equal(ready[marker], undefined)
    assert.ok(ready["gemini-test-a"])
    const cold = await models(b)
    assert.equal(cold[marker], true)
    assert.equal((await models(a))[marker], undefined, "one failed catalog must not mark another account")
    assert.equal(cold["gemini-test-a"], undefined)
    // Permit the failed account's refresh backoff to expire.
    kit.clock.advance(10 * 60_000)
    kit.modelsBehavior = ({ args }) => ({ stdout: modelsOutput(rows(args)) })
    await models(b)
    await kit.plugin.provider.warming?.()
    const warmed = await models(b)
    assert.equal(warmed[marker], undefined)
    assert.ok(warmed["gemini-test-b"])
    assert.equal(warmed["gemini-test-a"], undefined)
  })
})

test("run_command summary repair respects each account's tool schema", async () => {
  await withKit({}, async kit => {
    const a = await add(kit, "a"), b = await add(kit, "b")
    const listed = new Map()
    kit.defaultPrompt = async agent => {
      listed.set(nameOf(agent.args), (await agent.listTools()).result.tools[0].inputSchema)
      await agent.tool("run_command", { command: "pwd" })
    }
    const schema = withSummary => ({ type: "object", properties: { command: { type: "string" },
      ...(withSummary ? { toolSummary: { type: "string" } } : {}) },
      required: withSummary ? ["command", "toolSummary"] : ["command"], additionalProperties: false })
    const ask = async (account, withSummary) => {
      const request = await client(kit, authOf(account))
      return readSse(await request(baseBody({ tools: [{ name: "run_command", input_schema: schema(withSummary) }] })))
    }
    const [ra, rb] = await Promise.all([ask(a, true), ask(b, false)])
    assert.deepEqual(ra.content.find(c => c.type === "tool_use").input, { command: "pwd", toolSummary: "Run command" })
    assert.deepEqual(rb.content.find(c => c.type === "tool_use").input, { command: "pwd" })
    assert.deepEqual(listed.get("a").required, ["command"])
    assert.equal(listed.get("b").properties.toolSummary, undefined)
  })
})

for (const stream of [true, false]) {
  test(`prompt refusal is 400, not a ban; healthy account still chats (stream=${stream})`, async () => {
    await withKit({}, async kit => {
      const a = await add(kit, "a"), b = await add(kit, "b")
      kit.defaultPrompt = async agent => {
        if (nameOf(agent.args) === "a") {
          await agent.text("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n")
          await agent.text("\n⚠ Agent execution terminated due to error.\n")
        } else await agent.text("healthy")
        return { stopReason: "end_turn" }
      }
      const request = await client(kit, authOf(a))
      const response = await request(baseBody({ stream, system: "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL." }))
      const reply = stream ? await readSse(response) : await response.json()
      if (!stream) assert.equal(response.status, 400)
      assert.equal(reply.error.type, "invalid_request_error")
      assert.equal(reply.error.status, 400)
      assert.equal(reply.error.code, undefined)
      assert.equal(fs.existsSync(path.join(rootOf(kit), "a", "bridge-state", "service-status.json")), false)
      const healthy = await client(kit, authOf(b))
      assert.equal((await readSse(await healthy(baseBody()))).content[0].text, "healthy")
    })
  })
}
