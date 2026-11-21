import assert from "node:assert/strict"
import { test } from "node:test"
import { createHttpUsageReader, parseQuotaSummary, parseModelQuota } from "../quota-http.mjs"

const models = ["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-4-argon", "gemini-4-carbon", "claude-sonnet-5-5", "gpt-oss-120b"]
const summary = { groups: [
  { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75 }, { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.25 }] },
  { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 0 }] },
] }
const tos = { error: { code: 403, status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TOS_VIOLATION" }] } }
const status = () => { let marked = false; return { get: () => marked, mark: () => { marked = true }, usage: () => ({ windows: [], error: "403 / TOS_VIOLATION", signIn: "expired" }) } }
const setup = (extra = {}) => createHttpUsageReader({
  signIn: async () => ({ state: "present", fp: "a", canRenew: true }), readToken: async () => "access-a",
  getModels: () => models, fetch: async url => Response.json(url.endsWith("loadCodeAssist") ? { paidTier: { id: "g1-pro-tier" } } : url.endsWith("fetchAvailableModels") ? { models: {} } : summary),
  ...extra,
})

test("HTTP summary scopes shared groups and both windows without borrowing Argon/Carbon quota", () => {
  const result = parseQuotaSummary(summary, { models })
  assert.deepEqual(result.windows.map(w => w.used), [25, 75, 100])
  assert.deepEqual(result.windows.map(w => w.models), [models.slice(0, 2), models.slice(0, 2), models.slice(4)])
  assert.deepEqual(result.windows.map(w => w.span), [18000, 604800, 604800])
})

test("HTTP metadata reads selected token only, merges hosts, queries plan and supplements missing models", async () => {
  const calls = []
  const read = setup({ fetch: async (url, init) => {
    calls.push(url)
    assert.equal(init.headers.Authorization, "Bearer access-a")
    assert.equal(init.headers["User-Agent"], undefined)
    assert.equal(init.redirect, "error")
    assert.doesNotMatch(init.body, /token|prompt|message/)
    if (url.endsWith("loadCodeAssist")) return Response.json({ paidTier: { id: "g1-ultra-tier" } })
    if (url.endsWith("fetchAvailableModels")) return Response.json({ models: { "gemini-4-argon": { quotaInfo: { remainingFraction: 0.6 } } } })
    return Response.json(summary)
  } })
  const result = await read()
  assert.equal(result.plan, "Google AI Ultra")
  assert.equal(result.signIn, "kept")
  assert.equal(result.windows.length, 4)
  assert.deepEqual(result.windows.at(-1).models, ["gemini-4-argon"])
  assert.equal(calls.length, 5)
  assert.ok(calls.every(url => /https:\/\/(?:daily-)?cloudcode-pa.googleapis.com\/v1internal:/.test(url)))
})

test("flat HTTP buckets identify separate Argon and Carbon pools; unknown/disabled groups cannot cap everything", () => {
  const result = parseQuotaSummary({ buckets: [
    { bucketId: "gemini-argon-weekly", window: "weekly", remainingFraction: 0.6 },
    { bucketId: "gemini-carbon-weekly", window: "weekly", remainingFraction: 0 },
    { bucketId: "other-weekly", window: "weekly", remainingFraction: 0 },
    { bucketId: "gemini-weekly", window: "weekly", remainingFraction: null },
    { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0, disabled: true },
  ] }, { models })
  assert.deepEqual(result.windows.slice(0, 2).map(w => w.models), [[models[2]], [models[3]]])
  assert.equal(result.windows[2].aside, true)
  assert.equal(result.windows[2].models, undefined)
  assert.equal(result.windows[3].used, undefined)
  assert.equal(result.windows.length, 4)
})

test("per-model fallback preserves independent models and variants instead of family worst-case pooling", () => {
  const result = parseModelQuota({ models: {
    "gemini-3.8-flash-high": { quotaInfo: { remainingFraction: 0 } },
    "gemini-3.8-flash-low": { quotaInfo: { remainingFraction: 0.7 } },
    "gemini-4-argon": { weeklyQuotaInfo: { remainingFraction: 0.6 } },
  } }, { models: [...models, "gemini-3.8-flash-low"] })
  assert.deepEqual(result.windows.filter(w => w.models.includes("gemini-3.8-flash")).map(w => w.used), [100, 30])
  assert.deepEqual(result.windows.filter(w => w.models.includes("gemini-3.8-flash-high")).map(w => w.used), [100])
  assert.deepEqual(result.windows.filter(w => w.models.includes("gemini-3.8-flash-low")).map(w => w.used), [30])
  assert.equal(result.windows.find(w => w.models.includes("gemini-4-argon")).span, 604800)
  assert.equal(result.windows.find(w => w.models.includes("gemini-3.8-flash")).span, undefined)
})

test("unknown and out-of-range fractions are not invented allowances; untouched resets aren't real dates", () => {
  const at = Date.parse("2026-11-21T00:00:00Z")
  const result = parseQuotaSummary({ buckets: [
    { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, resetTime: "2026-11-21T05:00:00Z" },
    ...[null, "0.5", -1, 2, true].map((value, i) => ({ bucketId: `unknown-${i}`, remainingFraction: value })),
  ] }, { models, now: at })
  assert.equal(result.windows[0].resetsAt, undefined)
  assert.equal(result.windows[0].used, 0)
  assert.ok(result.windows.slice(1).every(w => w.aside && w.used === undefined && !w.models))
})

test("concurrent reads coalesce; a later manual refresh is fresh and response mutations don't leak", async () => {
  let release, entered, calls = 0
  const blocked = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const read = setup({ getModels: () => models.slice(0, 2), fetch: async url => {
    calls++
    entered()
    await gate
    return Response.json(url.endsWith("loadCodeAssist") ? {} : summary)
  } })
  const first = read()
  await blocked
  const second = read()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 3)
  assert.equal(a.error, undefined)
  a.windows[0].used = 999
  assert.equal(b.windows[0].used, 25)
  await read()
  assert.equal(calls, 6)
})

test("daily summary wins duplicate buckets; other host can supply missing buckets", async () => {
  const read = setup({ getModels: () => models.slice(0, 2), fetch: async url => {
    if (url.endsWith("loadCodeAssist")) return Response.json({})
    return Response.json({ buckets: url.includes("daily-") ? [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 },
    ] : [
      { bucketId: "gemini-5h", window: "5h", remainingFraction: 0 },
      { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5 },
    ] })
  } })
  assert.deepEqual((await read()).windows.map(w => w.used), [20, 50])
})

for (const statusCode of [401, 403, 429, 500]) test(`HTTP ${statusCode} is metadata failure, not dead CLI credentials or a ban`, async () => {
  const service = status()
  const read = setup({ serviceStatus: service, fetch: async url => url.endsWith("loadCodeAssist")
    ? Response.json({ paidTier: { id: "g1-pro-tier" } })
    : new Response("private token=ya29.secret and user@example.com", { status: statusCode }) })
  const result = await read()
  assert.equal(result.signIn, "kept")
  assert.equal(result.plan, "Google AI Pro")
  assert.equal(service.get(), false)
  assert.match(result.error, new RegExp(`HTTP ${statusCode}`))
  assert.doesNotMatch(result.error, /ya29\.secret|user@example.com/)
})

test("missing or expiring tokens send no HTTP, leave authentication alone and recover on next refresh", async () => {
  let token = "", exp = 0, calls = 0
  const read = setup({ now: () => 100000, signIn: async () => ({ state: "present", fp: token, canRenew: true, expiresAt: exp }),
    readToken: async () => token,
    fetch: async url => { calls++; return Response.json(url.endsWith("loadCodeAssist") ? {} : summary) },
  })
  assert.equal((await read()).signIn, "kept")
  assert.equal(calls, 0)
  token = "fresh"; exp = 130000
  assert.match((await read()).error, /access token/)
  assert.equal(calls, 0)
  exp = 1000000
  assert.equal((await read()).error, undefined)
  assert.ok(calls > 0)
})

test("explicit TOS on either quota host wins over successful quota/plan", async () => {
  for (const target of ["daily", "prod", "plan", "models"]) {
    const service = status()
    const read = setup({ serviceStatus: service, fetch: async url => {
      if ((target === "plan" && url.endsWith("loadCodeAssist")) ||
          (target === "models" && url.endsWith("fetchAvailableModels")) ||
          (target === "daily" && url.includes("daily-") && url.endsWith("retrieveUserQuotaSummary")) ||
          (target === "prod" && !url.includes("daily-") && url.endsWith("retrieveUserQuotaSummary"))) return Response.json(tos, { status: 403 })
      return Response.json(url.endsWith("loadCodeAssist") ? { paidTier: { id: "g1-pro-tier" } } : summary)
    } })
    const result = await read()
    assert.equal(service.get(), true, target)
    assert.match(result.error, /TOS_VIOLATION/)
    assert.deepEqual(result.windows, [])
    assert.equal(result.plan, undefined)
  }
})

test("credential changes discard old quota, plan and explicit ban even before another read starts", async () => {
  let fp = "old", release, enter
  const ready = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const service = status()
  const read = setup({ serviceStatus: service, signIn: async () => ({ state: "present", fp, canRenew: true }),
    fetch: async () => { enter(); await gate; return Response.json(tos, { status: 403 }) },
  })
  const pending = read()
  await ready
  fp = "new"
  release()
  const result = await pending
  assert.match(result.error, /credentials changed/)
  assert.equal(result.signIn, "kept")
  assert.equal(service.get(), false)
})

test("a new credential cannot join an old in-flight request or receive its late results", async () => {
  let fp = "old", release, enter
  const ready = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const read = setup({ signIn: async () => ({ state: "present", fp, canRenew: true }), readToken: async () => fp,
    fetch: async (url, init) => {
      if (init.headers.Authorization === "Bearer old") { enter(); await gate; return Response.json(tos, { status: 403 }) }
      return Response.json(url.endsWith("loadCodeAssist") ? { paidTier: { name: "New plan" } } : summary)
    },
  })
  const old = read()
  await ready
  fp = "new"
  const next = await read()
  assert.equal(next.plan, "New plan")
  assert.equal(next.error, undefined)
  release()
  assert.equal((await old).signIn, "kept")
})

test("disposal aborts work and ignores late TOS while keeping another reader independent", async () => {
  let release, enter, requestSignal
  const ready = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const service = status()
  const read = setup({ serviceStatus: service, fetch: async (_url, init) => { requestSignal = init.signal; enter(); await gate; return Response.json(tos, { status: 403 }) } })
  const active = read()
  await ready
  read.dispose()
  assert.equal((await active).signIn, "kept")
  assert.equal(requestSignal.aborted, true)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.get(), false)
  assert.match((await read()).error, /stopped/)
  assert.equal((await setup()()).error, undefined)
})

test("total deadline bounds hung credential, HTTP, and body reads without a late suspension", async () => {
  for (const phase of ["signin", "token", "fetch", "body"]) {
    let signal, release
    const service = status()
    const opts = { timeoutMs: 20, serviceStatus: service }
    if (phase === "signin") opts.signIn = () => new Promise(() => {})
    if (phase === "token") opts.readToken = () => new Promise(() => {})
    if (["fetch", "body"].includes(phase)) opts.fetch = async (_url, init) => {
      signal = init.signal
      if (phase === "fetch") return new Promise(resolve => { release = () => resolve(Response.json(tos, { status: 403 })) })
      return new Response(new ReadableStream({ start(controller) {
        release = () => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify(tos))); controller.close() } catch {} }
      } }), { status: 403 })
    }
    const started = Date.now()
    const result = await setup(opts)()
    assert.ok(Date.now() - started < 1000)
    assert.equal(result.signIn, "kept")
    assert.match(result.error, /metadata|credentials|HTTP/i)
    if (signal) assert.equal(signal.aborted, true)
    release?.()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(service.get(), false)
  }
})

test("oversized and malformed quota responses never expose body or mark suspension", async () => {
  for (const body of ["invalid JSON", JSON.stringify(tos) + "x".repeat(1024 * 1024)]) {
    const service = status()
    const read = setup({ serviceStatus: service, fetch: async url => url.endsWith("loadCodeAssist") ? Response.json({}) : new Response(body) })
    const result = await read()
    assert.equal(result.signIn, "kept")
    assert.equal(service.get(), false)
    assert.match(result.error, /JSON|failed/)
    assert.ok(result.error.length < 500)
  }
})

test("quota deadline retains a successful plan and does not start fallback requests after cancellation", async () => {
  const calls = []
  const read = setup({ timeoutMs: 20, fetch: async url => {
    calls.push(url)
    if (url.endsWith("loadCodeAssist")) return Response.json({ paidTier: { id: "g1-pro-tier" } })
    return new Promise(() => {})
  } })
  const result = await read()
  assert.equal(result.plan, "Google AI Pro")
  assert.equal(result.signIn, "kept")
  assert.match(result.error, /timed out/)
  assert.equal(calls.length, 3)
})

test("disposal and clearing bound preflight credential reads and cannot launch late HTTP", async () => {
  for (const action of ["dispose", "clear"]) {
    let release, calls = 0
    const read = setup({ signIn: () => new Promise(resolve => { release = resolve }),
      fetch: async () => { calls++; return Response.json(summary) },
    })
    const result = read()
    await new Promise(resolve => setImmediate(resolve))
    read[action]()
    assert.equal((await result).signIn, "kept")
    release({ state: "present", fp: "a", canRenew: true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 0)
  }
})

test("a declared unknown or disabled specialized summary pool cannot be bypassed by fallback", async () => {
  for (const disabled of [false, true]) {
    let modelRequests = 0
    const read = setup({ getModels: () => models.slice(0, 2), fetch: async url => {
      if (url.endsWith("loadCodeAssist")) return Response.json({})
      if (url.endsWith("fetchAvailableModels")) { modelRequests++; return Response.json({ models: { "gemini-3.8-flash": { quotaInfo: { remainingFraction: 1 } } } }) }
      return Response.json({ groups: [
        { displayName: "Gemini", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 1, window: "weekly" }] },
        { displayName: "Gemini 3.8 Flash", buckets: [{ bucketId: "flash-special", remainingFraction: null, disabled }] },
      ] })
    } })
    const result = await read()
    assert.ok(result.windows.every(w => w.aside && !w.models))
    assert.equal(modelRequests, 0)
  }
})

test("quota remains available when optional plan rejects, hangs, or returns malformed data", async () => {
  for (const plan of ["reject", "invalid", "http", "hang"]) {
    const read = setup({ timeoutMs: 50, fetch: async url => {
      if (!url.endsWith("loadCodeAssist")) return Response.json(summary)
      if (plan === "hang") return new Promise(() => {})
      if (plan === "reject") throw Error("secret-token")
      if (plan === "invalid") return new Response("not json")
      return new Response("secret-token", { status: 403 })
    } })
    const result = await read()
    assert.equal(result.error, undefined)
    assert.equal(result.plan, undefined)
    assert.ok(result.windows.some(w => w.used === 25))
  }
})


test("stable slow keyring credential reads are not mistaken for an account change", async () => {
  const read = setup({ signIn: async () => {
    await new Promise(resolve => setTimeout(resolve, 300))
    return { state: "present", fp: "stable-keyring", canRenew: true }
  } })
  const result = await read()
  assert.equal(result.error, undefined)
  assert.equal(result.plan, "Google AI Pro")
  assert.ok(result.windows.some(w => w.used === 25))
})


test("explicit disabled or malformed model entries own their aliases and cannot borrow a base quota", () => {
  for (const exact of [null, false, "invalid", {}, { disabled: true, quotaInfo: { remainingFraction: 0 } }]) {
    const source = { models: {
      "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.9 } },
      "gemini-3.8-flash-high": exact,
    } }
    assert.deepEqual(parseModelQuota(source, { models: ["gemini-3.8-flash-high"] }).windows, [])
    source.models["gemini-3.8-flash"] = exact
    source.models["gemini-3.8-flash-high"] = { quotaInfo: { remainingFraction: 0.9 } }
    assert.deepEqual(parseModelQuota(source, { models: ["gemini-3.8-flash"] }).windows, [])
  }
  assert.equal(parseModelQuota({ models: { "gemini-3.8-flash": { quotaInfo: { remainingFraction: 0.9 } } } },
    { models: ["gemini-3.8-flash-high"] }).windows[0].used, 10, "only an absent entry may use a reported base quota")
})


test("a delayed preflight snapshot cannot abort a newer credential's admitted query", async () => {
  let signinReads = 0, releaseOld, enterNew, releaseNew
  const started = new Promise(resolve => { enterNew = resolve })
  const gate = new Promise(resolve => { releaseNew = resolve })
  const read = setup({ signIn: async () => {
    if (++signinReads === 1) return new Promise(resolve => { releaseOld = () => resolve({ state: "present", fp: "old", canRenew: true }) })
    return { state: "present", fp: "new", canRenew: true }
  }, fetch: async url => { enterNew(); await gate; return Response.json(url.endsWith("loadCodeAssist") ? { paidTier: { name: "New plan" } } : summary) } })
  const old = read()
  await new Promise(resolve => setImmediate(resolve))
  const next = read()
  await started
  releaseOld()
  assert.match((await old).error, /credentials changed/)
  releaseNew()
  assert.equal((await next).plan, "New plan")
})

test("base aliases cannot borrow a partial set of exposed effort quotas", () => {
  const base = "gemini-3.8-flash"
  const catalog = [base, `${base}-high`, `${base}-low`]
  for (const high of [undefined, null, {}, { disabled: true, quotaInfo: { remainingFraction: 0.9 } },
    { quotaInfo: { remainingFraction: null } }, { quotaInfo: { remainingFraction: "0.9" } },
    { quotaInfo: { remainingFraction: -1 } }, { quotaInfo: { disabled: true, remainingFraction: 0.9 } }]) {
    const source = { models: { [`${base}-low`]: { quotaInfo: { remainingFraction: 0.9 } },
      ...(high === undefined ? {} : { [`${base}-high`]: high }) } }
    const result = parseModelQuota(source, { models: catalog })
    assert.deepEqual(result.windows.filter(window => window.models?.includes(base)), [], JSON.stringify(high))
    assert.equal(result.windows.find(window => window.models?.includes(`${base}-low`)).used, 10)
  }
  const complete = { models: {
    [`${base}-high`]: { quotaInfo: { remainingFraction: 0 }, weeklyQuotaInfo: { remainingFraction: 0.2 } },
    [`${base}-low`]: { quotaInfo: { remainingFraction: 0.7 } },
  } }
  const windows = parseModelQuota(complete, { models: catalog }).windows.filter(window => window.models?.includes(base))
  assert.deepEqual(windows.map(window => window.used), [100, 30])
  assert.ok(windows.every(window => window.span === undefined), "partial weekly data cannot describe the base alias")
  assert.deepEqual(parseModelQuota(complete, { models: [base] }).windows, [], "do not infer unadvertised variants from HTTP rows")
})
