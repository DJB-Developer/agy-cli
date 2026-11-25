// Read only this prompt's final native error step. Inspired by T3 Code's
// AntigravityTurnOutcome / AntigravityProfilePaths (MIT, pingdotgg/t3code
// 0b489dada1f00db39c99074239c09c006f223aee); adapted for agy CLI profiles,
// Bun/Node SQLite, Magpie errors and per-account TOS quarantine.
import fs from "node:fs"
import path from "node:path"
import { readConversationStore } from "./step-usage.mjs"
import { isServiceSuspension, TOS_MESSAGE } from "./service-status.mjs"

const MAX_PAYLOAD = 16_384
// T3 Code 072611f: do not join the message of one error to another error's
// status, and accept native 1.5 status lines and HTTP status descriptions.
const API_ERROR = /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/s
const STATUS_ERROR = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u
const SESSION_ID = /^[A-Za-z0-9_-]+$/
const UNITS = { ns: 1e-6, us: 1e-3, "µs": 1e-3, "μs": 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
const same = (a, b) => a.dev === b.dev && a.ino === b.ino
const stat = file => { try { return fs.lstatSync(file) } catch (error) { if (error.code === "ENOENT") return null; throw error } }

// root is a trusted profile (or an explicitly configured legacy conversation
// directory). Reject links below it, including WAL/SHM, and hard-linked stores.
function proof(root, segments) {
  const rootInfo = fs.lstatSync(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null
  const entries = [{ file: root, info: rootInfo }]
  let file = root, absent = false
  for (let i = 0; i < segments.length; i++) {
    file = path.join(file, segments[i])
    const info = absent ? null : stat(file)
    const leaf = i === segments.length - 1
    if (info && (info.isSymbolicLink() || (leaf ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()))) return null
    absent ||= !info
    entries.push({ file, info })
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const info = absent ? null : stat(file + suffix)
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) return null
  }
  return { file, entries, exists: !absent }
}
function unchanged(before, after) {
  return !!after && before.entries.every((entry, i) =>
    !entry.info || (after.entries[i]?.info && same(entry.info, after.entries[i].info)))
}

function valueOf(text, key) {
  return new RegExp(`\\b${key}\\b["']?\\s*[:=]\\s*["']?([^\\s\\]\\},"']+)`).exec(text)?.[1]
}
function durationMs(value) {
  if (!value || !/^(?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+$/.test(value)) return null
  let ms = 0
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g)) ms += Number(amount) * UNITS[unit]
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function recoveryTime(text, now = Date.now()) {
  if (!Number.isFinite(now)) return null
  const timestamp = valueOf(text, "quotaResetTimeStamp")
  // Require an explicit zone, never interpret a vendor date in the host's zone.
  if (timestamp && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    const parsed = Date.parse(timestamp)
    const day = Date.parse(timestamp.slice(0, 10) + "T00:00:00Z")
    const validDay = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === timestamp.slice(0, 10)
    if (validDay && Number(timestamp.slice(11, 13)) < 24 && Number(timestamp.slice(14, 16)) < 60 &&
        Number(timestamp.slice(17, 19)) < 60 && Number.isFinite(parsed) && parsed > now &&
        parsed <= 253402300799000) return new Date(parsed).toISOString()
  }
  const noticeDelay = /\bResets in\s+((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|s|m|h))+)(?!\.\d)(?=[\s.!?,)]|$)/.exec(text)?.[1]
  const ms = durationMs(valueOf(text, "quotaResetDelay")) ?? durationMs(valueOf(text, "retryDelay")) ?? durationMs(noticeDelay)
  if (ms === null || !Number.isFinite(now + ms) || now + ms > 253402300799000) return null
  const target = new Date(now + ms)
  return target.getTime() > now ? target.toISOString() : null
}

function safeMessage(text) {
  return text.replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\bBearer\s+\S+|1\/\/[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/((?:access_token|refresh_token|client_secret|api_key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]")
    .trim().slice(0, 2048)
}

// Parse only bounded native error-step bodies, never model/user messages.
// Adapted from T3's balancedJsonObject. Successful objects are consumed once.
function errorBodies(text) {
  const bodies = []
  const starts = /\{\s*"error"\s*:/g
  let match
  while ((match = starts.exec(text))) {
    let depth = 0, quoted = false, escaped = false
    for (let i = match.index; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') quoted = false
      } else if (ch === '"') quoted = true
      else if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) {
        try { bodies.push(JSON.parse(text.slice(match.index, i + 1)).error) } catch {}
        starts.lastIndex = i + 1
        break
      }
    }
  }
  return bodies.filter(error => error && typeof error === "object" && !Array.isArray(error))
}

export function parseErrorStep(payload, now = Date.now()) {
  if (!ArrayBuffer.isView(payload)) return null
  const text = new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, Math.min(payload.byteLength, MAX_PAYLOAD)))
  const bodies = errorBodies(text)
  const statusLine = STATUS_ERROR.exec(text)
  const json = bodies.find(error => Number.isInteger(error.code) && error.code >= 400 && error.code <= 599)
  const api = API_ERROR.exec(text) || (statusLine && [statusLine[0], statusLine[2], statusLine[3], statusLine[1]]) ||
    (json && ["", String(json.code), typeof json.message === "string" ? json.message : "Antigravity refused this request.",
      typeof json.status === "string" && /^[A-Z_]+$/.test(json.status) ? json.status : `HTTP_${json.code}`])
  const status = api && Number(api[1]) >= 400 && Number(api[1]) <= 599 ? Number(api[1]) : 502
  const reason = valueOf(text, "reason")
  if (isServiceSuspension(text) || bodies.some(error => isServiceSuspension(error)) || (status === 403 && reason === "TOS_VIOLATION")) {
    return { status: 403, code: "TOS_VIOLATION", message: TOS_MESSAGE }
  }
  if (bodies.some(error => error.code === 403 && error.status === "PERMISSION_DENIED" &&
    Array.isArray(error.details) && error.details.some(info => info?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" &&
      info.domain === "cloudcode-pa.googleapis.com" && info.reason === "VALIDATION_REQUIRED"))) {
    // Do not echo untrusted metadata/URLs or open a verification page for the user.
    return { status: 403, code: "VALIDATION_REQUIRED", noRetry: true,
      message: "This Google account needs to be verified. Open the Antigravity app or run agy signed in to this account to complete verification before retrying." }
  }
  const result = {
    status: reason === "QUOTA_EXHAUSTED" && !api ? 429 : status,
    code: reason === "QUOTA_EXHAUSTED" ? reason : api?.[3] || "AGY_TURN_FAILED",
    message: api ? safeMessage(api[2]) : "agy stopped this turn because of an error recorded in its session database.",
  }
  if (result.status === 403) result.noRetry = true
  if (result.status === 429 || result.status >= 500) {
    const resetAt = recoveryTime(text, now)
    if (resetAt) result.resetAt = resetAt
  }
  return result
}

// No writes, polling or table migrations. An absent/locked/incompatible store
// gives no extra evidence and never disables the established ACP/log checks.
export function watchPromptOutcome({ root, directory = ["antigravity-cli", "conversations"], sessionId }) {
  const unknown = () => null
  if (typeof root !== "string" || !SESSION_ID.test(sessionId || "") ||
      !Array.isArray(directory) || directory.some(part => !SESSION_ID.test(part))) return unknown
  try {
    // Canonicalize ancestors (e.g. macOS /var -> /private/var), not a linked profile.
    if (fs.lstatSync(root).isSymbolicLink()) return unknown
    root = fs.realpathSync(root)
    const segments = [...directory, `${sessionId}.db`]
    const before = proof(root, segments)
    if (!before) return unknown
    const start = before.exists ? readConversationStore(before.file, db => {
      if (!db.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'").length) return -1
      return db.all("SELECT COALESCE(MAX(idx), -1) AS idx FROM steps")[0]?.idx
    }) : -1
    if (!Number.isSafeInteger(start) || !unchanged(before, proof(root, segments))) return unknown
    return (now = Date.now()) => {
      try {
        const after = proof(root, segments)
        if (!after?.exists || !unchanged(before, after)) return null
        const row = readConversationStore(after.file, db => db.all(
          "SELECT idx, step_type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1",
          MAX_PAYLOAD, start,
        )[0] || null)
        if (!unchanged(after, proof(root, segments)) || row?.step_type !== 17) return null
        return parseErrorStep(row.payload ?? new Uint8Array(), now)
      } catch { return null }
    }
  } catch { return unknown }
}
