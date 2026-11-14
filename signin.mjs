import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// What agy's own sign-in looks like on this computer, read without running
// agy. agy keeps its Google token in the system keyring through go-keyring,
// under service "gemini" and user "antigravity": on macOS a generic
// password `security` wrote (so `security` reads it back without a prompt),
// on Windows the generic credential "gemini:antigravity" in Credential
// Manager. The value is JSON (on macOS behind "go-keyring-base64:"):
//   {"token":{"access_token","refresh_token","expiry","expires_in","token_type"},
//    "auth_method":"consumer","id_token_email":…}
// Headless Linux without D-Bus uses the same JSON in
// ~/.gemini/antigravity-cli/antigravity-oauth-token instead.
//
// Why this exists: an agy that isn't signed in, or whose sign-in Google no
// longer takes, starts its own Google sign-in when it runs, and on Windows
// it opens the browser through ShellExecuteW, which no BROWSER or PATH
// shim can stop. The usage refresh ran agy every few minutes, and a
// signed-out agy opened the browser 235 times in one day
// (JZGiVvkSOA75376 on X). So agy is not run for background work while
// this says it can't be signed in.
//
// state:
//   "missing"  no sign-in is stored: agy is not signed in.
//   "present"  one is: fp tells this sign-in from the next (a hash, never
//              the token), canRenew whether it has a refresh token, and
//              expiresAt when its access token ends (0: not said).
//   "unknown"  it couldn't be read (another OS, a locked keychain, a
//              format agy may change to): nothing is concluded from it.

const SERVICE = "gemini"
const USER = "antigravity"
const READ_TIMEOUT_MS = 10_000
// A sign-in is read again after this long; reading it on Windows starts
// PowerShell, so a burst of requests and listings shares one read.
const CACHE_MS = 30_000
// Sign-ins agy takes from its environment rather than the keyring: a Gemini
// or Google API key, Application Default Credentials, Vertex AI.
const ENV_SIGN_INS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GENAI_USE_VERTEXAI"]

// agy itself uses this file on headless Linux without a D-Bus session.
// Keep reads, imports and rollback on the same store. A desktop keyring
// failure must not silently switch to a different account in a file.
function credentialStore(platform, env, home, exec) {
  if (platform !== "linux" || env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR) {
    return {
      name: "system keyring",
      read: () => readRawSignIn(platform, exec),
      write: raw => writeRawSignIn(raw, platform, exec),
      encoded: raw => keyringValue(raw, platform),
    }
  }
  const file = path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")
  return {
    name: "credential file (~/.gemini/antigravity-cli/antigravity-oauth-token)",
    encoded: raw => raw,
    async read() {
      try { return { state: "present", raw: await fs.readFile(file, "utf8") } }
      catch (error) { return { state: error.code === "ENOENT" ? "missing" : "unknown" } }
    },
    async write(raw) {
      if (raw === null) {
        try { await fs.unlink(file); return true }
        catch (error) { return error.code === "ENOENT" }
      }
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        // Publish only a complete owner-readable credential; an existing
        // file (including a symlink) is replaced, never truncated in place.
        const handle = await fs.open(temporary, "wx", 0o600)
        try { await handle.writeFile(raw, "utf8"); await handle.sync() }
        finally { await handle.close() }
        await fs.rename(temporary, file)
        return true
      } catch { return false }
      finally { await fs.unlink(temporary).catch(() => {}) }
    },
  }
}

// PowerShell reads the credential through CredReadW. CREDENTIALW is
// Flags, Type, TargetName, Comment, LastWritten (8 bytes),
// CredentialBlobSize, CredentialBlob: the blob's size and pointer offsets
// follow the pointer size.
export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace MagpieAgy -Name Cred -MemberDefinition @'
[DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
[DllImport("advapi32.dll", EntryPoint = "CredFree")]
public static extern void CredFree(IntPtr cred);
'@
$p = [IntPtr]::Zero
if (-not [MagpieAgy.Cred]::CredRead('${SERVICE}:${USER}', 1, 0, [ref]$p)) {
  $e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($e -eq 1168) { 'MISSING' } else { "ERROR $e" }
  exit 0
}
try {
  $ptr = [IntPtr]::Size
  $sizeAt = 8 + 2 * $ptr + 8
  $blobAt = $sizeAt + 4
  if ($blobAt % $ptr) { $blobAt += $ptr - ($blobAt % $ptr) }
  $size = [Runtime.InteropServices.Marshal]::ReadInt32($p, $sizeAt)
  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($p, $blobAt)
  $bytes = New-Object byte[] $size
  if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size) }
  'OK ' + [Convert]::ToBase64String($bytes)
} finally { [MagpieAgy.Cred]::CredFree($p) }
`

function run(file, args, input) {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }))
      child?.stdin?.on("error", () => {})
      child?.stdin?.end(input)
    } catch {
      resolve({ code: -1, stdout: "" })
    }
  })
}

// Use the same native stores as go-keyring. Secrets travel on stdin, never
// in a shell command, process arguments, or a plugin account record.
const WINDOWS_WRITE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MagpieAgyWrite {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool Delete(string target, uint type, uint flags);
}
'@
$inputValue = [Console]::In.ReadToEnd().Trim()
if ($inputValue -eq 'DELETE') {
  if (-not [MagpieAgyWrite]::Delete('${SERVICE}:${USER}', 1, 0)) { exit 1 }
  exit 0
}
$bytes = [Convert]::FromBase64String($inputValue)
$c = New-Object MagpieAgyWrite+Credential
$c.Type = 1
$c.TargetName = '${SERVICE}:${USER}'
$c.UserName = '${USER}'
$c.Persist = 2
$c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $c.CredentialBlob, $bytes.Length)
  if (-not [MagpieAgyWrite]::Write([ref]$c, 0)) { exit 1 }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($c.CredentialBlob) }
`

async function readRawSignIn(platform, exec) {
  if (platform === "darwin") {
    const r = await exec("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", USER, "-w"])
    return r.code === 44 ? { state: "missing" } : r.code === 0
      ? { state: "present", raw: r.stdout.trim() } : { state: "unknown" }
  }
  if (platform === "win32") {
    const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT])
    const out = r.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
    if (r.code !== 0) return { state: "unknown" }
    if (out === "MISSING") return { state: "missing" }
    return out.startsWith("OK ") ? { state: "present", raw: Buffer.from(out.slice(3), "base64").toString("utf8") } : { state: "unknown" }
  }
  if (platform === "linux") {
    const r = await exec("secret-tool", ["lookup", "service", SERVICE, "username", USER])
    if (r.code === 0) return { state: "present", raw: r.stdout.trim() }
    if (r.code === 1 && !r.stdout.trim() && !r.stderr?.trim()) return { state: "missing" }
  }
  return { state: "unknown" }
}

function keyringValue(raw, platform) {
  if (platform !== "darwin" || raw.startsWith("go-keyring-base64:") || raw.startsWith("go-keyring-encoded:")) return raw
  return "go-keyring-base64:" + Buffer.from(raw).toString("base64")
}

async function writeRawSignIn(raw, platform, exec) {
  let r
  if (platform === "darwin") {
    if (raw === null) r = await exec("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", USER])
    else {
      // The value is encoded before it enters security's command parser.
      const value = keyringValue(raw, platform)
      if (!/^go-keyring-(?:base64:[A-Za-z0-9+/=]*|encoded:[a-fA-F0-9]*)$/.test(value)) return false
      const command = `add-generic-password -U -s ${SERVICE} -a ${USER} -w ${value}\n`
      if (Buffer.byteLength(command) > 4096) return false
      r = await exec("/usr/bin/security", ["-i"], command)
    }
  } else if (platform === "win32") {
    r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_WRITE_SCRIPT],
      raw === null ? "DELETE" : Buffer.from(raw).toString("base64"))
  } else if (platform === "linux") {
    r = raw === null
      ? await exec("secret-tool", ["clear", "service", SERVICE, "username", USER])
      : await exec("secret-tool", ["store", "--label=Antigravity CLI", "--collection=login", "service", SERVICE, "username", USER], raw)
  }
  return r?.code === 0
}

export function parseRefreshToken(input) {
  const text = typeof input === "string" ? input.trim() : ""
  let token = text
  if (/^[{\[\"]/.test(text)) {
    let value
    try { value = JSON.parse(text) } catch { throw new Error("Paste a refresh token or valid account JSON.") }
    token = value?.token?.refresh_token ?? value?.refresh_token
  }
  if (typeof token !== "string" || !token.trim() || /[\s\x00-\x1f\x7f"{}\[\]]/.test(token.trim())) {
    throw new Error("Paste one refresh token, or an account JSON containing refresh_token.")
  }
  return token.trim()
}

let importing = false

// agy does the exchange using its own OAuth client. If it cannot use the
// imported credential, restore the previous credential (or remove ours).
export async function importRefreshToken(input, { probe, platform = process.platform, exec = run, env = process.env, home = os.homedir() } = {}) {
  let refreshToken
  try { refreshToken = parseRefreshToken(input) } catch (error) { return { error: error.message } }
  if (importing) return { error: "An account import is already in progress." }
  if (ENV_SIGN_INS.some(name => env[name])) return { error: "Remove agy's API key, ADC or Vertex environment authentication before importing a refresh token." }
  if (typeof probe !== "function") return { error: "An agy sign-in check is required." }
  importing = true
  const store = credentialStore(platform, env, home, exec)
  let previous
  let written = false
  try {
    previous = await store.read()
    if (previous.state === "unknown") return { error: `Could not read agy's ${store.name}. ${store.name === "system keyring"
      ? "Unlock it and check access for the running user; desktop Linux also needs secret-tool and a Secret Service login collection."
      : "Check file and HOME volume permissions for the user running Magpie."}` }
    const raw = JSON.stringify({ token: { access_token: "", refresh_token: refreshToken, token_type: "Bearer", expiry: "2000-01-01T00:00:00Z" }, auth_method: "consumer" })
    if (!await store.write(raw)) return { error: `Could not store the refresh token in agy's ${store.name}.` }
    written = true
    const saved = await store.read()
    const expected = store.encoded(raw)
    if (saved.state !== "present" || saved.raw !== expected) throw new Error("keyring write was not retained")
    forgetStoredSignIn({ dead: true })
    const result = await probe()
    if (result?.ok) return { ok: true }
    throw new Error("probe failed")
  } catch {
    // Neither subprocess output nor probe errors may echo the credential.
    if (!written) return { error: `Could not access agy's ${store.name}.` }
    let restored = false
    try {
      if (await store.write(previous.state === "present" ? previous.raw : null)) {
        const current = await store.read()
        restored = previous.state === "missing" ? current.state === "missing"
          : current.state === "present" && current.raw === store.encoded(previous.raw)
      }
    } catch {}
    return { error: restored
      ? "agy could not use this refresh token. Check the token, its OAuth client and network access. The previous sign-in was restored."
      : "agy could not use this refresh token, and the previous sign-in could not be restored. Sign in again." }
  } finally {
    forgetStoredSignIn()
    importing = false
  }
}

// parseStored is what a stored value says, "unknown" when it isn't the
// shape agy writes.
export function parseStored(raw, now = Date.now()) {
  let value = String(raw ?? "").trim()
  const fp = createHash("sha256").update(value).digest("hex").slice(0, 32)
  if (value.startsWith("go-keyring-base64:")) {
    value = Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8")
  } else if (value.startsWith("go-keyring-encoded:")) {
    value = Buffer.from(value.slice("go-keyring-encoded:".length), "hex").toString("utf8")
  }
  let stored
  try { stored = JSON.parse(value) } catch { return { state: "unknown" } }
  // a Gemini API key needs no Google sign-in
  if (typeof stored?.api_key === "string" && stored.api_key !== "") return { state: "unknown" }
  const token = stored?.token
  if (!token || typeof token !== "object") return { state: "unknown" }
  const canRenew = typeof token.refresh_token === "string" && token.refresh_token !== ""
  const hasAccess = typeof token.access_token === "string" && token.access_token !== ""
  if (!canRenew && !hasAccess) return { state: "missing" }
  const at = Date.parse(token.expiry ?? "")
  // Go's zero time (0001-01-01) is "doesn't end"
  const expiresAt = Number.isFinite(at) && at > 0 ? at : 0
  return { state: "present", fp, canRenew, expiresAt, expired: expiresAt > 0 && now >= expiresAt }
}

// readStoredSignIn reads agy's stored sign-in on this computer.
export async function readStoredSignIn({ platform = process.platform, exec = run, now = Date.now(), env = process.env, home = os.homedir() } = {}) {
  // tests, and setups this reading doesn't fit, turn it off
  if (env.AGY_BRIDGE_STORED_SIGNIN === "skip") return { state: "unknown" }
  // agy signs in with these instead of a stored Google sign-in
  if (ENV_SIGN_INS.some((name) => env[name])) return { state: "unknown" }
  const s = await credentialStore(platform, env, home, exec).read()
  return s.state === "present" ? parseStored(s.raw, now) : s
}

// cannotSignIn is why a stored sign-in can't serve agy without a new
// Google sign-in, or "" when it may.
export function cannotSignIn(s) {
  if (s?.state === "missing") return "agy isn't signed in"
  if (s?.state === "present" && !s.canRenew && s.expired) return "agy's sign-in has expired"
  return ""
}

// Sign-ins agy was found unable to use (a run it failed in a way only a
// new sign-in mends), by fp: agy isn't run in the background for them
// again; signing in again stores another and so another fp.
const dead = new Set()

export function noteDead(s) {
  if (s?.state === "present" && s.fp) dead.add(s.fp)
}

export function isDead(s) {
  return s?.state === "present" && dead.has(s.fp)
}

let cached = null
let reading = null

// storedSignIn is readStoredSignIn, shared for CACHE_MS and while one read
// is under way.
export async function storedSignIn({ read = readStoredSignIn, fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  if (!reading) {
    const r = Promise.resolve().then(() => read()).catch(() => ({ state: "unknown" })).then((value) => {
      if (reading === r) {
        cached = { at: Date.now(), value }
        reading = null
      }
      return value
    })
    reading = r
  }
  return reading
}

// storedSignInNow is the last read without waiting for one (null before
// the first), starting a new read when it is old: a request isn't held up
// by a keyring read (on Windows, PowerShell).
export function storedSignInNow({ read = readStoredSignIn } = {}) {
  if (!cached || Date.now() - cached.at >= CACHE_MS) storedSignIn({ read }).catch(() => {})
  return cached?.value ?? null
}

// backgroundBlocked is why agy must not be run for work nobody asked for
// (a usage read, a model listing): its sign-in can't serve it and running
// it would start a Google sign-in. "" when it may run.
export async function backgroundBlocked(opts) {
  const s = await storedSignIn(opts)
  return cannotSignIn(s) || (isDead(s) ? "agy's sign-in no longer works" : "")
}

// forgetStoredSignIn drops the cached read (after a sign-in, and in tests).
export function forgetStoredSignIn({ dead: clearDead = false } = {}) {
  cached = null
  reading = null
  if (clearDead) dead.clear()
}
