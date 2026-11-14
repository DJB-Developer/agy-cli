import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agySpawnSpec, childEnv as agyChildEnv } from "./platform.mjs"
import { cannotSignIn, isDead, noteDead, storedSignIn } from "./signin.mjs"
import { fetchAccountPlan } from "./plan.mjs"
import { isServiceSuspension, SUSPENSION_MESSAGE } from "./service-status.mjs"

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 18_000 // Magpie bounds an auth.usage call to 20 seconds.
const MAX_OUTPUT_BYTES = 1024 * 1024
const DIAGNOSTIC_LIMIT = 4096

// CLI output may include OAuth URLs, credentials or an account email. Keep
// diagnostic wording, but never intentionally copy those values into logs or UI.
const SECRET_FIELD = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:access|refresh|id|session)[-_]?token|token|(?:api[-_]?)?key|client[-_]?secret|secret|password|credential|code|code[-_]?verifier|state)$/i
const diagnosticCode = value => /^(?:[1-5]\d{2}|OK|Cancelled|Unknown|InvalidArgument|DeadlineExceeded|NotFound|AlreadyExists|PermissionDenied|ResourceExhausted|FailedPrecondition|Aborted|OutOfRange|Unimplemented|Internal|Unavailable|DataLoss|Unauthenticated)$/i.test(String(value))

function redactUsageText(output) {
  return String(output)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\b(?:https?|socks5?):\/\/[^\s<>"']+/gi, url => {
      try { return `[URL ${new URL(url).hostname}]` } catch { return "[URL]" }
    })
    .replace(/\b(?:authorization|proxy[-_]?authorization|set[-_]?cookie|cookie)["']?\s*[:=][^\r\n]*/gi, "[REDACTED header]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"';]+/gi, "[REDACTED auth]")
    .replace(/(["']?\b(?:access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|token|api[-_]?key|key|client[-_]?secret|secret|password|credential|code|code[-_]?verifier|state)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      (match, prefix, value) => /^["']?code["']?\s*[:=]/i.test(prefix) && diagnosticCode(value.replace(/^["']|["']$/g, "")) ? match : `${prefix}[REDACTED]`)
    .replace(/(?:1\/\/|ya29\.|AIza|sk-)[A-Za-z0-9._~+\/-]+/g, "[REDACTED token]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, "[REDACTED jwt]")
    .replace(/[A-Za-z0-9_+/-]{40,}={0,2}/g, "[REDACTED opaque value]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi, "[REDACTED email]")
}

export function sanitizeUsageDiagnostic(value) {
  const scrub = (value, depth = 0) => {
    if (depth > 12) return "[truncated]"
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1))
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, SECRET_FIELD.test(key) && !(key.toLowerCase() === "code" && diagnosticCode(item)) ? "[REDACTED]" : scrub(item, depth + 1)]))
    if (typeof value !== "string") return value
    // Error messages can themselves embed serialized JSON credentials.
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === "object") return JSON.stringify(scrub(parsed, depth + 1))
      if (typeof parsed === "string") return scrub(parsed, depth + 1)
    } catch {}
    return redactUsageText(value)
  }
  const raw = String(value ?? "")
  let output
  try { output = JSON.stringify(scrub(JSON.parse(raw))) } catch {
    // stderr text followed by a JSON report is not one JSON document.
    output = raw.split("\n").map(line => scrub(line)).join("\n")
  }
  // Redact before truncating, so a clipped credential cannot evade matching.
  return output.length > DIAGNOSTIC_LIMIT ? output.slice(0, DIAGNOSTIC_LIMIT) + "… [truncated]" : output.trim()
}

// kind: "auth" (agy says it needs a sign-in), "timeout" (output: what agy
// had printed by then, exposed only after redaction), "cancel", or none.
class UsageError extends Error {
  constructor(message, { kind = "", output = "" } = {}) {
    super(message)
    this.kind = kind
    this.output = output
  }
}

// What agy prints when it starts its own Google sign-in.
const SIGN_IN_TALK = /accounts\.google\.com|oauth|sign[ -]?in|log[ -]?in|authenticat|browser/i

const text = value => typeof value === "string" ? value.trim() : ""
const field = (value, camel, snake) => value?.[camel] ?? value?.[snake]

function commandFailure(output) {
  if (isServiceSuspension(output)) return new UsageError(SUSPENSION_MESSAGE, { kind: "suspended" })
  if (/not (?:logged|signed) in|unauthenticated|authentication required|login required|please (?:log|sign) in|sign in again/i.test(output)) {
    return new UsageError("agy usage needs authentication. Run `agy` in a terminal to sign in again.", { kind: "auth" })
  }
  const eligibility = /eligibility check failed|not eligible|unsupported (?:country|region)|does not support google tos/i.test(output)
  const network = /\b(?:eof|timeout|timed out|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|ssl|certificate)\b/i.test(output)
  if (network) return new UsageError(`agy usage ${eligibility ? "eligibility check " : ""}failed on a network request. Check network or proxy settings.`)
  if (/not eligible|unsupported (?:country|region)|does not support google tos/i.test(output)) return new UsageError("agy reports that this account is not eligible for Antigravity.")
  if (eligibility) return new UsageError("agy's account eligibility check failed.")
  return new UsageError("agy could not read usage. Run `agy` in a terminal to check its status.")
}

function resetTime(value) {
  if (value == null || value === "" || typeof value === "boolean") return undefined
  const raw = String(value)
  let ms
  if (/^\d+(?:\.\d+)?$/.test(raw)) ms = Number(raw) * (Number(raw) < 1e11 ? 1000 : 1)
  else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) ms = Date.parse(raw)
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300799999) return undefined
  return new Date(ms).toISOString()
}

function cadence(bucket, id, name) {
  // An explicit, unfamiliar window must not be overridden by an older ID/label.
  const value = text(bucket.window) || `${id} ${name}`
  if (/^(?:5h|five[_ -]?hours?|five_hour|session)$/i.test(value) || !text(bucket.window) && /(?:5h|five[ _-]hour|session)/i.test(value)) {
    return { name: "5 hours", span: 5 * 60 * 60 }
  }
  if (/^(?:weekly|week|7d|seven[_ -]?days?)$/i.test(value) || !text(bucket.window) && /(?:weekly|week|7d)/i.test(value)) {
    return { name: "7 days", span: 7 * 24 * 60 * 60 }
  }
  return { name: name || id }
}

const poolName = group => (text(field(group, "displayName", "display_name")) || text(group?.name) || "Quota")
  .replace(/\s+models$/i, "").replace(/\s+and\s+/gi, " & ")
const modelWords = value => value.toLowerCase().replace(/[\s._-]+/g, "-")

// Magpie's `models` is an exact-ID allowlist (not a glob). Use the account's
// catalog, including collapsed aliases and raw effort variants. A narrower
// named pool owns its models even when its reading is unknown or disabled:
// falling back to a broad pool would invent an allowance for those models.
function modelsByGroup(groups, models) {
  const names = groups.map(group => modelWords(poolName(group)))
  const score = (name, id) => {
    if (name === "claude-&-gpt") return /^(?:claude|gpt)-/.test(id) ? 1 : 0
    // Antigravity can omit Argon's separate pool from the summary. Unlike
    // its direct-API plugin we have no per-model quota reading to compare:
    // only the known Flash/Pro families belong to the generic Gemini pool.
    if (name === "gemini") return /^gemini-(?:\d+(?:-\d+)*-)?(?:flash|pro)(?:-|$)/.test(id) ? 2 : 0
    if (["claude", "gpt"].includes(name)) return id.startsWith(name + "-") ? 2 : 0
    if (!/^(?:gemini|claude|gpt)-[a-z0-9]/.test(name)) return 0
    return id === name || id.startsWith(name + "-") ? name.length : 0
  }
  const out = groups.map(() => [])
  for (const model of new Set(Array.isArray(models) ? models.filter(id => typeof id === "string" && id) : [])) {
    const scores = names.map(name => score(name, modelWords(model)))
    const best = Math.max(0, ...scores)
    if (best) scores.forEach((value, i) => { if (value === best) out[i].push(model) })
  }
  return out
}

// agy's command report is not its token-usage object or a model-availability list.
// Unknown quota is not evidence of exhaustion or a full allowance.
export function parseUsageReport(value, { models = [] } = {}) {
  if (isServiceSuspension(value)) throw new UsageError(SUSPENSION_MESSAGE, { kind: "suspended" })
  let report
  try { report = typeof value === "string" ? JSON.parse(value) : value } catch {
    throw new UsageError("agy returned an invalid usage report.")
  }
  if (report?.status !== "SUCCESS" || report?.command?.name !== "usage") {
    throw commandFailure(`${text(report?.error)} ${text(report?.response)}`)
  }
  const groups = Array.isArray(report.command.data?.groups) ? report.command.data.groups : []
  const members = modelsByGroup(groups, models)
  const windows = []
  for (const [index, group] of groups.entries()) {
    const pool = poolName(group)
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const id = text(field(bucket, "bucketId", "bucket_id")) || text(bucket?.id)
      if (!id || bucket?.disabled === true) continue
      const label = text(field(bucket, "displayName", "display_name")) || text(bucket?.name)
      const period = cadence(bucket, id, label)
      const remaining = bucket.remaining
      const fraction = field(bucket, "remainingFraction", "remaining_fraction")
        ?? field(remaining, "remainingFraction", "remaining_fraction")
        ?? (remaining?.case === "remainingFraction" ? remaining.value : undefined)
      const known = typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
      const resetsAt = resetTime(field(bucket, "resetTime", "reset_time"))
      windows.push({
        name: `${pool} · ${period.name}`,
        // Never emit an unscoped routing window: it would cap every model.
        aside: !known || members[index].length === 0,
        ...(known && members[index].length ? { models: members[index] } : {}),
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: "Limits not available" }),
        ...(period.span ? { span: period.span } : {}),
        ...(resetsAt ? { resetsAt } : {}),
      })
    }
  }
  if (!windows.some(w => w.used !== undefined)) {
    throw new UsageError("Limits not available: agy returned no enabled, measured quota buckets.")
  }
  // /usage has no verified account or plan identity. Do not borrow one elsewhere.
  return { windows }
}

function timeout(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
}

function run(file, args, { cwd, env, deadline, signal, maxOutputBytes, onTreeKill }) {
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let stopped = false
    let bytes = 0
    const stdout = []
    const stderr = []
    let timer
    let treeKillTimer
    let fallbackKillTimer
    const killWindowsTree = () => {
      let spawned = false
      try {
        const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true })
        killer?.unref?.()
        spawned = Boolean(killer)
        if (typeof killer?.once === "function") {
          const done = new Promise(r => {
            killer.once("error", () => { try { child.kill("SIGKILL") } catch {}; r() })
            killer.once("close", code => { if (code !== 0) try { child.kill("SIGKILL") } catch {}; r() })
          })
          onTreeKill?.(done)
        }
      } catch {}
      if (!spawned) {
        try { child.kill("SIGKILL") } catch {}
      } else {
        fallbackKillTimer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 500)
        fallbackKillTimer.unref?.()
      }
    }
    const stop = (fromExit = false) => {
      if (!child?.pid || stopped) return
      if (process.platform === "win32") {
        if (fromExit && child.exitCode !== null) {
          treeKillTimer = setTimeout(() => {
            if (!settled && !stopped) {
              stopped = true
              killWindowsTree()
            }
          }, 30)
          treeKillTimer.unref?.()
          return
        }
        stopped = true
        clearTimeout(treeKillTimer)
        killWindowsTree()
        return
      }
      stopped = true
      // Only this detached child/group is ours, never an existing user agy.
      try { process.kill(-child.pid, "SIGKILL") } catch {
        try { child.kill("SIGKILL") } catch {}
      }
    }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (error instanceof UsageError && !error.output && error.kind !== "cancel") {
        error.output = Buffer.concat(stderr).toString("utf8") + "\n" + Buffer.concat(stdout).toString("utf8")
      }
      clearTimeout(timer)
      clearTimeout(treeKillTimer)
      clearTimeout(fallbackKillTimer)
      signal?.removeEventListener("abort", abort)
      if (process.platform !== "win32" || error || child?.exitCode === null) {
        stop() // Also stop MCP descendants if the parent exited first.
      }
      child?.stdout?.destroy()
      child?.stderr?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () => finish(new UsageError("agy usage query was cancelled.", { kind: "cancel" }))
    const late = () => finish(new UsageError("agy usage query timed out.", {
      kind: "timeout", output: Buffer.concat(stdout).toString("utf8") + "\n" + Buffer.concat(stderr).toString("utf8"),
    }))
    if (signal?.aborted) return abort()
    if (Date.now() >= deadline) return finish(new UsageError("agy usage query timed out."))
    try {
      const command = agySpawnSpec(file, args)
      child = spawn(command.file, command.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        ...command.options,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch {
      finish(new UsageError("agy usage could not start the CLI."))
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(late, Math.max(1, deadline - Date.now()))
    const collect = chunks => chunk => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxOutputBytes) return finish(new UsageError("agy usage output exceeded the size limit."))
      chunks.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", () => finish(new UsageError("agy usage could not start the CLI.")))
    // exit, not close: a descendant may inherit the pipe and keep it open.
    // Drain the already-written output through close for a normal parent exit.
    child.on("exit", () => stop(true))
    child.on("close", code => finish(null, {
      code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
    }))
  })
}

function supportedVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim())
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number)
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11)
}

export async function fetchUsage(agy, {
  env = process.env,
  geminiDir,
  accountName = geminiDir ? path.basename(geminiDir) : "default",
  diagnostic = line => console.error(line),
  timeoutMs = env.AGY_BRIDGE_USAGE_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  signal,
  tempRoot = os.tmpdir(),
  getModels = () => [],
  readPlan = fetchAccountPlan,
} = {}) {
  if (!agy) throw new UsageError("agy CLI not found. Install it and run `agy` once to sign in.")
  const deadline = Date.now() + timeout(timeoutMs)
  const directory = await fs.mkdtemp(path.join(tempRoot, "magpie-agy-usage-"))
  let pendingTreeKill = null
  let stage = "setup"
  let result = null
  let cliVersion = null
  try {
    await fs.chmod(directory, 0o700)
    const agentDir = path.join(directory, ".agents", "agents", "magpie-usage")
    await fs.mkdir(agentDir, { recursive: true })
    await fs.writeFile(path.join(agentDir, "agent.md"), [
      "---", "name: magpie-usage", "description: Read CLI usage only", "mainAgent: true", "subagent: false",
      "tools: []", "mcpServers: []", "---", "Do not run model prompts or tools.", "",
    ].join("\n"), { mode: 0o600 })
    if (process.platform === "win32") {
      await fs.writeFile(path.join(directory, "open.cmd"), "@exit /b 1\r\n")
    } else {
      for (const name of ["open", "xdg-open"]) {
        await fs.writeFile(path.join(directory, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
      }
    }
    const baseEnv = { ...env }
    const inheritedPath = env.PATH || baseEnv.Path || (process.platform === "win32" ? "" : "/usr/bin:/bin")
    for (const key of Object.keys(baseEnv)) {
      if (/^path$/i.test(key) && key !== "PATH") delete baseEnv[key]
    }
    const childEnv = agyChildEnv(baseEnv, {
      PATH: directory + path.delimiter + inheritedPath,
      BROWSER: path.join(directory, process.platform === "win32" ? "open.cmd" : "open"),
    })
    const options = { cwd: directory, env: childEnv, deadline, signal, maxOutputBytes, onTreeKill: p => { pendingTreeKill = p } }
    // --version needs no sign-in, so its hang is never read as one
    stage = "version"
    const version = await run(agy, ["--version"], { ...options, deadline: Math.min(deadline, Date.now() + 3000) }).catch((error) => {
      if (error?.kind === "timeout") throw new UsageError(error.message, { output: error.output })
      throw error
    })
    result = version
    if (version.code !== 0) throw commandFailure(version.stderr)
    if (!supportedVersion(version.stdout)) throw new UsageError("agy usage reports require a verified agy version 1.1.11 or later. Update the CLI.")
    cliVersion = version.stdout.trim()
    stage = "usage"
    result = null
    result = await run(agy, [...(geminiDir ? [`--gemini_dir=${geminiDir}`] : []), "-p", "/usage", "--output-format", "json", "--agent", "magpie-usage", "--print-timeout", `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`], options)
    if (result.code !== 0) throw commandFailure(result.stderr + "\n" + result.stdout)
    const usage = parseUsageReport(result.stdout, { models: getModels(agy) })
    // Ordinary plan failures remain optional. An explicit TOS suspension is
    // a separate account signal, even if the CLI still reports quota.
    stage = "account-metadata"
    let suspended = false
    try {
      const plan = await readPlan({ env, geminiDir, signal, onServiceSuspended: () => { suspended = true } })
      if (plan) usage.plan = plan
    } catch {}
    if (suspended) {
      const error = new UsageError(SUSPENSION_MESSAGE, { kind: "suspended", output: SUSPENSION_MESSAGE })
      error.source = "HTTP"
      throw error
    }
    return usage
  } catch (error) {
    if (error?.kind !== "cancel") {
      let detail = ""
      try { detail = sanitizeUsageDiagnostic(error?.output || (result ? `${result.stderr}\n${result.stdout}` : "")) } catch {}
      // Magpie renders auth.usage().error. Carry only the bounded, redacted
      // detail to that boundary; never concatenate raw subprocess output there.
      if (error instanceof UsageError) error.detail = detail
      // This boundary runs once per actual CLI query, including a shared
      // query's failure. Cached backoff responses never repeat the log.
      try {
        diagnostic("[agy-usage] " + JSON.stringify({
          event: "usage_failed", account: sanitizeUsageDiagnostic(accountName), stage,
          cliVersion, exitCode: result?.code ?? null,
          error: error instanceof UsageError ? error.message : "Could not query agy usage.",
          detail,
        }))
      } catch {} // Diagnostic failures must not change auth or query behavior.
    }
    throw error
  } finally {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await fs.rm(directory, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 3 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) break
        if (pendingTreeKill) {
          const waitKill = pendingTreeKill
          pendingTreeKill = null
          await Promise.race([waitKill, new Promise(resolve => setTimeout(resolve, 800))])
        }
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
}

// A read that failed isn't run again for this long, doubled for each
// failure in a row, up to BACKOFF_MOST: agy is a process of its own, and one
// that fails every few minutes all day helps nobody.
const BACKOFF_FIRST_MS = 10 * 60 * 1000
const BACKOFF_MOST_MS = 6 * 60 * 60 * 1000

function backoff(n) {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, Math.min(n, 20) - 1), BACKOFF_MOST_MS)
}

const NEEDS_SIGN_IN = "Sign in again from this account's Sign in in magpie, or run `agy` in a terminal; magpie doesn't run agy for usage until then."

// No completed-result cache: sequential refreshes must see account/allowance changes.
// What is kept is what keeps agy from being run when it can't answer:
// - agy's stored sign-in is read first (signin.mjs), and agy isn't run when
//   there is none, or it has ended with nothing to renew it: the read says
//   the sign-in has expired (signIn "expired"), which magpie shows on the
//   account, and nothing starts a Google sign-in in the background.
// - a run agy failed for want of a sign-in (it said so, or it hung with an
//   ended access token, as an agy waiting on its browser sign-in does) marks
//   that stored sign-in dead: agy isn't run again until another is stored.
// - any other failure isn't run again for backoff(n).
export function createUsageReader(resolveAgy, options = {}) {
  const { signIn = () => storedSignIn({ fresh: true }), now = () => Date.now(), queryUsage = fetchUsage, serviceStatus, ...fetchOptions } = options
  const pending = new Map()
  let held = null
  let failedAuth = null
  let saidExpired = false
  const withDetail = (message, detail, source = "CLI") => detail ? `${message}\n${source} error (redacted):\n${detail}` : message
  const expired = (why, detail, source) => {
    saidExpired = true
    return { windows: [], error: withDetail(`${why}. ${NEEDS_SIGN_IN}`, detail, source), signIn: "expired" }
  }
  return async () => {
    if (serviceStatus?.get()) return serviceStatus.usage()
    let stored
    try { stored = await signIn() } catch { stored = { state: "unknown" } }
    const why = cannotSignIn(stored)
    if (why) return expired(why)
    if (isDead(stored)) return expired("agy's sign-in no longer works", failedAuth?.fp === stored.fp ? failedAuth.detail : "", failedAuth?.source)
    const key = stored?.state === "present" ? stored.fp : "unknown"
    if (held && held.key === key && now() < held.until) {
      return { windows: [], error: held.error, signIn: held.auth ? "expired" : "kept" }
    }
    try {
      const agy = resolveAgy()
      const pendingKey = JSON.stringify([agy, key])
      if (!pending.has(pendingKey)) {
        const query = queryUsage(agy, fetchOptions).finally(() => {
          if (pending.get(pendingKey) === query) pending.delete(pendingKey)
        })
        pending.set(pendingKey, query)
      }
      const result = { ...structuredClone(await pending.get(pendingKey)), signIn: saidExpired ? "renewed" : "kept" }
      if (serviceStatus?.get()) return serviceStatus.usage()
      held = null
      failedAuth = null
      saidExpired = false
      return result
    } catch (error) {
      if (error?.kind === "suspended") serviceStatus?.mark()
      if (serviceStatus?.get()) return serviceStatus.usage()
      const message = error instanceof UsageError ? withDetail(error.message, error.detail, error.source) : "agy usage query failed. Check network and credential permissions."
      if (error?.kind === "cancel") return { windows: [], error: message, signIn: "kept" }
      const auth = error?.kind === "auth" || error?.kind === "timeout" && stored?.state === "present" && stored.expired &&
        (!String(error.output ?? "").trim() || SIGN_IN_TALK.test(error.output))
      if (auth && stored?.state === "present") {
        noteDead(stored)
        failedAuth = { fp: stored.fp, detail: error.detail, source: error.source }
        return expired("agy's sign-in no longer works", error.detail, error.source)
      }
      const n = held?.key === key ? held.n + 1 : 1
      held = { key, n, until: now() + backoff(n), error: message, auth }
      if (auth) saidExpired = true
      return { windows: [], error: message, signIn: auth ? "expired" : "kept" }
    }
  }
}
