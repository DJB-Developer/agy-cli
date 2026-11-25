import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { watchPromptOutcome, recoveryTime, parseErrorStep } from "../turn-outcome.mjs"
import { appendStep, quotaError, openFixtureDatabase } from "./outcome-fixture.mjs"
import { TOS_MESSAGE } from "../service-status.mjs"
const NOW = Date.parse("2026-11-16T00:00:00Z")
const iso = ms => new Date(NOW + ms).toISOString()
const payload = text => Buffer.from(text)
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-outcome-"))
  const dir = path.join(root, "antigravity-cli", "conversations")
  const file = path.join(dir, "session-a.db")
  const watch = () => watchPromptOutcome({ root, sessionId: "session-a" })
  try { return fn({ root, dir, file, watch }) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test("reset timestamp takes priority; precise Go duration, JSON values and retry fallback", () => {
  assert.equal(recoveryTime('quotaResetTimeStamp:2026-11-16T10:00:00+08:00 quotaResetDelay:5s retryDelay:2s', NOW), iso(7200000))
  assert.equal(recoveryTime(quotaError, NOW), iso(3723500))
  assert.equal(recoveryTime('quotaResetTimeStamp:soon quotaResetDelay:invalid retryDelay:42.5s', NOW), iso(42500))
  assert.equal(recoveryTime('{"quotaResetDelay":"1m2.25s","retryDelay":"3s"}', NOW), iso(62250))
  assert.equal(recoveryTime('retryDelay:1500ms', NOW), iso(1500))
})
test("no invented time for malformed, stale, nonpositive or overflowing reset metadata", () => {
  for (const text of ['in one hour', 'retryDelay:-1s', 'retryDelay:0s', 'retryDelay:NaNs',
    'retryDelay:1sfoo', 'retryDelay:1h-2s', 'retryDelay:99999999999999999999999999h',
    'quotaResetTimeStamp:2020-01-01T00:00:00Z', 'quotaResetTimeStamp:2027-01-01T00:00:00',
    'quotaResetTimeStamp:2027-02-30T00:00:00Z']) assert.equal(recoveryTime(text, NOW), null, text)
})
test("bounded error parsing preserves status, strips stack and redacts credential fragments", () => {
  const e = parseErrorStep(payload('Error 503, Message: Unavailable Bearer hidden-secret, Status: UNAVAILABLE, Details: [retryDelay:5s]\nstack trace'), NOW)
  assert.equal(e.status, 503)
  assert.equal(e.code, "UNAVAILABLE")
  assert.equal(e.resetAt, iso(5000))
  assert.doesNotMatch(e.message, /hidden-secret|stack trace/)
  assert.equal(parseErrorStep(payload('Error 400, Message: Bad argument., Status: INVALID_ARGUMENT, Details: [retryDelay:5s]'), NOW).resetAt, undefined)
  assert.equal(parseErrorStep(payload('unrecognized\nsecret stack trace'), NOW).status, 502)
  assert.doesNotMatch(parseErrorStep(payload('x'.repeat(16384) + TOS_MESSAGE), NOW).message, /disabled|stack/)
})
test("TOS is permanent evidence without a reset, generic 403 is not a TOS ban", () => {
  for (const text of [TOS_MESSAGE, 'Error 403, Message: Denied., Status: PERMISSION_DENIED, Details: [reason:TOS_VIOLATION retryDelay:1h]']) {
    assert.deepEqual(parseErrorStep(payload(text), NOW), { status: 403, code: "TOS_VIOLATION", message: TOS_MESSAGE })
  }
  const plain = parseErrorStep(payload('Error 403, Message: Not available in your location., Status: PERMISSION_DENIED, Details: [retryDelay:1h]'), NOW)
  assert.equal(plain.code, "PERMISSION_DENIED")
  assert.equal(plain.status, 403)
  assert.equal(plain.resetAt, undefined)
})
test("only this prompt's final step counts; old failures, quoted errors and recovered retries do not", () => fixture(({ file, watch }) => {
  const first = watch()
  appendStep(file, 17, quotaError)
  assert.equal(first(NOW).resetAt, iso(3723500))
  const second = watch()
  assert.equal(second(NOW), null, "old error alone must not recur")
  appendStep(file, 15, TOS_MESSAGE)
  assert.equal(second(NOW), null, "quoted TOS in a model reply is not a ban")
  const third = watch()
  appendStep(file, 17, quotaError)
  appendStep(file, 15, "retry succeeded")
  assert.equal(third(NOW), null)
}))
test("missing, corrupt, incompatible and replaced stores are ignored", () => fixture(({ file, dir, watch }) => {
  assert.equal(watch()(NOW), null)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, "not sqlite")
  const corrupt = watch()
  assert.equal(corrupt(NOW), null)
  fs.unlinkSync(file)
  appendStep(file, 15, "ok")
  const before = watch()
  fs.renameSync(file, file + ".old")
  appendStep(file, 17, quotaError)
  assert.equal(before(NOW), null, "replacement must not become this prompt's evidence")
}))
test("read-only reads do not create sidecars for a checkpointed WAL store", () => fixture(({ file, dir, watch }) => {
  appendStep(file, 15, "ok", { wal: true })
  const check = watch()
  appendStep(file, 17, quotaError, { wal: true })
  const before = fs.readdirSync(dir).sort()
  assert.equal(check(NOW).status, 429)
  assert.deepEqual(fs.readdirSync(dir).sort(), before)
}))
test("reject traversal, symlinked directories/files/sidecars, and hard-linked session databases", () => fixture(({ root, dir, file, watch }) => {
  appendStep(file, 17, quotaError)
  for (const sessionId of ['../session-a', '.', '..', 'a/b', 'a\\b']) {
    assert.equal(watchPromptOutcome({ root, sessionId })(NOW), null)
  }
  assert.equal(watchPromptOutcome({ root, directory: ['..'], sessionId: 'session-a' })(NOW), null)
  const other = path.join(dir, "other.db")
  fs.renameSync(file, other)
  fs.symlinkSync(other, file)
  assert.equal(watch()(NOW), null)
  fs.unlinkSync(file)
  fs.linkSync(other, file)
  assert.equal(watch()(NOW), null)
  fs.unlinkSync(file)
  fs.renameSync(other, file)
  fs.symlinkSync(file, file + '-wal')
  assert.equal(watch()(NOW), null)
  fs.unlinkSync(file + '-wal')
  fs.renameSync(dir, dir + '-real')
  fs.symlinkSync(dir + '-real', dir)
  assert.equal(watch()(NOW), null)
}))
test("another session and directory replacement cannot donate an error", () => fixture(({ file, dir, root, watch }) => {
  appendStep(file, 15, "ok")
  const before = watch()
  appendStep(path.join(dir, "session-b.db"), 17, quotaError)
  assert.equal(before(NOW), null)
  fs.renameSync(dir, dir + '-old')
  appendStep(file, 17, quotaError)
  assert.equal(before(NOW), null)
  assert.equal(watchPromptOutcome({ root: path.join(root, 'missing'), sessionId: 'a' })(NOW), null)
}))


test("unknown schema and exclusive writer locks do not block requests", () => fixture(({ file, watch }) => {
  appendStep(file, 15, "ok")
  const before = watch()
  const db = openFixtureDatabase(file)
  try {
    db.exec("BEGIN EXCLUSIVE")
    const started = performance.now()
    assert.equal(before(NOW), null)
    assert.equal(watch()(NOW), null)
    assert.ok(performance.now() - started < 500, "database reader must not wait for a writer lock")
    db.exec("ROLLBACK")
    db.exec("DROP TABLE steps; CREATE TABLE steps (idx INTEGER PRIMARY KEY, unknown_field TEXT)")
    const incompatible = watch()
    db.exec("INSERT INTO steps VALUES (1, 'unknown')")
    assert.equal(incompatible(NOW), null)
  } finally { db.close() }
}))
test("live WAL reads include the writer's committed error", () => fixture(({ file, watch }) => {
  appendStep(file, 15, "ok", { wal: true })
  const db = openFixtureDatabase(file)
  try {
    db.exec("PRAGMA journal_mode=WAL")
    const before = watch()
    const stmt = db.prepare("INSERT INTO steps (step_type, status, step_payload) VALUES (17, 3, ?)")
    try { stmt.run(Buffer.from(quotaError)) } finally { stmt.finalize?.() }
    assert.equal(before(NOW).status, 429)
  } finally { db.close() }
}))

test("a terminal error step with no payload still fails generically", () => fixture(({ file, watch }) => {
  appendStep(file, 15, "ok")
  const before = watch()
  const db = openFixtureDatabase(file)
  try { db.exec("INSERT INTO steps (step_type, status, step_payload) VALUES (17, 3, NULL)") } finally { db.close() }
  assert.equal(before(NOW)?.status, 502)
  assert.equal(before(NOW)?.resetAt, undefined)
}))

test("CLI reset notices preserve explicit durations without guessing malformed ones", () => {
  assert.equal(recoveryTime("Third-party quota reached. Resets in 1h2m3.5s.", NOW), iso(3723500))
  assert.equal(recoveryTime("Individual quota reached. Resets in 1500ms.", NOW), iso(1500))
  assert.equal(recoveryTime("retryDelay:3s Resets in 1h.", NOW), iso(3000))
  for (const tail of ["soon", "-1s", "0s", "1sfoo", "1h-2s", "1s.5", "999999999999999999999h"]) {
    assert.equal(recoveryTime("Resets in " + tail, NOW), null, tail)
  }
})

test("native 1.5 status lines and HTTP status descriptions keep the actual failure", () => {
  for (const [text, status, code] of [
    ["PERMISSION_DENIED (code 403): Access denied.", 403, "PERMISSION_DENIED"],
    ["RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 4m42s.", 429, "RESOURCE_EXHAUSTED"],
    ["Error 502, Message: Bad Gateway, Status: 502 Bad Gateway", 502, "502 Bad Gateway"],
    ["Error 403, Message: incomplete Error 503, Message: Busy, Status: UNAVAILABLE", 503, "UNAVAILABLE"],
  ]) {
    const result = parseErrorStep(payload(text), NOW)
    assert.equal(result.status, status)
    assert.equal(result.code, code)
    assert.equal(result.noRetry, status === 403 ? true : undefined)
    if (status === 429) assert.equal(result.resetAt, iso(282000))
    assert.doesNotMatch(result.message, /incomplete/)
  }
})
const verificationError = (info = {}) => ({ error: { code: 403, status: "PERMISSION_DENIED", details: [{
  "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "cloudcode-pa.googleapis.com", reason: "VALIDATION_REQUIRED",
  metadata: { validation_url: 'https://untrusted.example/secret?x="}\\', refresh_token: "must-not-echo" }, ...info,
}] } })
test("structured verification is non-retryable, bounded, and never a TOS ban or URL echo", () => {
  const text = 'native failed: ' + JSON.stringify(verificationError(), null, 2) + '\nstack trace'
  const result = parseErrorStep(payload(text), NOW)
  assert.equal(result.status, 403)
  assert.equal(result.code, "VALIDATION_REQUIRED")
  assert.equal(result.noRetry, true)
  assert.equal(result.resetAt, undefined)
  assert.doesNotMatch(result.message, /untrusted|must-not-echo|stack trace/)
  for (const info of [{ domain: "untrusted.example" }, { reason: "OTHER" }, { "@type": "other" }]) {
    const generic = parseErrorStep(payload(JSON.stringify(verificationError(info))), NOW)
    assert.equal(generic.status, 403)
    assert.equal(generic.code, "PERMISSION_DENIED")
  }
  assert.equal(parseErrorStep(payload('x'.repeat(16384) + text), NOW).code, "AGY_TURN_FAILED")
  assert.equal(parseErrorStep(payload('{"error": incomplete'), NOW).code, "AGY_TURN_FAILED")
  const suspended = verificationError({ reason: "TOS_VIOLATION" })
  assert.equal(parseErrorStep(payload(text + JSON.stringify(suspended)), NOW).code, "TOS_VIOLATION")
})
