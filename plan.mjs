import { readAccessToken } from "./signin.mjs"

const PLAN_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"

// Same preference as Antigravity: paid tier's name, current tier's name or ID.
// Don't infer a subscription from quota sizes or from eligible/allowed tiers.
export function planOf(load) {
  const named = value => typeof value === "string" && value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : ""
  return named(load?.paidTier?.name) || named(load?.currentTier?.name) || named(load?.currentTier?.id)
}

// Optional enrichment after CLI /usage has had a chance to renew its token.
// Bound credential reads AND HTTP to 1.5s on top of the CLI's <=18s budget.
// No completed-result cache: a quota refresh also refreshes the account's plan.
export async function fetchAccountPlan({
  signal, timeoutMs = 1500, readToken = readAccessToken, fetch: request = fetch,
  ...credentials
} = {}) {
  if (signal?.aborted) return ""
  const controller = new AbortController()
  let timer
  let stop
  const stopped = new Promise(resolve => { stop = () => { controller.abort(); resolve("") } })
  signal?.addEventListener("abort", stop, { once: true })
  timer = setTimeout(stop, Math.min(1500, Math.max(1, timeoutMs || 1500)))
  const query = async () => {
    const token = await readToken(credentials)
    if (!token || controller.signal.aborted) return ""
    const response = await request(PLAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      redirect: "error",
      signal: controller.signal,
    })
    if (!response.ok) { await response.body?.cancel(); return "" }
    // Bound metadata size; error bodies and credentials never reach logs/UI.
    const reader = response.body?.getReader()
    if (!reader) return ""
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 64 * 1024) { await reader.cancel(); return "" }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return planOf(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  }
  try { return await Promise.race([query().catch(() => ""), stopped]) }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); controller.abort() }
}
