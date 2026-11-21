// Named profiles follow DylanLIiii/opencode-antigravity-bridge's native
// --gemini_dir + file-storage approach (MIT; see LICENSE and NOTICE.md).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseRefreshToken, parseStored } from "./signin.mjs"

export const DEFAULT_ACCOUNT = Object.freeze({ name: null, dir: null })
const ENV_AUTH = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_GENAI_USE_VERTEXAI"]

export function accountsRoot(env = process.env) {
  return path.resolve(env.AGY_BRIDGE_ACCOUNTS_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie-agy-cli", "accounts"))
}

export function accountName(input) {
  const name = String(input ?? "").trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || /^(?:default|con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name)) {
    throw new Error("Choose an account name of 1–64 letters, digits, underscores or hyphens (not default).")
  }
  return name.toLowerCase()
}

export function accountEnv(env, account) {
  if (!account.dir) return env
  // agy's remote/WSL mode selects file storage even on a desktop with a
  // global keyring. Never mutate the host environment or inherit API auth.
  const out = { ...env, WSL_INTEROP: env.WSL_INTEROP || "1" }
  // spawnAgy merges its environment with process.env. Explicit empty values
  // prevent that merge from restoring machine-global API authentication.
  for (const key of Object.keys(out)) if (ENV_AUTH.includes(key.toUpperCase())) out[key] = ""
  for (const key of ENV_AUTH) out[key] = ""
  return out
}

export const accountArgs = account => account.dir ? [`--gemini_dir=${account.dir}`] : []
export const tokenFile = account => path.join(account.dir, "antigravity-cli", "antigravity-oauth-token")

export function accountSignIn(account) {
  try {
    const s = parseStored(fs.readFileSync(tokenFile(account), "utf8"))
    // Authentication backoff for one profile must not affect another.
    if (s.fp) s.fp = `${account.dir}:${s.fp}`
    return s
  } catch { return { state: "missing" } }
}

export function resolveAccount(auth, { allowMissing = false } = {}) {
  if (auth == null && allowMissing || auth?.type === "api" && auth.key === "agy") return DEFAULT_ACCOUNT
  if (auth?.type !== "api" || typeof auth.key !== "string" || !auth.key.startsWith("agy:")) {
    throw new Error("Select a saved agy-cli account or sign in again.")
  }
  let name
  try { name = accountName(decodeURIComponent(auth.key.slice(4))) } catch {
    throw new Error("Invalid agy-cli account reference. Sign in again.")
  }
  const account = { name, dir: path.join(accountsRoot(), name) }
  try {
    if (!fs.lstatSync(account.dir).isDirectory() || !fs.lstatSync(tokenFile(account)).isFile() ||
        fs.readFileSync(path.join(account.dir, ".ready"), "utf8") !== "1\n" || accountSignIn(account).state !== "present") throw new Error()
  } catch { throw new Error(`Saved agy-cli account "${name}" is missing or unreadable. Import it again with a new name.`) }
  return account
}

export function accountResult(account) {
  return account.dir ? { type: "success", key: `agy:${account.name}`, metadata: { email: account.name } }
    : { type: "success", key: "agy" }
}

// Reserve atomically: even two simultaneous imports must never overwrite a
// profile. Only .ready profiles can be used by gateway requests.
export function reserveAccount(input) {
  const name = accountName(input)
  const dir = path.join(accountsRoot(), name)
  fs.mkdirSync(accountsRoot(), { recursive: true, mode: 0o700 })
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Account "${name}" already exists on disk; removing its Magpie account row does not delete CLI credentials. To add it back, choose "Use a saved named account" and enter "${name}". To use a different refresh token, choose a new account name; existing credentials are never overwritten.`)
    throw new Error("Could not create the account directory. Check configuration volume permissions.")
  }
  return { name, dir }
}

export function writeAccountToken(account, input) {
  const refresh_token = parseRefreshToken(input)
  fs.mkdirSync(path.dirname(tokenFile(account)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(tokenFile(account), JSON.stringify({
    token: { access_token: "", refresh_token, token_type: "Bearer", expiry: "2000-01-01T00:00:00Z" },
    auth_method: "consumer",
  }), { flag: "wx", mode: 0o600 })
}

export function publishAccount(account) {
  if (accountSignIn(account).state !== "present") throw new Error("agy did not save a usable account credential.")
  fs.chmodSync(tokenFile(account), 0o600)
  fs.writeFileSync(path.join(account.dir, ".ready"), "1\n", { flag: "wx", mode: 0o600 })
  return accountResult(account)
}

export function discardAccount(account) {
  fs.rmSync(account.dir, { recursive: true, force: true })
}
