import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
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
async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try { await fn(kit) } finally { await kit.dispose() }
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

test("Magpie queries per-account HTTP quota/plan after CLI-only token renewal; chat stays on ACP", async () => {
  const calls = []
  let failPlan = false
  await withKit({
    env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    fetch: async (url, init) => {
      calls.push({ url, token: init.headers.Authorization })
      if (url.endsWith(":retrieveUserQuotaSummary")) {
        const account = init.headers.Authorization === "Bearer access-a" ? "a" : "b"
        assert.equal(JSON.parse(init.body).project, `project-${account}`)
        return Response.json({ groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.8 }] }] })
      }
      if (failPlan) return new Response("private upstream error", { status: 403 })
      return Response.json({ cloudaicompanionProject: init.headers.Authorization === "Bearer access-a" ? "project-a" : "project-b",
        paidTier: { name: init.headers.Authorization === "Bearer access-a" ? "Google AI Pro" : "Google AI Ultra" } })
    },
    onSpawn: (_file, args) => {
      if (args.includes("--version")) return { stdout: "1.5.9\n" }
      if (!args.includes("/usage")) return 0
      const file = path.join(profileOf(args), "antigravity-cli", "antigravity-oauth-token")
      const stored = JSON.parse(fs.readFileSync(file, "utf8"))
      stored.token.access_token = `access-${nameOf(args)}`
      stored.token.expiry = "2099-01-01T00:00:00Z"
      fs.writeFileSync(file, JSON.stringify(stored))
      return { stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [
        { id: "weekly", remainingFraction: 0.8 },
      ] }] } } }) }
    },
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
    const readA = () => kit.plugin.auth.usage(async () => authOf(a))
    const [usageA, usageB, duplicateA] = await Promise.all([readA(), kit.plugin.auth.usage(async () => authOf(b)), readA()])
    assert.equal(usageA.plan, "Google AI Pro", usageA.error)
    assert.equal(usageB.plan, "Google AI Ultra", usageB.error)
    assert.equal(duplicateA.plan, usageA.plan)
    assert.equal(calls.length, 4, "concurrent quota refreshes share one plan and one quota call per account")
    assert.deepEqual(new Set(calls.map(call => call.token)), new Set(["Bearer access-a", "Bearer access-b"]))
    assert.ok(calls.every(call => /:loadCodeAssist$|:retrieveUserQuotaSummary$/.test(call.url)))
    const cliReads = () => kit.otherSpawns.filter(s => s.args.includes("/usage")).length
    assert.equal(cliReads(), 2, "expired tokens renew through their own CLI profiles")
    failPlan = true
    const failed = await readA()
    assert.equal(failed.plan, undefined, "no stale/other account's plan after failure")
    assert.equal(failed.windows[0].used, 20)
    assert.equal(failed.signIn, "kept")
    assert.equal(failed.error, undefined)
    failPlan = false
    assert.equal((await readA()).plan, "Google AI Pro", "metadata failure must not trigger quota/auth backoff")
    assert.equal(cliReads(), 2, "valid tokens refresh metadata without starting the CLI")
    const before = calls.length
    kit.defaultPrompt = async agent => { await agent.text("CLI reply"); return { stopReason: "end_turn" } }
    const request = await client(kit, authOf(a))
    const reply = await readSse(await request(baseBody()))
    assert.equal(reply.content[0].text, "CLI reply")
    assert.ok(kit.acpSpawns.some(spawn => nameOf(spawn.args) === "a" && spawn.args.includes("acp")))
    assert.equal(calls.length, before, "chat must not call the plan or direct inference API")
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
      const a = init.headers.Authorization === "Bearer access-a"
      if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: a ? "project-a" : "project-b" })
      assert.equal(JSON.parse(init.body).project, a ? "project-a" : "project-b")
      return Response.json({ groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", remainingFraction: a ? 0.8 : 0.3 }] }] })
    },
    onSpawn: (_file, args, opts) => {
      if (args.includes("--version")) return { stdout: "1.5.9\n" }
      if (!args.includes("/usage")) return 0
      assert.equal(opts.env.GEMINI_API_KEY, "")
      assert.equal(opts.env.AGY_ADC_AUTH, "")
      const file = path.join(profileOf(args), "antigravity-cli", "antigravity-oauth-token")
      const saved = JSON.parse(fs.readFileSync(file, "utf8"))
      saved.token.access_token = `access-${nameOf(args)}`
      saved.token.expiry = "2099-01-01T00:00:00Z"
      fs.writeFileSync(file, JSON.stringify(saved))
      return { stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [
        { id: "weekly", remainingFraction: nameOf(args) === "a" ? 0.8 : 0.3 },
      ] }] } } }) }
    },
  }, async kit => {
    const [a, b] = await Promise.all([add(kit, "a"), add(kit, "b")])
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

test("Magpie's named-account quota hook exposes the original error with credentials removed", async () => {
  await withKit({ onSpawn: (_file, args) => {
    if (args.includes("--version")) return { stdout: "1.5.9\n" }
    if (args.includes("/usage")) return { stdout: JSON.stringify({ status: "FAILED", error: "Your current account is not eligible: country association unavailable", refresh_token: "private-account-token" }) }
    return 0
  } }, async kit => {
    const saved = await add(kit, "quota-ui")
    const result = await kit.plugin.auth.usage(async () => authOf(saved))
    assert.equal(result.signIn, "kept")
    assert.match(result.error, /CLI error \(redacted\):/)
    assert.match(result.error, /country association unavailable/)
    assert.doesNotMatch(result.error, /private-account-token/)
    const count = kit.otherSpawns.length
    assert.deepEqual(await kit.plugin.auth.usage(async () => authOf(saved)), result)
    assert.equal(kit.otherSpawns.length, count)
  })
})
