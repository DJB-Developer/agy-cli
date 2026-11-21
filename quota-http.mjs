// HTTP metadata follows T3 Code's summary/model endpoints (MIT; see NOTICE.md).
// agy remains the only token writer and the only chat transport.
import { readAccessToken, readStoredSignIn } from "./signin.mjs"
import { fetchAccountPlan } from "./plan.mjs"
import { sanitizeUsageDiagnostic } from "./usage.mjs"
import { isServiceSuspension } from "./service-status.mjs"

const HOSTS = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"]
const MAX_BODY = 1024 * 1024
const text = value => typeof value === "string" ? value.trim() : ""
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake]
const normalize = value => text(value).toLowerCase().replace(/[\s._]+/g, "-").replace(/-models$/, "")
const fraction = quota => field(quota, "remainingFraction", "remaining_fraction")
const known = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
const used = value => Math.round((1 - value) * 1e8) / 1e6
const modelList = models => [...new Set((Array.isArray(models) ? models : []).filter(id => typeof id === "string" && id))]
const baseModel = id => id.replace(/-(?:high|medium|low|minimal|extra|max|tiered|xhigh)$/, "")
const unavailable = error => ({ windows: [], error, signIn: "kept" })

function resetTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}
function quotaFields(quota, { span, now = Date.now(), summary = false } = {}) {
  const remaining = fraction(quota)
  let resetsAt = resetTime(field(quota, "resetTime", "reset_time"))
  // Untouched summary buckets have a moving full-window date, not a real reset.
  if (summary && remaining === 1 && !quota.description && span && resetsAt &&
      Math.abs(Date.parse(resetsAt) - now - span * 1000) <= 60_000) resetsAt = undefined
  return {
    ...(known(remaining) ? { used: used(remaining) } : { display: "Limits not available" }),
    ...(span ? { span } : {}), ...(resetsAt ? { resetsAt } : {}),
  }
}
function summaryEntries(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return []
  const groups = Array.isArray(response.groups) && response.groups.some(g => Array.isArray(g?.buckets) && g.buckets.length)
    ? response.groups : [{ buckets: response.buckets }]
  const entries = []
  for (const group of groups) for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
    const id = text(field(bucket, "bucketId", "bucket_id")) || text(bucket?.id)
    if (!id) continue
    let name = text(field(group, "displayName", "display_name")) || text(group.name)
    if (!name) name = /^gemini-argon-/.test(id) ? "Gemini Argon" : /^gemini-carbon-/.test(id) ? "Gemini Carbon"
      : /^gemini-/.test(id) ? "Gemini" : /^3p-/.test(id) ? "Claude and GPT" : id
    entries.push({ id, name, bucket })
  }
  return entries
}
function groupScore(name, id) {
  name = normalize(name).replace(/-and-/, "-&-")
  id = normalize(id)
  if (name === "gemini") return /^gemini-(?:\d+(?:-\d+)*-)?(?:flash|pro)(?:-|$)/.test(id) ? 1 : 0
  if (["claude-&-gpt", "claude-&-gpt-(shared)"].includes(name)) return /^(?:claude|gpt)-/.test(id) ? 1 : 0
  if (["gemini-argon", "gemini-carbon"].includes(name)) {
    return new RegExp(`^gemini-(?:\\d+(?:-\\d+)*-)?${name.slice(7)}(?:-|$)`).test(id) ? 2 : 0
  }
  if (["claude", "gpt"].includes(name)) return id.startsWith(name + "-") ? 2 : 0
  if (!/^(gemini|claude|gpt)-[a-z0-9]/.test(name)) return 0
  return id === name || id.startsWith(name + "-") ? name.length : 0
}

export function parseQuotaSummary(response, { models = [], now = Date.now() } = {}) {
  const entries = summaryEntries(response)
  const ids = modelList(models)
  const windows = []
  for (const { id, name, bucket } of entries) {
    if (bucket.disabled === true) continue
    const scoped = ids.filter(model => {
      const score = groupScore(name, model)
      return score > 0 && score === Math.max(...entries.map(e => groupScore(e.name, model)))
    })
    const cadence = text(bucket.window)
    const span = cadence === "5h" ? 18000 : cadence === "weekly" ? 604800 : undefined
    const fields = quotaFields(bucket, { span, now, summary: true })
    const measured = fields.used !== undefined
    windows.push({ name: `${name.replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")} · ${span === 18000 ? "5 hours" : span === 604800 ? "7 days" : text(bucket.displayName) || cadence || id}`,
      aside: !measured || !scoped.length, ...(measured && scoped.length ? { models: scoped } : {}), ...fields })
  }
  return { windows }
}

export function parseModelQuota(response, { models = [] } = {}) {
  if (!response?.models || typeof response.models !== "object" || Array.isArray(response.models)) return { windows: [] }
  const sources = Object.entries(response.models).filter(([, value]) => value && typeof value === "object" && value.disabled !== true)
  const windows = []
  const catalog = modelList(models)
  const quotaOf = (model, key) => model[key] ?? model[key === "quotaInfo" ? "quota_info" : "weekly_quota_info"]
  for (const id of catalog) {
    // A base alias can select any effort; retain each variant's constraint.
    // A specific effort only borrows an explicitly reported base-model quota.
    const exact = sources.filter(([key]) => key === id)
    // Presence is ownership even if disabled, malformed, or quota-less. Do not
    // turn an explicitly unavailable effort into a healthy one via its base.
    const borrowingVariants = !Object.hasOwn(response.models, id) && id === baseModel(id)
    const variants = borrowingVariants ? catalog.filter(other => other !== id && baseModel(other) === id) : []
    const matches = Object.hasOwn(response.models, id) ? exact : borrowingVariants
      ? sources.filter(([key]) => variants.includes(key)) : sources.filter(([key]) => key === baseModel(id))
    // A base alias can select any advertised effort. Missing/disabled variants
    // or a partially reported cadence leave that alias unknown, not healthy.
    if (borrowingVariants && (!variants.length || matches.length !== variants.length)) continue
    for (const [sourceId, model] of matches) for (const [key, span] of [["quotaInfo", undefined], ["weeklyQuotaInfo", 604800]]) {
      if (borrowingVariants && !matches.every(([, other]) => {
        const quota = quotaOf(other, key)
        return quota && quota.disabled !== true && known(fraction(quota))
      })) continue
      const quota = quotaOf(model, key)
      if (!quota || quota.disabled === true) continue
      const fields = quotaFields(quota, { span })
      const measured = fields.used !== undefined
      windows.push({ name: `${sourceId} · ${span ? "7 days" : "Reported quota"}`, aside: !measured,
        ...(measured ? { models: [id] } : {}), ...fields })
    }
  }
  return { windows }
}

function abortError() { return new Error("Metadata read cancelled or timed out.") }
function raceSignal(work, signal) {
  if (signal.aborted) { Promise.resolve(work).catch(() => {}); return Promise.reject(abortError()) }
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener("abort", cancel); reject(abortError()) }
    signal.addEventListener("abort", cancel, { once: true })
    Promise.resolve(work).then(value => { signal.removeEventListener("abort", cancel); resolve(value) }, error => {
      signal.removeEventListener("abort", cancel); reject(error)
    })
  })
}
async function requestJson(url, token, { fetch: request, signal, timeoutMs = 5000 }) {
  if (signal.aborted) return { error: "Quota HTTP request cancelled or timed out." }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal.addEventListener("abort", cancel, { once: true })
  if (signal.aborted) controller.abort()
  const timer = setTimeout(cancel, timeoutMs)
  let reader
  try {
    const response = await raceSignal(Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError()
      return request(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}", redirect: "error", signal: controller.signal })
    }).then(response => {
      if (controller.signal.aborted) { response.body?.cancel().catch(() => {}); throw abortError() }
      return response
    }), controller.signal)
    reader = response.body?.getReader()
    const chunks = []
    let size = 0
    if (reader) while (true) {
      const { done, value } = await raceSignal(reader.read(), controller.signal)
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) throw new Error("Metadata body too large.")
      chunks.push(value)
    }
    const body = Buffer.concat(chunks).toString("utf8")
    if (response.status === 403 && isServiceSuspension(body)) return { suspended: true }
    if (!response.ok) return { error: `Quota HTTP ${response.status}. HTTP error (redacted):\n${sanitizeUsageDiagnostic(body)}` }
    try { return { value: JSON.parse(body) } } catch { return { error: "Quota HTTP response was not valid JSON." } }
  } catch {
    return { error: "Quota HTTP request failed or timed out. Check network and proxy settings." }
  } finally {
    controller.abort()
    if (reader) { reader.cancel().catch(() => {}); try { reader.releaseLock() } catch {} }
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
  }
}
function mergeSummaries(responses) {
  const seen = new Set(), groups = []
  // Consumer daily endpoint owns an overlapping bucket, even if its reading is unknown.
  for (const response of responses) for (const entry of summaryEntries(response.value)) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    groups.push({ displayName: entry.name, buckets: [entry.bucket] })
  }
  return { groups }
}
function mergeModels(responses) {
  const models = Object.create(null)
  for (const response of responses) for (const [id, model] of Object.entries(response.value?.models || {})) {
    if (!Object.hasOwn(models, id)) models[id] = model
  }
  return { models }
}

export function createHttpUsageReader({
  env = process.env, geminiDir, getModels = () => [], signIn,
  serviceStatus, readToken = readAccessToken, fetch: request = fetch,
  now = Date.now, timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
} = {}) {
  const credentials = { env, ...(geminiDir ? { geminiDir } : {}) }
  const readSignIn = signIn || (() => readStoredSignIn({ ...credentials, now: now() }))
  const totalBudget = Math.min(15000, Math.max(1, Number(timeoutMs) || 15000))
  const fenceBudget = Math.min(3000, Math.max(1, totalBudget / 5))
  const budget = Math.max(1, totalBudget - fenceBudget)
  let generation = 0, clearEpoch = 0, nextRead = 0, lastAdmitted = 0, currentKey, pending, disposed = false
  const controllers = new Set()
  const changed = () => unavailable("Account credentials changed while reading metadata. Refresh limits again.")
  const keyOf = stored => `${stored?.state || "unknown"}:${stored?.fp || ""}`
  const read = async () => {
    if (disposed) return unavailable("Metadata reader is stopped.")
    if (serviceStatus?.get()) return serviceStatus.usage()
    const controller = new AbortController()
    controllers.add(controller)
    const finishPrepare = () => { clearTimeout(timer); controllers.delete(controller); controller.abort() }
    const timer = setTimeout(() => controller.abort(), budget)
    const prepEpoch = clearEpoch
    const order = ++nextRead
    let stored
    try { stored = await raceSignal(Promise.resolve().then(readSignIn), controller.signal) }
    catch { finishPrepare(); return unavailable("Could not read CLI credentials for metadata. Chat authentication is unchanged.") }
    if (disposed || prepEpoch !== clearEpoch) { finishPrepare(); return changed() }
    const key = keyOf(stored)
    if (order < lastAdmitted && key !== currentKey) { finishPrepare(); return changed() }
    lastAdmitted = Math.max(lastAdmitted, order)
    if (pending?.key === key) { finishPrepare(); return structuredClone(await pending.promise) }
    if (currentKey !== key) {
      generation++
      pending?.controller.abort()
      currentKey = key
    }
    const gen = generation
    const entry = { key, controller }
    entry.promise = (async () => {
      const token = await raceSignal(Promise.resolve().then(() => readToken({ ...credentials, now: now() })), controller.signal)
      const stillSame = async (final = false) => {
        if (disposed || generation !== gen) return false
        // Reserve up to 3s after HTTP's deadline for an identity fence. A
        // quota timeout must not discard a fast successful plan, nor commit an
        // old account's result after credentials changed during the request.
        const check = final ? new AbortController() : controller
        const checkTimer = final ? setTimeout(() => check.abort(), fenceBudget) : null
        if (final) controllers.add(check)
        try { return keyOf(await raceSignal(Promise.resolve().then(readSignIn), check.signal)) === key && !disposed && generation === gen }
        finally { if (final) { clearTimeout(checkTimer); controllers.delete(check); check.abort() } }
      }
      if (!(await stillSame())) return changed()
      if (!token || stored?.expired || stored?.expiresAt > 0 && stored.expiresAt <= now() + 60000) {
        return unavailable("Quota and plan need a valid CLI access token. Start a normal agy conversation or sign in through agy, then refresh limits. No background prompt or OAuth refresh was sent.")
      }
      let suspended = false
      const planPromise = fetchAccountPlan({ ...credentials, signal: controller.signal, readToken: async () => token,
        fetch: request, onServiceSuspended: () => { suspended = true } })
      const options = { fetch: request, signal: controller.signal }
      const summaries = await Promise.all(HOSTS.map(host => requestJson(`${host}/v1internal:retrieveUserQuotaSummary`, token, options)))
      suspended ||= summaries.some(result => result.suspended)
      const models = modelList(getModels())
      const mergedSummary = mergeSummaries(summaries)
      let windows = parseQuotaSummary(mergedSummary, { models, now: now() }).windows
      // Explicit unknown/disabled groups retain ownership. A missing group may
      // use exact per-model readings; a declared group must not be bypassed.
      const declared = summaryEntries(mergedSummary)
      const uncovered = models.filter(id => !declared.some(entry => groupScore(entry.name, id) > 0))
      let supplemental = []
      if (!suspended && !controller.signal.aborted && uncovered.length) {
        supplemental = await Promise.all(HOSTS.map(host => requestJson(`${host}/v1internal:fetchAvailableModels`, token, options)))
        suspended ||= supplemental.some(result => result.suspended)
        windows.push(...parseModelQuota(mergeModels(supplemental), { models: uncovered }).windows)
      }
      const plan = await planPromise
      if (!(await stillSame(true))) return changed()
      if (suspended) {
        serviceStatus?.mark()
        return serviceStatus?.usage() || { windows: [], error: "Antigravity account disabled (403 / TOS_VIOLATION).", signIn: "expired" }
      }
      if (serviceStatus?.get()) return serviceStatus.usage()
      const result = { windows, ...(plan ? { plan } : {}), signIn: "kept" }
      if (!windows.some(w => w.used !== undefined)) {
        result.error = [...summaries, ...supplemental].find(r => r.error)?.error || "Antigravity returned no usable HTTP quota information. Chat authentication is unchanged."
      }
      return result
    })().catch(() => unavailable("Could not read HTTP metadata. Chat authentication is unchanged; check network and refresh limits."))
      .finally(() => { finishPrepare(); if (pending === entry) pending = undefined })
    pending = entry
    return structuredClone(await entry.promise)
  }
  read.clear = () => { clearEpoch++; generation++; for (const controller of controllers) controller.abort(); pending = undefined; currentKey = undefined }
  read.dispose = () => { disposed = true; read.clear() }
  return read
}
