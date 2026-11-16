import { randomUUID } from "node:crypto"

// Never include signal.reason in diagnostics: callers can put arbitrary text there.
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError")
}

// Cancels the wait, not a shared operation (e.g. catalog refresh or lock owner).
export function waitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException("The request was aborted", "AbortError")) }
    const cleanup = () => signal.removeEventListener("abort", abort)
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

// Every elapsed value uses a monotonic clock, not wall time. One bounded row per
// HTTP response, including tool continuations; spans may be nested, not additive.
export function createRequestTrace({ enabled = false, emit = () => {}, now = () => performance.now() } = {}) {
  const start = now()
  const stages = {}
  const active = new Map()
  const marks = {}
  const facts = {}
  let firstOutput = null, firstText = null, finished = false
  const trace = {
    id: "req_" + randomUUID().replaceAll("-", "").slice(0, 8),
    streaming: false,
    context(values) { Object.assign(facts, values) },
    mark(name) { if (!(name in marks)) marks[name] = Math.max(0, now() - start) },
    span(stage) {
      const at = now(), span = {}
      active.set(span, { stage, at })
      return () => {
        if (!active.delete(span)) return
        stages[stage] = (stages[stage] || 0) + Math.max(0, now() - at)
      }
    },
    async measure(stage, run) {
      const end = trace.span(stage)
      try { return await run() }
      finally { end() }
    },
    output(kind) {
      if (firstOutput === null) firstOutput = Math.max(0, now() - start)
      if (kind === "text" && firstText === null) firstText = Math.max(0, now() - start)
    },
    finish(outcome, status) {
      if (finished) return
      finished = true
      if (!enabled) return
      const end = now()
      const elapsed = Math.max(0, end - start)
      const measured = { ...stages }
      for (const { stage, at } of active.values()) measured[stage] = (measured[stage] || 0) + Math.max(0, end - at)
      const round = n => n === null ? null : Math.round(n * 100) / 100
      const row = { event: "agy_bridge_request", req_id: trace.id, ...facts, outcome, status,
        total_ms: round(elapsed), first_output_ms: round(firstOutput), first_text_ms: round(firstText),
        after_first_output_ms: firstOutput === null ? null : round(elapsed - firstOutput),
        ...Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, round(value)])),
        stages_ms: Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, round(value)])) }
      try { emit(row) } catch { /* Diagnostics must never break a response. */ }
    },
  }
  return trace
}
