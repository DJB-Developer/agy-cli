// Quota refresh is local status only. Do not query Google internal APIs or
// fall back to CLI /usage, background prompts, or OAuth refreshes.
// See T3 Code PR #43026 (96423cb5e2614eeb7a033cc7b755795d88a9158a).
export function createUsageReader({ serviceStatus, cooldown } = {}) {
  return async () => {
    if (serviceStatus?.get()) return serviceStatus.usage()
    const windows = cooldown?.windows() ?? []
    return {
      windows,
      ...(!windows.length ? { error: "Remaining quota and plan queries are unavailable. Only quota exhaustion observed from real requests is shown; no background probes. Expired observations become unknown, not a full allowance. Per-turn token usage is still reported." } : {}),
      signIn: "kept",
    }
  }
}

// Error observations, not an allowance meter. The scope is the model that
// selected for the failed request (including effort variants), not proof of
// the executed model and never an inferred account-wide pool.
const modelKey = value => String(value || "").replace(/^agy-cli\//, "").replace(/\[1m\]$/i, "")
  .replace(/-(?:minimal|low|medium|high|xhigh|max)$/i, "")

export function createQuotaCooldown({ now = () => Date.now() } = {}) {
  const entries = new Map()
  let identity, generation = 0, revision = 0
  function prune() {
    for (const [key, entry] of entries) if (entry.resetAt && Date.parse(entry.resetAt) <= now()) entries.delete(key)
  }
  return {
    // Legacy CLI sign-in may change outside this plugin. A late result from
    // the previous identity must not cool the new one. Named profiles use dir.
    sync(next) {
      if (identity !== next) { identity = next; entries.clear(); generation++ }
      return generation
    },
    generation: () => generation,
    revision: () => revision,
    succeeded(model, before, ticket = generation) {
      const entry = entries.get(modelKey(model))
      if (ticket === generation && entry && !entry.resetAt && entry.revision <= before) entries.delete(modelKey(model))
    },
    clear() { entries.clear(); generation++ },
    observe(model, aliases, error, ticket = generation) {
      if (ticket !== generation || error?.code !== "QUOTA_EXHAUSTED" || error?.statusCode !== 429) return
      const key = modelKey(model)
      if (!key) return
      prune()
      const at = Date.parse(error.resetAt)
      // No guessed reset and no permanent routing ban for a missing reset.
      const resetAt = Number.isFinite(at) && at > now() ? new Date(at).toISOString() : null
      const old = entries.get(key)
      const ids = [...new Set([key, model, ...["minimal", "low", "medium", "high", "xhigh", "max"].map(e => `${key}-${e}`), ...(aliases || []), ...(old?.models || [])].filter(Boolean))].slice(0, 64)
      entries.set(key, {
        model: key, models: ids, revision: ++revision,
        resetAt: old?.resetAt && (!resetAt || old.resetAt > resetAt) ? old.resetAt : resetAt,
      })
      // Bound diagnostic state even if callers keep inventing model ids.
      if (entries.size > 128) entries.delete(entries.keys().next().value)
    },
    get(model, ticket = generation) {
      if (ticket !== generation) return null
      prune()
      const key = modelKey(model)
      const entry = entries.get(key) || [...entries.values()].find(e => e.models.some(id => modelKey(id) === key))
      return entry?.resetAt ? { ...entry, models: [...entry.models] } : null
    },
    windows() {
      prune()
      return [...entries.values()].map(e => ({
        name: `${e.model} (observed quota exhaustion)`, model: e.model, models: [...e.models],
        ...(e.resetAt ? { used: 100, resetsAt: e.resetAt, display: "Quota exhausted (observed from request)" }
          : { aside: true, display: "Quota exhausted; reset time unknown (not a routing lock)" }),
      }))
    },
  }
}
