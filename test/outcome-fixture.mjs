import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
let Database
try { Database = require("bun:sqlite").Database } catch { Database = require("node:sqlite").DatabaseSync }
export function appendStep(file, type, text, { wal = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  try {
    if (wal) db.exec("PRAGMA journal_mode=WAL")
    db.exec("CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)")
    const stmt = db.prepare("INSERT INTO steps (step_type, status, step_payload) VALUES (?, 3, ?)")
    try { stmt.run(type, Buffer.from(text)) } finally { stmt.finalize?.() }
  } finally { db.close() }
}
export const quotaError = "agent executor error: Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[reason:QUOTA_EXHAUSTED metadata:map[quotaResetDelay:1h2m3.5s]] map[retryDelay:42s]]"

export const openFixtureDatabase = file => new Database(file)
