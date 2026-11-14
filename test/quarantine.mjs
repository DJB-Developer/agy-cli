import assert from "node:assert/strict"
import http from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { createMagpieQuarantine } from "../quarantine.mjs"

const env = { MAGPIE_WEB_KEY: "test-only-admin-key-123456" }
async function server(t, handler) {
  const s = http.createServer(handler)
  s.listen(0, "127.0.0.1")
  await once(s, "listening")
  t.after(() => { s.closeAllConnections(); s.close() })
  return s.address().port
}

test("TOS quarantine closes only the named account using the existing local web API", async t => {
  const calls = []
  const port = await server(t, async (req, res) => {
    let body = ""
    for await (const part of req) body += part
    calls.push({ path: req.url, method: req.method, body: JSON.parse(body), headers: req.headers })
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{}')
  })
  const q = createMagpieQuarantine({ user: "blocked", env, enabled: () => true, port })
  t.after(q.dispose)
  const first = q.ensure()
  assert.equal(q.ensure(), first, "concurrent detection shares one administration request")
  await first
  await q.ensure()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body, { agent: "plugin:agy-cli", user: "blocked" })
  assert.equal(calls[0].path, "/api/login/off")
  assert.equal(calls[0].method, "POST")
  assert.equal(calls[0].headers.cookie, `magpie_web_${port}=${env.MAGPIE_WEB_KEY}`)
  assert.equal(calls[0].headers.origin, `http://127.0.0.1:${port}`)
  assert.match(q.note(), /is disabled in Magpie routing/)
  assert.ok(!q.note().includes(env.MAGPIE_WEB_KEY))
})

test("missing credentials, unknown accounts and disabled options never mutate routing", async () => {
  for (const config of [
    { env: {} }, { env: { MAGPIE_WEB_KEY: "key\r\ninjection" } },
    { user: null }, { user: "someone@example.com" }, { enabled: () => false },
    { enabled: () => { throw new Error("private option") } },
  ]) {
    const q = createMagpieQuarantine({ user: "blocked", env, enabled: () => true,
      request: () => assert.fail("must not reach administration API"), ...config })
    await q.ensure()
    assert.match(q.note(), /CLI remains blocked/)
    assert.doesNotMatch(q.note(), /private option|injection/)
    q.dispose()
  }
})

test("failed disable is retried after backoff without leaking the server body", async t => {
  let calls = 0, clock = 100_000
  const port = await server(t, (req, res) => {
    req.resume(); res.writeHead(++calls === 1 ? 401 : 200); res.end("private response")
  })
  const q = createMagpieQuarantine({ user: "blocked", env, enabled: () => true, port, now: () => clock })
  t.after(q.dispose)
  await q.ensure()
  assert.match(q.note(), /failed \(HTTP 401\)/)
  assert.doesNotMatch(q.note(), /private response/)
  await q.ensure()
  assert.equal(calls, 1)
  clock += 60_001
  await q.ensure()
  assert.equal(calls, 2)
  assert.match(q.note(), /is disabled in Magpie routing/)
})

test("redirects never receive the management credential", async t => {
  let calls = 0
  const port = await server(t, (req, res) => {
    calls++; req.resume(); res.writeHead(302, { Location: "/elsewhere" }); res.end()
  })
  const q = createMagpieQuarantine({ user: "blocked", env, enabled: () => true, port })
  t.after(q.dispose)
  await q.ensure()
  assert.equal(calls, 1)
  assert.match(q.note(), /failed \(HTTP 302\)/)
})

test("a hung administration request times out; disposal cancels in-flight work", async t => {
  const port = await server(t, req => req.resume())
  const q = createMagpieQuarantine({ user: "blocked", env, enabled: () => true, port, timeoutMs: 30 })
  await q.ensure()
  assert.match(q.note(), /failed \(timeout\)/)
  q.dispose()
  const other = createMagpieQuarantine({ user: "other", env, enabled: () => true, port })
  const pending = other.ensure()
  other.dispose()
  await pending
  assert.equal(other.ensure(), undefined)
})
