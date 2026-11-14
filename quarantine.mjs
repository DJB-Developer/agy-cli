import http from "node:http"

// Use the existing web account toggle, not Magpie's private config files.
// The user's Docker web listener is on 3430. Never send its administration
// cookie through an account proxy, a public URL, or an HTTP redirect.
export function createMagpieQuarantine({ user, enabled = () => false,
  env = process.env, request = http.request, port = 3430,
  now = () => Date.now(), timeoutMs = 3000 } = {}) {
  let pending = null, cancel = null, disposed = false, nextAttempt = 0, note = ""
  const validUser = typeof user === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(user)
  const unavailable = why => { note = `Automatic routing disable unavailable: ${why}. Disable this account in Magpie; the CLI remains blocked.` }
  function ensure() {
    if (disposed) return
    let on
    try { on = enabled() } catch { unavailable("the plugin option cannot be read"); return }
    if (!on) { note = "Automatic routing disable is off; the CLI remains blocked."; return }
    if (!validUser) { unavailable("this is not a named plugin account"); return }
    const key = env.MAGPIE_WEB_KEY
    if (typeof key !== "string" || !/^[\x21-\x7e]{16,512}$/.test(key) || /[",;\\]/.test(key)) {
      unavailable("MAGPIE_WEB_KEY is missing or invalid")
      return
    }
    if (pending) return pending
    if (now() < nextAttempt) return
    note = "Disabling this account in Magpie routing…"
    nextAttempt = now() + 60_000
    pending = new Promise(resolve => {
      let req, settled = false
      const finish = outcome => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req?.destroy()
        cancel = null
        if (outcome === "ok") {
          note = "This account is disabled in Magpie routing. Appeal recovery must be manual."
          nextAttempt = now() + 300_000
        } else if (!disposed) {
          note = `Automatic routing disable failed (${outcome}). Disable this account in Magpie; the CLI remains blocked.`
        }
        resolve()
      }
      const timer = setTimeout(() => finish("timeout"), timeoutMs)
      cancel = () => finish("canceled")
      const body = JSON.stringify({ agent: "plugin:agy-cli", user })
      try {
        req = request({ hostname: "127.0.0.1", port, path: "/api/login/off", method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
            Cookie: `magpie_web_${port}=${key}`, Origin: `http://127.0.0.1:${port}` },
        }, res => {
          res.on("error", () => {})
          res.resume()
          finish(res.statusCode >= 200 && res.statusCode < 300 ? "ok" : `HTTP ${res.statusCode}`)
        })
        req.on("error", () => finish("connection error"))
        req.end(body)
      } catch { finish("connection error") }
    }).finally(() => { pending = null })
    return pending
  }
  return { ensure, note: () => note, dispose() { disposed = true; cancel?.() } }
}
