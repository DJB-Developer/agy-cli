import assert from "node:assert/strict"
import { test } from "node:test"
import { backgroundBlocked, cannotSignIn, forgetStoredSignIn, importRefreshToken, isDead, noteDead, parseRefreshToken, parseStored, readStoredSignIn, storedSignIn, storedSignInNow } from "../signin.mjs"

const NOW = Date.parse("2026-11-13T00:00:00Z")
const stored = (token, extra = {}) => JSON.stringify({ token, auth_method: "consumer", id_token_email: "someone@example.com", ...extra })
const b64 = (s) => "go-keyring-base64:" + Buffer.from(s).toString("base64")

test("reads what agy's keyring value says, on macOS (base64) and Windows (raw JSON)", () => {
  const renewable = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T13:00:00Z", token_type: "Bearer" })
  for (const raw of [b64(renewable), renewable]) {
    const s = parseStored(raw, NOW)
    assert.equal(s.state, "present")
    assert.equal(s.canRenew, true)
    assert.equal(s.expired, true)
    assert.match(s.fp, /^[0-9a-f]{32}$/)
    assert.doesNotMatch(JSON.stringify(s), /someone|"a"|"r"/)
    // an ended access token with a refresh token is how a working agy looks
    assert.equal(cannotSignIn(s), "")
  }
  assert.notEqual(parseStored(renewable, NOW).fp, parseStored(stored({ refresh_token: "r2" }), NOW).fp)
})

test("an ended sign-in with nothing to renew it, or no token at all, can't sign agy in", () => {
  const ended = parseStored(b64(stored({ access_token: "a", expiry: "2026-11-12T00:00:00Z" })), NOW)
  assert.equal(ended.state, "present")
  assert.match(cannotSignIn(ended), /expired/)
  const live = parseStored(stored({ access_token: "a", expiry: "2026-11-14T00:00:00Z" }), NOW)
  assert.equal(cannotSignIn(live), "")
  // Go's zero time: doesn't end
  const zero = parseStored(stored({ access_token: "a", expiry: "0001-01-01T00:00:00Z" }), NOW)
  assert.equal(zero.expired, false)
  assert.equal(cannotSignIn(zero), "")
  assert.equal(parseStored(stored({ access_token: "", refresh_token: "" }), NOW).state, "missing")
  assert.match(cannotSignIn({ state: "missing" }), /isn't signed in/)
})

test("a value of another shape, or an API key, concludes nothing", () => {
  for (const raw of ["", "garbage", b64("not json"), JSON.stringify({ hello: 1 }), stored(undefined, { api_key: "k" }), stored({}, { api_key: "k" })]) {
    const s = parseStored(raw, NOW)
    assert.equal(s.state, "unknown", raw)
    assert.equal(cannotSignIn(s), "")
  }
})

test("readStoredSignIn asks each system's keyring the way go-keyring stores it", async () => {
  const value = stored({ access_token: "a", refresh_token: "r", expiry: "2026-11-12T00:00:00Z" })
  const calls = []
  const mac = (code, stdout = "") => async (file, args) => { calls.push([file, ...args]); return { code, stdout } }
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44), env: {} })).state, "missing")
  assert.deepEqual(calls[0], ["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"])
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(51), env: {} })).state, "unknown")
  assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(0, b64(value) + "\n"), now: NOW, env: {} })).state, "present")
  const win = (stdout, code = 0) => async (file, args) => { calls.push([file, ...args]); return { code, stdout } }
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("MISSING\r\n"), env: {} })).state, "missing")
  assert.match(calls.at(-1).at(-1), /CredReadW[\s\S]*'gemini:antigravity'/)
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("WARNING: something\r\nMISSING\r\n"), env: {} })).state, "missing")
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("ERROR 5\r\n"), env: {} })).state, "unknown")
  assert.equal((await readStoredSignIn({ platform: "win32", exec: win("", 1), env: {} })).state, "unknown")
  const w = await readStoredSignIn({ platform: "win32", exec: win("OK " + Buffer.from(value).toString("base64") + "\r\n"), now: NOW, env: {} })
  assert.equal(w.state, "present")
  assert.equal(w.canRenew, true)
  assert.equal((await readStoredSignIn({ platform: "linux", exec: mac(0, value), env: {} })).state, "present")
  assert.deepEqual(calls.at(-1), ["secret-tool", "lookup", "service", "gemini", "username", "antigravity"])
  assert.equal((await readStoredSignIn({ platform: "linux", exec: mac(1), env: {} })).state, "missing")
  assert.equal((await readStoredSignIn({ platform: "linux", exec: async () => ({ code: 1, stdout: "", stderr: "no session bus" }), env: {} })).state, "unknown")
  const before = calls.length
  for (const env of [{ AGY_BRIDGE_STORED_SIGNIN: "skip" }, { GEMINI_API_KEY: "k" }, { AGY_ADC_AUTH: "1" }]) {
    assert.equal((await readStoredSignIn({ platform: "darwin", exec: mac(44), env })).state, "unknown")
  }
  assert.equal(calls.length, before)
})

test("one read serves a burst; a dead sign-in blocks background runs until another is stored", async () => {
  forgetStoredSignIn({ dead: true })
  let reads = 0
  let value = { state: "present", fp: "one", canRenew: true, expiresAt: 0, expired: false }
  const read = async () => { reads++; return value }
  await Promise.all([storedSignIn({ read }), storedSignIn({ read }), storedSignIn({ read })])
  assert.equal(reads, 1)
  assert.equal(await backgroundBlocked({ read }), "")
  noteDead(value)
  assert.ok(isDead(value))
  assert.match(await backgroundBlocked({ read }), /no longer works/)
  value = { ...value, fp: "two" }
  assert.equal(await backgroundBlocked({ read, fresh: true }), "")
  value = { state: "missing" }
  assert.match(await backgroundBlocked({ read, fresh: true }), /isn't signed in/)
  forgetStoredSignIn({ dead: true })
  assert.equal(isDead({ state: "present", fp: "one" }), false)
})

test("storedSignInNow answers from the last read without waiting, and reads again when it is old", async () => {
  forgetStoredSignIn({ dead: true })
  let reads = 0
  let release
  const read = () => { reads++; return new Promise((r) => { release = r }) }
  assert.equal(storedSignInNow({ read }), null)
  assert.equal(storedSignInNow({ read }), null)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(reads, 1)
  release({ state: "missing" })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(storedSignInNow({ read }), { state: "missing" })
  assert.equal(reads, 1)
  forgetStoredSignIn({ dead: true })
})

test("refresh-token input accepts one token or an account export and rejects malformed input", () => {
  for (const input of ["  1//test-token \n", '{"refresh_token":"1//test-token"}', '{"token":{"refresh_token":"1//test-token","access_token":"ignored"}}']) {
    assert.equal(parseRefreshToken(input), "1//test-token")
  }
  for (const input of [undefined, "", "\n", "one\ntwo", "one two", '{"refresh_token":', "{}", "[]", '{"refresh_token":123}', '{"token":{"refresh_token":""}}']) {
    assert.throws(() => parseRefreshToken(input), /Paste/)
  }
})

function keyring(platform, initial = null) {
  let raw = initial
  const calls = []
  return {
    calls,
    get raw() { return raw },
    async exec(file, args, input) {
      calls.push({ file, args, input })
      if (input !== undefined || args[0] === "delete-generic-password" || args[0] === "clear") {
        if (platform === "darwin") raw = input ? input.match(/ -w (\S+)\n$/)[1] : null
        if (platform === "win32") raw = input === "DELETE" ? null : Buffer.from(input, "base64").toString("utf8")
        if (platform === "linux") raw = input ?? null
        return { code: 0, stdout: "" }
      }
      if (platform === "darwin") return { code: raw === null ? 44 : 0, stdout: raw ?? "" }
      if (platform === "win32") return { code: 0, stdout: raw === null ? "MISSING" : "OK " + Buffer.from(raw).toString("base64") }
      return { code: raw === null ? 1 : 0, stdout: raw ?? "" }
    },
  }
}

test("imports into agy's native store on each platform, validates, and never puts tokens in args", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const store = keyring(platform)
    await storedSignIn({ read: async () => ({ state: "missing" }) })
    let probes = 0
    const result = await importRefreshToken("1//private-token", { platform, exec: store.exec, env: {}, probe: async () => {
      probes++
      assert.equal(parseStored(store.raw).canRenew, true)
      assert.equal(parseStored(store.raw).expired, true)
      assert.equal(await backgroundBlocked({ read: () => readStoredSignIn({ platform, exec: store.exec, env: {} }) }), "")
      return { ok: true }
    } })
    assert.deepEqual(result, { ok: true })
    assert.equal(probes, 1)
    const write = store.calls.find(call => call.input !== undefined)
    assert.doesNotMatch(JSON.stringify(store.calls.map(({ file, args }) => ({ file, args }))), /private-token/)
    const raw = platform === "darwin" ? Buffer.from(store.raw.slice("go-keyring-base64:".length), "base64").toString() : store.raw
    assert.deepEqual(JSON.parse(raw), { token: { access_token: "", refresh_token: "1//private-token", token_type: "Bearer", expiry: "2000-01-01T00:00:00Z" }, auth_method: "consumer" })
    if (platform === "darwin") assert.deepEqual(write.args, ["-i"])
    if (platform === "win32") assert.match(write.args.at(-1), /CredWriteW/)
    if (platform === "linux") assert.deepEqual(write.args, ["store", "--label=Antigravity CLI", "--collection=login", "service", "gemini", "username", "antigravity"])
  }
})

test("a refused or throwing probe restores the previous credential or removes a new entry", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    for (const initial of [null, platform === "darwin" ? b64(stored({ refresh_token: "old" })) : stored({ refresh_token: "old" })]) {
      for (const throws of [false, true]) {
        const store = keyring(platform, initial)
        const result = await importRefreshToken("private-token", { platform, exec: store.exec, env: {}, probe: async () => {
          if (throws) throw new Error("private-token")
          return { ok: false, why: "private-token" }
        } })
        assert.match(result.error, /previous sign-in was restored/)
        assert.doesNotMatch(result.error, /private-token/)
        assert.equal(store.raw, initial)
      }
    }
  }
})

test("bad input, unavailable stores, and environment auth cannot overwrite credentials", async () => {
  let calls = 0
  let probes = 0
  const opts = { platform: "darwin", exec: async () => { calls++; return { code: 51, stdout: "" } }, env: {}, probe: async () => { probes++; return { ok: true } } }
  assert.match((await importRefreshToken("", opts)).error, /Paste/)
  assert.match((await importRefreshToken("token", { ...opts, env: { GEMINI_API_KEY: "key" } })).error, /environment/)
  assert.equal(calls, 0)
  assert.match((await importRefreshToken("token", opts)).error, /Could not read/)
  assert.equal(calls, 1)
  assert.equal(probes, 0)
})

test("write and rollback failures are reported without exposing subprocess output", async () => {
  const store = keyring("linux")
  let writes = 0
  const exec = async (file, args, input) => {
    if (input !== undefined || args[0] === "clear") {
      writes++
      if (writes > 1) return { code: 1, stdout: "private-token" }
    }
    return store.exec(file, args, input)
  }
  const result = await importRefreshToken("private-token", { platform: "linux", exec, env: {}, probe: async () => ({ ok: false }) })
  assert.match(result.error, /could not be restored/)
  assert.doesNotMatch(result.error, /private-token/)
  const failed = await importRefreshToken("private-token", { platform: "linux", exec, env: {}, probe: async () => { assert.fail("must not probe a failed write") } })
  assert.match(failed.error, /Could not store/)
})

test("concurrent imports cannot overwrite one another", async () => {
  const store = keyring("linux")
  let release
  let started
  const probing = new Promise(resolve => { started = resolve })
  const first = importRefreshToken("first", { platform: "linux", exec: store.exec, env: {}, probe: () => {
    started()
    return new Promise(resolve => { release = resolve })
  } })
  await probing
  assert.match((await importRefreshToken("second", { platform: "linux", exec: store.exec, env: {}, probe: async () => ({ ok: true }) })).error, /already in progress/)
  release({ ok: true })
  assert.deepEqual(await first, { ok: true })
  assert.equal(JSON.parse(store.raw).token.refresh_token, "first")
})

test("a command reporting success without retaining the token cannot validate the old account", async () => {
  const initial = b64(stored({ refresh_token: "old" }))
  let probes = 0
  const result = await importRefreshToken("new", {
    platform: "darwin", env: {},
    exec: async (_file, args) => ({ code: 0, stdout: args[0] === "find-generic-password" ? initial : "" }),
    probe: async () => { probes++; return { ok: true } },
  })
  assert.match(result.error, /previous sign-in was restored/)
  assert.equal(probes, 0)
})
