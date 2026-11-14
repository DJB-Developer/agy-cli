import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchUsage, createUsageReader } from "../usage.mjs"
import { fetchQuotaSummary } from "../quota-http.mjs"
import { readStoredSignIn, readAccessToken, forgetStoredSignIn } from "../signin.mjs"

const group = (name = "Gemini Models", id = "gemini-5h", fraction = 0.75) => ({ displayName: name, buckets: [
  { bucketId: id, window: "5h", remainingFraction: fraction, resetTime: "2099-01-01T00:00:00Z" },
] })
const catalog = ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-4-argon", "claude-sonnet-5-5", "gpt-oss-120b"]
const load = (project = "project-a", name = "Google AI Pro") => ({ cloudaicompanionProject: project, paidTier: { name } })
const options = (extra = {}) => ({
  readToken: async () => "fake-access-a", renew: () => assert.fail("valid token must not start CLI"),
  getModels: () => catalog, diagnostic: () => {},
  fetch: async url => Response.json(url.endsWith(":loadCodeAssist") ? load() : { groups: [group()] }),
  ...extra,
})
const stored = { state: "present", fp: "credential-a", canRenew: true, expired: false }

test("HTTP-only refresh reads plan/project and group quotas, without CLI or OAuth token calls", async () => {
  const calls = []
  const result = await fetchUsage(null, options({ fetch: async (url, init) => {
    calls.push({ url, init })
    assert.equal(init.headers.Authorization, "Bearer fake-access-a")
    assert.match(init.headers["User-Agent"], /^antigravity\/hub\//)
    assert.equal(init.method, "POST")
    assert.equal(init.redirect, "error")
    assert.doesNotMatch(init.body, /refresh_token|messages|prompt/)
    if (url.endsWith(":loadCodeAssist")) return Response.json(load({ id: "project-a" }))
    assert.deepEqual(JSON.parse(init.body), { project: "project-a" })
    return Response.json({ groups: [group(), group("Claude and GPT models", "3p-weekly", 0), group("Gemini 4 Argon", "argon-weekly", 0.4)] })
  } }))
  assert.equal(calls.length, 2)
  assert.ok(calls.every(c => /:loadCodeAssist$|:retrieveUserQuotaSummary$/.test(c.url)))
  assert.equal(result.plan, "Google AI Pro")
  assert.deepEqual(result.windows.map(w => w.used), [25, 100, 60])
  assert.deepEqual(result.windows.map(w => w.models), [catalog.slice(0, 2), catalog.slice(3), [catalog[2]]])
  assert.ok(result.windows.every(w => w.aside === false))
})

test("partial daily summaries merge fallback Gemini buckets without duplicating third-party limits", async () => {
  const calls = []
  const result = await fetchUsage(null, options({ fetch: async url => {
    calls.push(url)
    if (url.endsWith(":loadCodeAssist")) return Response.json(load())
    if (url.includes("sandbox")) return new Response("unavailable", { status: 503 })
    if (url.includes("daily-")) return Response.json({ groups: [group("Claude and GPT models", "3p-5h", 0.2)] })
    return Response.json({ groups: [group("Claude and GPT models", "3p-5h", 0.8), group(),
      { ...group(), buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 }] }] })
  } }))
  assert.equal(calls.length, 4)
  assert.deepEqual(result.windows.map(w => w.used), [80, 25, 50])
  assert.equal(result.windows[2].span, 604800)
})

test("loadCodeAssist falls back to production; no project never triggers onboarding or inference", async () => {
  let loads = 0
  const result = await fetchUsage(null, options({ fetch: async url => {
    if (url.endsWith(":loadCodeAssist")) return ++loads === 1 ? new Response("unavailable", { status: 503 }) : Response.json(load())
    return Response.json({ groups: [group()] })
  } }))
  assert.equal(result.plan, "Google AI Pro")
  const calls = []
  await assert.rejects(fetchUsage(null, options({ fetch: async url => {
    calls.push(url)
    return Response.json({ ineligibleTiers: [{ reasonMessage: "not available in your location" }] })
  } })), error => /no account project/.test(error.message) && /your location/.test(error.detail))
  assert.equal(calls.length, 2)
  assert.ok(calls.every(url => url.endsWith(":loadCodeAssist")))
})

test("unknown Gemini buckets keep probing and accept measured fallback readings", async () => {
  const result = await fetchUsage(null, options({ fetch: async url => {
    if (url.endsWith(":loadCodeAssist")) return Response.json(load())
    return Response.json({ groups: [group("Gemini Models", "gemini-5h", url.includes("daily-") ? null : 0.6)] })
  } }))
  assert.equal(result.windows.length, 1)
  assert.equal(result.windows[0].used, 40)
})

test("unknown groups/fractions stay display-only; missing Argon never borrows the Gemini quota", async () => {
  const result = await fetchUsage(null, options({ fetch: async url => Response.json(url.endsWith(":loadCodeAssist") ? load() : {
    groups: [group(), group("Unknown models", "unknown", 0), group("Gemini 4 Argon", "argon", null)],
  }) }))
  assert.deepEqual(result.windows[0].models, catalog.slice(0, 2))
  assert.ok(result.windows.slice(1).every(w => w.aside && !w.models))
})

test("empty, malformed, oversized and unmeasured summaries never invent a full allowance", async () => {
  for (const response of [() => new Response("not json"), () => new Response("x".repeat(1024 * 1024 + 1)),
    () => Response.json({}), () => Response.json({ groups: [] }), () => Response.json({ groups: [group("Gemini", "gemini-5h", null)] })]) {
    await assert.rejects(fetchUsage(null, options({ fetch: async url => url.endsWith(":loadCodeAssist") ? Response.json(load()) : response() })))
  }
})

test("expired credentials renew once through CLI, then HTTP uses only the newly stored token", async () => {
  let token = "", renewals = 0
  const result = await fetchUsage("/fake/agy", options({ stored: { ...stored, expired: true }, geminiDir: "/profiles/a",
    readToken: async opts => { assert.equal(opts.geminiDir, "/profiles/a"); return token },
    renew: async (agy, opts) => {
      assert.equal(agy, "/fake/agy")
      assert.equal(opts.geminiDir, "/profiles/a")
      assert.equal(await opts.readPlan(), "")
      renewals++
      token = "fresh-access"
      // Renewal can succeed even when the subsequent CLI usage command fails.
      throw Error("CLI usage failed after token renewal")
    },
    fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer fresh-access")
      return Response.json(url.endsWith(":loadCodeAssist") ? load() : { groups: [group()] })
    },
  }))
  assert.equal(renewals, 1)
  assert.equal(result.windows[0].used, 25)
})

test("401 retries through CLI at most once; 403, 429 and network errors never renew or kill sign-in", async () => {
  for (const status of [401, 403, 429, 503, 0]) {
    let renewals = 0
    const read = createUsageReader(() => "/fake/agy", options({ signIn: async () => stored,
      renew: async () => { renewals++ }, fetch: async () => {
        if (!status) throw Error("network failure")
        return Response.json({ error: { message: "upstream denial" } }, { status })
      },
    }))
    const result = await read()
    assert.ok(result.error)
    assert.equal(result.signIn, "kept")
    assert.equal(renewals, status === 401 ? 1 : 0)
  }
})

test("unreadable/missing credentials never start background browser login", async () => {
  for (const status of [{ state: "unknown" }, { state: "missing" }, { ...stored, canRenew: false, expired: true }]) {
    await assert.rejects(fetchUsage("/fake/agy", options({ readToken: async () => "", stored: status,
      fetch: () => assert.fail("must not query without credentials"),
    })), /No usable access token/)
  }
})

test("deadlines cover credential reads, renewal, HTTP headers and bodies, without late network calls", async () => {
  let release, calls = 0
  await assert.rejects(fetchUsage(null, options({ timeoutMs: 25, readToken: () => new Promise(r => { release = r }),
    fetch: async () => { calls++; return Response.json(load()) },
  })), /timed out/)
  release("late-token")
  await new Promise(r => setImmediate(r))
  assert.equal(calls, 0)
  let renewalSignal
  await assert.rejects(fetchUsage("fake", options({ timeoutMs: 25, stored, readToken: async () => "",
    renew: async (_, opts) => { renewalSignal = opts.signal; return new Promise(() => {}) },
  })), /timed out/)
  assert.equal(renewalSignal.aborted, true)
  for (const hangingBody of [false, true]) {
    let httpSignal
    await assert.rejects(fetchUsage(null, options({ timeoutMs: 25, fetch: async (_, init) => {
      httpSignal = init.signal
      return hangingBody ? new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) : new Promise(() => {})
    } })), /timed out/)
    assert.equal(httpSignal.aborted, true)
  }
})

test("caller cancellation aborts requests without logging or changing sign-in", async () => {
  const controller = new AbortController()
  let initSignal
  const result = fetchUsage(null, options({ signal: controller.signal, diagnostic: () => assert.fail("cancel should be silent"),
    fetch: async (_, init) => { initSignal = init.signal; controller.abort(); return new Promise(() => {}) },
  }))
  await assert.rejects(result, /cancelled/)
  assert.equal(initSignal.aborted, true)
})

test("endpoint timeout falls back rather than hanging forever", async () => {
  const result = await fetchQuotaSummary("fake", { requestTimeoutMs: 15, fetch: async url => {
    if (url.endsWith(":loadCodeAssist")) return Response.json(load())
    if (url.includes("daily-")) return new Promise(() => {})
    return Response.json({ groups: [group()] })
  } })
  assert.equal(result.groups.length, 1)
})

test("refreshes share only in-flight work; plan failure omits stale plan and keeps cached-account project", async () => {
  let failPlan = false, calls = 0
  const read = createUsageReader(() => null, options({ signIn: async () => stored, fetch: async url => {
    calls++
    if (url.endsWith(":loadCodeAssist")) return failPlan ? new Response("failed", { status: 503 }) : Response.json(load())
    return Response.json({ groups: [group()] })
  } }))
  const [a, b] = await Promise.all([read(), read()])
  assert.equal(calls, 2)
  a.windows[0].used = 99
  assert.equal(b.windows[0].used, 25)
  failPlan = true
  const result = await read()
  assert.equal(result.plan, undefined)
  assert.equal(result.windows[0].used, 25)
  assert.equal(result.error, undefined)
  failPlan = false
  assert.equal((await read()).plan, "Google AI Pro")
})

test("credential replacement cannot reuse another login's project or plan", async () => {
  let token = "access-a"
  const read = createUsageReader(() => null, options({ signIn: async () => ({ ...stored, fp: token }),
    readToken: async () => token, fetch: async url => {
      if (token === "access-b") return new Response("project unavailable", { status: 503 })
      return Response.json(url.endsWith(":loadCodeAssist") ? load() : { groups: [group()] })
    },
  }))
  assert.equal((await read()).plan, "Google AI Pro")
  token = "access-b"
  const result = await read()
  assert.ok(result.error)
  assert.deepEqual(result.windows, [])
  assert.equal(result.plan, undefined)
})

test("credential replacement during an in-flight query starts its own request", async () => {
  let identity = "a", release, entered
  const started = new Promise(resolve => { entered = resolve })
  const read = createUsageReader(() => "/same/agy", options({
    signIn: async () => ({ ...stored, fp: identity }), readToken: async () => `access-${identity}`,
    fetch: async (url, init) => {
      const a = init.headers.Authorization === "Bearer access-a"
      if (url.endsWith(":loadCodeAssist")) return Response.json(load(a ? "project-a" : "project-b", a ? "Plan A" : "Plan B"))
      if (a) { entered(); await new Promise(r => { release = r }) }
      return Response.json({ groups: [group()] })
    },
  }))
  const first = read()
  await started
  identity = "b"
  const second = read()
  // Release A after B has had an opportunity to join the existing pending job.
  await new Promise(r => setImmediate(r))
  release()
  assert.equal((await first).plan, "Plan A")
  assert.equal((await second).plan, "Plan B")
})

test("project lookup retains the eligibility reason if a later endpoint is unavailable", async () => {
  await assert.rejects(fetchUsage(null, options({ fetch: async url => url.includes("daily-")
    ? Response.json({ error: { message: "not available in your location" } }, { status: 403 })
    : new Response("upstream unavailable", { status: 503 }),
  })), error => /your location/.test(error.detail))
})

test("raw HTTP eligibility errors are redacted in UI/logs and repeated failures back off", async () => {
  const lines = []
  let clock = 0, calls = 0
  const read = createUsageReader(() => null, options({ signIn: async () => stored, now: () => clock,
    diagnostic: line => lines.push(line), fetch: async () => {
      calls++
      return Response.json({ error: { code: 403, message: "not available in your location: fake-access-a person@example.com" }, refresh_token: "private-refresh" }, { status: 403 })
    },
  }))
  const first = await read()
  assert.equal(first.signIn, "kept")
  assert.match(first.error, /HTTP error \(redacted\)/)
  assert.match(first.error, /not available in your location/)
  assert.doesNotMatch(first.error + lines.join(""), /fake-access-a|person@example.com|private-refresh/)
  assert.equal(lines.length, 1)
  const count = calls
  assert.deepEqual(await read(), first)
  assert.equal(calls, count)
  clock += 10 * 60 * 1000
  await read()
  assert.equal(lines.length, 2)
})

test("real named token files and native stores supply only their own access token and remain unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-http-quota-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const name of ["a", "b"]) {
    const dir = path.join(root, name)
    const file = path.join(dir, "antigravity-cli", "antigravity-oauth-token")
    await fs.mkdir(path.dirname(file), { recursive: true })
    const raw = JSON.stringify({ token: { access_token: `access-${name}`, refresh_token: "never-send", expiry: "2099-01-01T00:00:00Z" } })
    await fs.writeFile(file, raw)
    assert.equal((await readStoredSignIn({ geminiDir: dir, env: {} })).state, "present")
    const result = await fetchUsage(null, options({ env: {}, geminiDir: dir, readToken: readAccessToken, fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer access-${name}`)
      return Response.json(url.endsWith(":loadCodeAssist") ? load(`project-${name}`, name) : { groups: [group()] })
    } }))
    assert.equal(result.plan, name)
    assert.equal(await fs.readFile(file, "utf8"), raw)
  }
  forgetStoredSignIn({ dead: true })
})
