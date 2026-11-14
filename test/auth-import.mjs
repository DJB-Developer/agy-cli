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

test("Magpie usage returns each account's plan after CLI token renewal; chat stays on ACP", async () => {
  const calls = []
  let failPlan = false
  await withKit({
    env: { AGY_BRIDGE_STORED_SIGNIN: "" },
    fetch: async (url, init) => {
      calls.push({ url, token: init.headers.Authorization })
      if (failPlan) return new Response("private upstream error", { status: 403 })
      return Response.json({ paidTier: { name: init.headers.Authorization === "Bearer access-a" ? "Google AI Pro" : "Google AI Ultra" } })
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
    assert.equal(calls.length, 2, "concurrent quota refreshes share one metadata call per account")
    assert.deepEqual(new Set(calls.map(call => call.token)), new Set(["Bearer access-a", "Bearer access-b"]))
    assert.ok(calls.every(call => call.url.endsWith(":loadCodeAssist")))
    failPlan = true
    const failed = await readA()
    assert.equal(failed.plan, undefined, "no stale/other account's plan after failure")
    assert.equal(failed.windows[0].used, 20)
    assert.equal(failed.signIn, "kept")
    assert.equal(failed.error, undefined)
    failPlan = false
    assert.equal((await readA()).plan, "Google AI Pro", "metadata failure must not trigger quota/auth backoff")
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

test("models and usage are scoped to host-selected auth and conflicting API environment cannot override it", async () => {
  await withKit({ env: { GEMINI_API_KEY: "global-key", AGY_ADC_AUTH: "1", WSL_INTEROP: "real-wsl" },
    onSpawn: (_file, args, opts) => {
      if (args.includes("--version")) return { stdout: "1.5.9\n" }
      if (!args.includes("/usage")) return 0
      assert.equal(opts.env.GEMINI_API_KEY, "")
      assert.equal(opts.env.AGY_ADC_AUTH, "")
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
