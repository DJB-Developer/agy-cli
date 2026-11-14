import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { importRefreshToken, readStoredSignIn } from "../signin.mjs"

async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-headless-signin-"))
  const file = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  const opts = { platform: "linux", env: {}, home, exec: async () => ({ code: -1, stdout: "", stderr: "" }) }
  try { await fn({ home, file, opts }) } finally { await fs.rm(home, { recursive: true, force: true }) }
}

test("Docker without secret-tool or D-Bus imports into agy's native token file", async () => {
  await withHome(async ({ file, opts }) => {
    let probes = 0
    const result = await importRefreshToken("1//headless-test-token", { ...opts, probe: async () => {
      probes++
      const saved = JSON.parse(await fs.readFile(file, "utf8"))
      assert.equal(saved.token.refresh_token, "1//headless-test-token")
      assert.equal(saved.auth_method, "consumer")
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
      assert.equal((await readStoredSignIn(opts)).canRenew, true)
      return { ok: true }
    } })
    assert.deepEqual(result, { ok: true })
    assert.equal(probes, 1)
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["antigravity-oauth-token"])
  })
})

test("failed file import restores previous credentials, or removes only the newly imported file", async () => {
  for (const previous of [null, '{"token":{"refresh_token":"previous"},"auth_method":"consumer"}\n']) {
    await withHome(async ({ file, opts }) => {
      if (previous) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, previous, { mode: 0o600 })
      }
      const result = await importRefreshToken("rejected", { ...opts, probe: async () => ({ ok: false }) })
      assert.match(result.error, /previous sign-in was restored/)
      if (previous) assert.equal(await fs.readFile(file, "utf8"), previous)
      else await assert.rejects(fs.stat(file), { code: "ENOENT" })
    })
  }
})

test("background checks recognize an existing headless file and an absent sign-in", async () => {
  await withHome(async ({ file, opts }) => {
    assert.deepEqual(await readStoredSignIn(opts), { state: "missing" })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{"token":{"refresh_token":"existing"}}')
    assert.equal((await readStoredSignIn(opts)).state, "present")
    assert.equal((await readStoredSignIn({ ...opts, env: { AGY_BRIDGE_STORED_SIGNIN: "skip" } })).state, "unknown")
  })
})

test("unreadable file storage is not overwritten or treated as a missing sign-in", async () => {
  await withHome(async ({ file, opts }) => {
    await fs.mkdir(file, { recursive: true })
    const result = await importRefreshToken("test", { ...opts, probe: async () => assert.fail("must not validate unreadable storage") })
    assert.match(result.error, /credential file/)
    assert.equal((await fs.stat(file)).isDirectory(), true)
  })
})

test("a desktop keyring error never imports over a different file credential", async () => {
  await withHome(async ({ file, opts }) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const previous = '{"token":{"refresh_token":"different-file-account"}}'
    await fs.writeFile(file, previous)
    for (const env of [{ DBUS_SESSION_BUS_ADDRESS: "unix:path=/test-bus" }, { XDG_RUNTIME_DIR: "/run/user/1000" }]) {
      const result = await importRefreshToken("new", { ...opts, env, probe: async () => assert.fail("must not bypass a desktop keyring") })
      assert.match(result.error, /system keyring/)
      assert.equal(await fs.readFile(file, "utf8"), previous)
    }
  })
})
