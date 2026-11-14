// Metadata only. Endpoint order and grouped quota schema follow CLIProxyAPI's
// management center. Chat and OAuth token renewal remain owned by agy CLI.
import { planOf } from "./plan.mjs"

const DAILY = "https://daily-cloudcode-pa.googleapis.com"
const PROD = "https://cloudcode-pa.googleapis.com"
const QUOTA_HOSTS = [DAILY, "https://daily-cloudcode-pa.sandbox.googleapis.com", PROD]
const USER_AGENT = `antigravity/hub/2.23.0 ${process.platform}/${process.arch}`
const text = value => typeof value === "string" ? value.trim() : ""

export class QuotaHttpError extends Error {
  constructor(message, { status = 0, output = "", stage = "http" } = {}) {
    super(message)
    Object.assign(this, { status, output, stage })
  }
}

// Bound both headers and body reads, even if a fetch implementation ignores
// abort. Never forward credentials across redirects or include request data
// in diagnostics. Only callers' redaction boundary may expose response errors.
async function post(host, method, body, token, { fetch: request, signal, requestTimeoutMs }) {
  const controller = new AbortController()
  let timer, stop
  const stopped = new Promise((_, reject) => {
    stop = () => {
      controller.abort()
      reject(new QuotaHttpError(`Antigravity ${method} request was cancelled or timed out.`, { stage: method }))
    }
  })
  signal?.addEventListener("abort", stop, { once: true })
  timer = setTimeout(stop, requestTimeoutMs)
  const query = async () => {
    if (signal?.aborted || controller.signal.aborted) { stop(); return }
    const response = await request(`${host}/v1internal:${method}`, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
    })
    const reader = response.body?.getReader()
    if (!reader) throw new QuotaHttpError(`Antigravity ${method} returned an empty response.`, { stage: method, status: response.status })
    let size = 0
    const chunks = []
    try {
      while (true) {
        if (controller.signal.aborted) throw new QuotaHttpError("Antigravity metadata request timed out.", { stage: method })
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 1024 * 1024) {
          void reader.cancel().catch(() => {})
          throw new QuotaHttpError(`Antigravity ${method} response exceeded the size limit.`, { stage: method })
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    const raw = Buffer.concat(chunks).toString("utf8")
    if (!response.ok) throw new QuotaHttpError(`Antigravity ${method} failed (HTTP ${response.status}).`, {
      status: response.status, output: raw, stage: method,
    })
    try { return JSON.parse(raw) }
    catch { throw new QuotaHttpError(`Antigravity ${method} returned invalid JSON.`, { stage: method }) }
  }
  try { return await Promise.race([query(), stopped]) }
  catch (error) {
    if (error instanceof QuotaHttpError) throw error
    throw new QuotaHttpError(`Antigravity ${method} failed on a network request. Check network or proxy settings.`, { stage: method })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    controller.abort()
  }
}

const projectOf = load => {
  const p = load?.cloudaicompanionProject ?? load?.cloudaicompanion_project
  return text(typeof p === "object" ? p?.id : p)
}
const groupName = group => text(group?.displayName ?? group?.display_name ?? group?.name)
const bucketId = bucket => text(bucket?.bucketId ?? bucket?.bucket_id ?? bucket?.id)
const measured = bucket => {
  const n = bucket?.remainingFraction ?? bucket?.remaining_fraction
  return bucket?.disabled !== true && typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1
}

// Merge real buckets only. A partial daily summary must not hide Gemini on
// production. Retain narrow/unknown groups for conservative routing downstream.
function mergeGroups(target, groups) {
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue
    const name = groupName(group)
    const key = name.toLowerCase().replace(/\s+/g, " ") || "quota"
    let stored = target.get(key)
    if (!stored) {
      stored = { ...group, buckets: [] }
      target.set(key, stored)
    }
    const ids = new Map(stored.buckets.map((b, i) => [bucketId(b), i]))
    for (const bucket of group.buckets) {
      const id = bucketId(bucket)
      if (!id) continue
      if (!ids.has(id)) { ids.set(id, stored.buckets.length); stored.buckets.push(bucket) }
      else {
        const i = ids.get(id)
        if (stored.buckets[i].disabled !== true && !measured(stored.buckets[i]) && measured(bucket)) stored.buckets[i] = bucket
      }
    }
  }
}

export async function fetchQuotaSummary(token, {
  fetch: request = fetch, signal, project: projectHint = "", requestTimeoutMs = 4000,
} = {}) {
  const options = { fetch: request, signal, requestTimeoutMs }
  let project = projectHint, plan = "", loadError
  for (const host of [DAILY, PROD]) {
    if (signal?.aborted) throw new QuotaHttpError("Antigravity metadata query was cancelled.")
    try {
      const load = await post(host, "loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }, token, options)
      plan = planOf(load)
      project = projectOf(load) || project
      if (project) break
      const reason = (Array.isArray(load?.ineligibleTiers) ? load.ineligibleTiers : []).map(t => text(t?.reasonMessage)).filter(Boolean).join("; ")
      if (!loadError || reason) loadError = new QuotaHttpError("Antigravity returned no account project. Sign in with agy to check account eligibility.", { stage: "loadCodeAssist", output: reason })
    } catch (error) {
      if (!loadError || error.status === 403 || error.status === 404) loadError = error
      if (error.status === 401) throw error
    }
  }
  if (!project) throw loadError || new QuotaHttpError("Antigravity returned no account project.")
  const merged = new Map()
  let quotaError
  for (const host of QUOTA_HOSTS) {
    if (signal?.aborted) throw new QuotaHttpError("Antigravity metadata query was cancelled.")
    try {
      const summary = await post(host, "retrieveUserQuotaSummary", { project }, token, options)
      if (!Array.isArray(summary?.groups)) throw new QuotaHttpError("Antigravity returned an invalid quota summary.", { stage: "retrieveUserQuotaSummary" })
      mergeGroups(merged, summary.groups)
      const hasGemini = [...merged.values()].some(g => g.buckets.some(b => bucketId(b).toLowerCase().startsWith("gemini-") && measured(b)))
      if (hasGemini) break
    } catch (error) {
      if (error.status === 401) throw error
      // Preserve a useful denial rather than a later transport failure.
      if (!quotaError || error.status === 403 || error.status === 404) quotaError = error
    }
  }
  const groups = [...merged.values()]
  if (!groups.some(g => g.buckets.length)) throw quotaError || new QuotaHttpError("Limits not available: Antigravity returned no quota buckets.")
  return { groups, project, plan }
}
