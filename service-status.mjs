import fs from "node:fs"
import path from "node:path"

export const TOS_MESSAGE = "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product."
export const SUSPENSION_MESSAGE = `Antigravity account disabled (403 / TOS_VIOLATION): ${TOS_MESSAGE}`

// Only inspect CLI error signals, never prompts or ordinary answer text.
// A generic 403, region restriction, expired token or exhausted quota is not a ban.
export function isServiceSuspension(value, depth = 0) {
  if (depth > 4) return false
  if (typeof value === "string") {
    if (value.includes(TOS_MESSAGE)) return true
    try { return isServiceSuspension(JSON.parse(value), depth + 1) } catch { return false }
  }
  if (!value || typeof value !== "object") return false
  // ACP JSON-RPC errors wrap the upstream response in data/error.
  if (value.data && isServiceSuspension(value.data, depth + 1)) return true
  if (value.error && isServiceSuspension(value.error, depth + 1)) return true
  const error = value.error || value
  if (typeof error.message === "string" && error.message.includes(TOS_MESSAGE)) return true
  return Number(error.code) === 403 && error.status === "PERMISSION_DENIED" &&
    Array.isArray(error.details) && error.details.some(detail =>
      detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && detail.reason === "TOS_VIOLATION")
}

// A profile is immutable after import. Keep its service state independently
// of OAuth token fingerprints: refreshing tokens does not restore service.
// Recovery is explicit, after an appeal: stop the plugin and remove this file.
export function createServiceStatus(file, { onSuspended = () => {}, routingNote = () => "" } = {}) {
  let suspended = false
  try { suspended = JSON.parse(fs.readFileSync(file, "utf8"))?.reason === "TOS_VIOLATION" } catch {}
  return {
    get: () => { if (suspended) onSuspended(); return suspended },
    mark() {
      if (suspended) { onSuspended(); return }
      suspended = true
      const tmp = `${file}.${process.pid}.tmp`
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, reason: "TOS_VIOLATION", detectedAt: new Date().toISOString() }) + "\n", { mode: 0o600 })
        fs.renameSync(tmp, file)
      } catch {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        console.error("[agy-service] Could not persist suspension; this runtime remains blocked. Check state directory permissions.")
      }
      onSuspended()
    },
    usage: () => ({ windows: [], error: [SUSPENSION_MESSAGE, routingNote()].filter(Boolean).join("\n"), signIn: "expired" }),
  }
}
