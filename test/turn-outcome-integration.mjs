import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse, MESSAGES_URL } from "./testkit.mjs"
import { appendStep, quotaError } from "./outcome-fixture.mjs"

const profileOf = agent => agent.args.find(arg => arg.startsWith("--gemini_dir="))?.slice("--gemini_dir=".length)
const dbOf = (kit, agent) => path.join(profileOf(agent) || path.join(kit.home, ".gemini"), "antigravity-cli", "conversations", `${agent.sessionId}.db`)
async function withKit(fn) {
  const kit = await createBridgeKit({ env: { AGY_BRIDGE_STEP_USAGE: "0" } })
  fs.mkdirSync(path.join(kit.home, ".gemini"), { recursive: true })
  try { await fn(kit) } finally { await kit.dispose() }
}
for (const stream of [true, false]) {
  test(`database-only error after ACP end_turn fails with exact reset time (stream=${stream})`, async () => {
    await withKit(async kit => {
      kit.defaultPrompt = async agent => {
        appendStep(dbOf(kit, agent), 14, "user")
        appendStep(dbOf(kit, agent), 17, quotaError)
        return { stopReason: "end_turn" }
      }
      const response = await kit.request(baseBody({ stream }))
      const reply = stream ? await readSse(response) : await response.json()
      assert.equal(reply.error?.type, "rate_limit_error")
      assert.equal(reply.error.status, 429)
      assert.equal(reply.error.reset_at, new Date(kit.clock.now() + 3723500).toISOString())
      assert.match(reply.error.message, /resets at .* UTC\+0\./)
      if (!stream) {
        assert.equal(response.status, 429)
        assert.equal(response.headers.get("Retry-After"), "3724")
      }
    })
  })
}

for (const [status, code, message] of [[400, "INVALID_ARGUMENT", "Bad argument."], [403, "PERMISSION_DENIED", "Not available in your location."], [503, "UNAVAILABLE", "Temporarily unavailable."]]) {
  test(`database HTTP ${status} is preserved without treating it as a TOS suspension`, async () => {
    await withKit(async kit => {
      kit.defaultPrompt = async agent => {
        appendStep(dbOf(kit, agent), 17, `Error ${status}, Message: ${message}, Status: ${code}, Details: [retryDelay:42s]`)
        return { stopReason: "end_turn" }
      }
      const response = await kit.request(baseBody({ stream: false }))
      const reply = await response.json()
      assert.equal(response.status, status)
      assert.equal(reply.error.code, code)
      assert.equal(response.headers.get("X-Magpie-Sign-In"), null)
      assert.equal(reply.error.reset_at, status === 503 ? new Date(kit.clock.now() + 42000).toISOString() : undefined)
      assert.equal(response.headers.get("Retry-After"), status === 503 ? "42" : null)
      kit.defaultPrompt = async agent => { await agent.text("still usable"); return { stopReason: "end_turn" } }
      assert.equal((await readSse(await kit.request(baseBody()))).content[0].text, "still usable")
    })
  })
}

test("old database errors never recur; a quoted warning in an ordinary step remains content", async () => {
  await withKit(async kit => {
    let session
    kit.defaultPrompt = async agent => {
      session = agent
      appendStep(dbOf(kit, agent), 15, "first success")
      await agent.text("first success")
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    appendStep(dbOf(kit, session), 17, quotaError)
    kit.defaultPrompt = async agent => {
      assert.equal(agent.sessionId, session.sessionId)
      appendStep(dbOf(kit, agent), 15, quotaError)
      await agent.text("quoting an error is not a failure")
      return { stopReason: "end_turn" }
    }
    const second = await readSse(await kit.request({ ...body, messages: [...body.messages,
      { role: "assistant", content: first.content }, { role: "user", content: "next" }] }))
    assert.equal(second.error, null)
  })
})

test("database detection supplements an ACP RPC failure and still handles partial output", async () => {
  for (const rpc of [true, false]) await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      await agent.text("partial answer already sent")
      appendStep(dbOf(kit, agent), 17, quotaError)
      if (rpc) throw Error("opaque ACP failure")
      return { stopReason: "end_turn" }
    }
    const result = await readSse(await kit.request(baseBody()))
    assert.equal(result.error.status, 429)
    assert.ok(result.content.some(c => c.text?.includes("partial answer")))
    assert.equal(kit.promptSerial, 1, "must not transparently replay a partial answer")
  })
})

test("unreadable database does not break success or existing warning classification", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      const db = dbOf(kit, agent)
      fs.mkdirSync(path.dirname(db), { recursive: true })
      fs.writeFileSync(db, "incompatible database")
      await agent.text("normal answer")
      return { stopReason: "end_turn" }
    }
    const body = baseBody()
    const first = await readSse(await kit.request(body))
    assert.equal(first.error, null)
    kit.defaultPrompt = async agent => {
      await agent.text("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): quota exhausted; retryDelay:42s\n")
      await agent.text("\n⚠ Agent execution terminated due to error.\n")
      return { stopReason: "end_turn" }
    }
    const result = await readSse(await kit.request({ ...body, messages: [...body.messages,
      { role: "assistant", content: first.content }, { role: "user", content: "next" }] }))
    assert.equal(result.error.type, "rate_limit_error")
    assert.equal(result.error.reset_at, new Date(kit.clock.now() + 42000).toISOString())
  })
})

test("cancelled ACP result is not reclassified using an error step", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, quotaError)
      return { stopReason: "cancelled" }
    }
    assert.equal((await readSse(await kit.request(baseBody()))).error, null)
  })
})

import { EventEmitter } from "node:events"
import { TOS_MESSAGE } from "../service-status.mjs"
test("database-only TOS quarantines only its account; another concurrent account stays healthy", async () => {
  const calls = []
  const kit = await createBridgeKit({
    env: { AGY_BRIDGE_STEP_USAGE: "0", MAGPIE_WEB_KEY: "outcome-fixture-web-key" },
    pluginInput: { magpie: { option: (_provider, key) => key === "auto_disable_suspended" } },
    httpRequest: (opts, callback) => {
      const req = new EventEmitter()
      req.destroy = () => {}
      req.end = body => {
        calls.push({ opts, body: JSON.parse(body) })
        setImmediate(() => callback(Object.assign(new EventEmitter(), { statusCode: 200, resume() {} })))
      }
      return req
    },
  })
  try {
    const add = async name => {
      const login = await kit.plugin.auth.methods[1].authorize({ name, refresh_token: `1//fixture-${name}` })
      const result = await login.callback()
      assert.equal(result.type, "success")
      const client = await kit.plugin.auth.loader(async () => ({ ...result, type: "api" }))
      return body => client.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body) })
    }
    const a = await add("blocked"), b = await add("healthy")
    let blockedRoot
    kit.defaultPrompt = async agent => {
      if (path.basename(profileOf(agent)) === "blocked") {
        blockedRoot = profileOf(agent)
        appendStep(dbOf(kit, agent), 17, `Error 403, Message: ${TOS_MESSAGE}, Status: PERMISSION_DENIED, Details: [reason:TOS_VIOLATION retryDelay:1h]`)
      } else {
        appendStep(dbOf(kit, agent), 15, "healthy")
        await agent.text("healthy")
      }
      return { stopReason: "end_turn" }
    }
    const [ra, rb] = await Promise.all([a(baseBody({ stream: false })), b(baseBody()).then(readSse)])
    const denied = await ra.json()
    assert.equal(ra.status, 403)
    assert.equal(ra.headers.get("X-Magpie-Sign-In"), "expired")
    assert.equal(denied.error.code, "TOS_VIOLATION")
    assert.equal(denied.error.reset_at, undefined)
    assert.equal(ra.headers.get("Retry-After"), null)
    assert.equal(rb.error, null)
    assert.equal(rb.content[0].text, "healthy")
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { agent: "plugin:agy-cli", user: "blocked" })
    assert.equal(calls[0].opts.hostname, "127.0.0.1")
    assert.equal(calls[0].opts.path, "/api/login/off")
    assert.equal(JSON.parse(fs.readFileSync(path.join(blockedRoot, "bridge-state", "service-status.json"))).reason, "TOS_VIOLATION")
    assert.ok(fs.existsSync(path.join(blockedRoot, "antigravity-cli", "antigravity-oauth-token")))
    const count = kit.promptSerial
    assert.equal((await a(baseBody())).status, 403)
    assert.equal(kit.promptSerial, count, "persisted ban must block before CLI")
    assert.equal((await readSse(await b(baseBody()))).error, null)
  } finally { await kit.dispose() }
})

for (const quota of [false, true]) test(`database error preserves prompt 400 vs explicit quota 429 (quota=${quota})`, async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, `Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED, Details: [${quota ? 'reason:QUOTA_EXHAUSTED ' : ''}retryDelay:42s]`)
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ stream: false, system: "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL." }))
    const body = await response.json()
    assert.equal(response.status, quota ? 429 : 400)
    assert.equal(body.error.type, quota ? "rate_limit_error" : "invalid_request_error")
    assert.equal(response.headers.get("Retry-After"), quota ? "42" : null)
    assert.equal(body.error.reset_at, quota ? new Date(kit.clock.now() + 42000).toISOString() : undefined)
  })
})

for (const rpc of [true, false]) test(`database evidence cannot mask an explicit CLI TOS denial (rpc=${rpc})`, async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, "unclassified native error")
      if (rpc) throw Error(TOS_MESSAGE)
      await agent.text("⚠ " + TOS_MESSAGE)
      return { stopReason: "end_turn" }
    }
    const reply = await readSse(await kit.request(baseBody()))
    assert.equal(reply.error.code, "TOS_VIOLATION")
    assert.equal(reply.error.status, 403)
    assert.equal(reply.error.reset_at, undefined)
  })
})

test("unclassified database failure does not replace an already recognized CLI quota error", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, "unclassified native error")
      await agent.text("\n⚠ API error (attempt 1): RESOURCE_EXHAUSTED (code 429): quota exhausted; retryDelay:42s\n")
      await agent.text("\n⚠ Agent execution terminated due to error.\n")
      return { stopReason: "end_turn" }
    }
    const reply = await readSse(await kit.request(baseBody()))
    assert.equal(reply.error.type, "rate_limit_error")
    assert.equal(reply.error.reset_at, new Date(kit.clock.now() + 42000).toISOString())
  })
})

test("verification notice retains no-retry advice beside a generic database 403, but TOS wins", async () => {
  for (const tos of [false, true]) await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, `Error 403, Message: ${tos ? TOS_MESSAGE : "Permission denied."}, Status: PERMISSION_DENIED`)
      await agent.text("⚠ Verification Required")
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ stream: false }))
    const result = await response.json()
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("x-should-retry"), "false")
    assert.equal(result.error.code, tos ? "TOS_VIOLATION" : "VALIDATION_REQUIRED")
  })
})

test("database-only structured verification is a no-retry 403 without permanently disabling the account", async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async agent => {
      appendStep(dbOf(kit, agent), 17, 'native error: ' + JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", details: [{
        "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "cloudcode-pa.googleapis.com", reason: "VALIDATION_REQUIRED",
      }] } }))
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ stream: false }))
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("x-should-retry"), "false")
    assert.equal(response.headers.get("X-Magpie-Sign-In"), null)
    const result = await response.json()
    assert.equal(result.error.code, "VALIDATION_REQUIRED")
    assert.equal(kit.promptSerial, 1)
    kit.defaultPrompt = async agent => { await agent.text("manually retried"); return { stopReason: "end_turn" } }
    assert.equal((await kit.request(baseBody({ stream: false }))).status, 200)
  })
})
