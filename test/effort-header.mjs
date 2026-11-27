import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

for (const [name, body, header, expected, requestObject = false, env = {}] of [
  ["header beats a clipped budget", { thinking: { type: "enabled", budget_tokens: 3000 } }, "high", "high"],
  ["header works without thinking", {}, "low", "low"],
  ["disabled thinking ignores header", { thinking: { type: "disabled" } }, "low", "high"],
  ["invalid header falls back to budget", { thinking: { type: "enabled", budget_tokens: 3000 } }, "invalid", "low"],
  ["inline model level beats budget", { model: "agy-cli/gemini-3.5-pro-medium", thinking: { type: "enabled", budget_tokens: 30000 } }, "", "medium"],
  ["Request headers reach routing", {}, " LOW ", "low", true],
  ["forced environment level wins", {}, "low", "high", false, { AGY_BRIDGE_EFFORT: "high" }],
]) {
  test(name, async () => {
    const kit = await createBridgeKit({ platform: "linux", env })
    try {
      kit.defaultPrompt = async agent => { await agent.text("ok"); return { stopReason: "end_turn" } }
      const payload = baseBody({ model: "agy-cli/gemini-4-argon", ...body })
      const headers = { "X-Magpie-Effort": header }
      const response = requestObject
        ? await kit.fetch(new Request("https://example.invalid/v1/messages", { method: "POST", headers, body: JSON.stringify(payload) }))
        : await kit.request(payload, { headers })
      const result = await readSse(response)
      assert.equal(result.error, null, JSON.stringify(result.error))
      assert.equal(kit.setModels.at(-1), `gemini-4-argon-${expected}`)
    } finally { await kit.dispose() }
  })
}
