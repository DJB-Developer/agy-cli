// Quota refresh is local status only. Do not query Google internal APIs or
// fall back to CLI /usage, background prompts, or OAuth refreshes.
// See T3 Code PR #43026 (96423cb5e2614eeb7a033cc7b755795d88a9158a).
export function createUsageReader({ serviceStatus } = {}) {
  return async () => {
    if (serviceStatus?.get()) return serviceStatus.usage()
    return {
      windows: [],
      error: "Antigravity quota and plan queries are unavailable. Internal API queries are disabled; chat authentication is unchanged. Per-turn token usage is still reported.",
      signIn: "kept",
    }
  }
}
