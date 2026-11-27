// Standalone regressions for agy-cli; cross-package parity belongs to the upstream monorepo.
import { expect, test } from "bun:test"
import { REWORDED, cloak, hint, outgoing, turnsAway } from "./cloak.mjs"

const samples = [
  "x-anthropic-billing-header: cc_version=2.1.0.abc; cc_entrypoint=cli; cch=1a2b3;",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Codex, an agent based on GPT-5. You are running as a coding agent.",
  "You are Codex, a coding agent based on GPT-5.",
  "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
  "RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\n\nYou are omp.",
  "Two: RFC 2119 KEYWORDS: must, required, should, recommended, may, optional. and x-anthropic-billing-header: x",
  "RFC 2119 keywords: MUST, REQUIRED,\r\nSHOULD, RECOMMENDED, MAY, OPTIONAL.\r\n",
  "<conventions>\nRFC 2119\nkeywords:\tMUST,  REQUIRED, SHOULD, RECOMMENDED, MAY,\u00a0OPTIONAL.\n</conventions>",
  "You are Hermes Agent, an intelligent\nAI assistant created by Nous Research.",
  "RFC 2119 keywords: MUST,REQUIRED,SHOULD,RECOMMENDED,MAY,OPTIONAL.",
  "You are Hermes Agent, built by Nous Research.",
  "You are OpenCode, a coding agent that helps users with software engineering tasks.",
  "You are opencode, an interactive CLI tool that helps users with software engineering tasks.",
  "You are OpenCode, the best coding agent on the planet.",
  "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.",
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.",
  "Codex's GPT-6 prompt goes as written: You are Codex, an agent based on GPT-6.",
  "You're Hermes Agent, an intelligent AI assistant created by Nous Research.",
  "Nothing to see here; Claude Agent SDK alone is fine.",
  "",
]

test("every turned-away line is reworded, with no invisible character in it", () => {
  for (const s of samples) {
    const out = cloak(s)
    expect(out).not.toMatch(/[\u00ad\u200b-\u200f\u2060-\u2064]/)
    if (turnsAway(s)) {
      expect(out).not.toBe(s)
      expect(turnsAway(out)).toBe(false)
    } else {
      expect(out).toBe(s)
    }
  }
  expect(cloak("RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.")).toBe(
    "RFC 2119 key words: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.",
  )
})

test("a turned-away line wrapped or widened by white space is reworded too", () => {
  for (const s of [samples[7], samples[8], samples[9]]) {
    expect(turnsAway(s)).toBe(true)
    expect(cloak(s)).not.toBe(s)
    expect(turnsAway(cloak(s))).toBe(false)
  }
  expect(hint(samples[8])).toContain("oh-my-pi (omp)")
  expect(turnsAway(samples[10])).toBe(false)
})

const DSH = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host. A trailing slash marks a directory: list it when its contents matter. Anything else is a file: use the read tool when its contents are needed, and do not claim to have inspected it before reading. @\"...\" quotes a path containing spaces."

test("DeepSeek Harness's @-path paragraph goes reworded, the rest as written (#1028)", () => {
  const sys = "You are DeepSeek Harness.\n\n" + DSH + "\n\nBe brief."
  expect(outgoing(sys)).toBe("You are DeepSeek Harness.\n\nWhen the user writes @ followed by a path, they are pointing at that file or folder. Relative paths start at the workspace root; absolute paths are host paths. A path ending in a slash is a folder, so list it if its contents matter; otherwise it is a file, so open it with the read tool before relying on it. Paths with spaces appear as @\"...\".\n\nBe brief.")
  expect(outgoing("Tokens prefixed with @ are paths. Be brief.")).toBe("Tokens prefixed with @ are paths. Be brief.")
  const both = outgoing("x-anthropic-billing-header: cc\n" + DSH)
  expect(both).not.toContain("anthropic")
  expect(both).toContain("When the user writes @ followed by a path")
})

test("outgoing applies every declared system-text replacement", () => {
  for (const [from, to] of REWORDED) expect(outgoing(from)).toBe(to)
})

import { DEFAULT_SLASH_COMMANDS, defuseSlashCommands, restoreSlashCommands } from "./cloak.mjs"
// agy's own rule (cloak.mjs): the text split at Go's unicode.IsSpace, a
// word that is "/" and a command name
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/
const agyRuns = (text, commands = DEFAULT_SLASH_COMMANDS) =>
  text.split(GO_SPACE).filter((w) => w.startsWith("/") && commands.includes(w.slice(1))).map((w) => w.slice(1))
const J = "⁠"

test("defuseSlashCommands leaves agy no command to run, and touches nothing agy wouldn't run", () => {
  expect(DEFAULT_SLASH_COMMANDS).toEqual([
    "goal", "compact", "schedule", "browser", "plan", "grill-me", "teamwork", "learn", "boost",
    "agy-customizations", "antigravity-guide", "run-workflow", "swarm",
  ])
  // Cindy's (Pi) system prompt line, as plugins#1294 quotes it
  const cindy = "when the user directly invokes /learn or /skill:learn in Pi"
  expect(agyRuns(cindy)).toEqual(["learn"])
  expect(defuseSlashCommands(cindy)).toBe(cindy.replace(" /learn ", ` /${J}learn `))
  expect(agyRuns(defuseSlashCommands(cindy))).toEqual([])

  const raw = [
    "/plan",
    "/grill-me",
    "Check /learn /plan /grill-me together\t/goal\r\n/swarm\f/boost",
    "```sh\n/compact\n```",
    "Path /path/to/learn and URL https://example.com/learn and /learning and /learn-more and /skill:learn",
    "Punctuation /learn. /learn, `/learn` <tag>/learn</tag> (/plan) x/plan //plan /Learn /PLAN",
    "No-break\u00a0/learn and /learn\u00a0x, vertical\v/learn and /learn\vx",
    "Wide\u3000/plan\u3000x, next line\u0085/goal now, BOM\ufeff/learn, joiner\u2060/learn",
  ].join("\n")
  const out = defuseSlashCommands(raw)
  expect(agyRuns(raw)).toEqual([
    "plan", "grill-me", "learn", "plan", "grill-me", "goal", "swarm", "boost", "compact", "learn", "learn", "learn", "learn", "plan", "goal",
  ])
  expect(agyRuns(out)).toEqual([])
  // each change is a joiner after a "/" agy would have read as a command
  expect(out.replaceAll(`/${J}`, "/")).toBe(raw)
  expect(out.split(`/${J}`).length - 1).toBe(15)
  expect(out).toContain(`Check /${J}learn /${J}plan /${J}grill-me together\t/${J}goal\r\n/${J}swarm\f/${J}boost`)
  expect(out).toContain(`\`\`\`sh\n/${J}compact\n\`\`\``)
  expect(out).toContain("Path /path/to/learn and URL https://example.com/learn and /learning and /learn-more and /skill:learn")
  expect(out).toContain("Punctuation /learn. /learn, `/learn` <tag>/learn</tag> (/plan) x/plan //plan /Learn /PLAN")
  expect(out).toContain(`No-break\u00a0/${J}learn and /${J}learn\u00a0x, vertical\v/${J}learn and /${J}learn\vx`)
  expect(out).toContain(`Wide\u3000/${J}plan\u3000x, next line\u0085/${J}goal now, BOM\ufeff/learn, joiner\u2060/learn`)
  // already defused text stays as it is
  expect(defuseSlashCommands(out)).toBe(out)
  // a session's own commands, with regexp characters in a name
  expect(defuseSlashCommands("run /foo.bar now, not /fooxbar", ["foo.bar"])).toBe(`run /${J}foo.bar now, not /fooxbar`)
  expect(defuseSlashCommands("run /learn now", [])).toBe("run /learn now")
  expect(defuseSlashCommands("run /learn now", undefined)).toBe(`run /${J}learn now`)
})

test("restoreSlashCommands gives a tool call's arguments back as the prompt's own text had them", () => {
  const file = "Use /plan to start.\n/learn\nSee /path/to/plan"
  const copied = defuseSlashCommands(file)
  expect(copied).not.toBe(file)
  const args = { file_path: "/repo/README.md", old_string: copied, edits: [{ text: `cd /${J}plan` }], n: 2, ok: true, none: null }
  const back = restoreSlashCommands(args)
  expect(back).toEqual({ file_path: "/repo/README.md", old_string: file, edits: [{ text: "cd /plan" }], n: 2, ok: true, none: null })
  expect(args.old_string).toBe(copied)
  // nothing to restore: the very same object
  const plain = { command: "ls /plan", list: ["/learn"] }
  expect(restoreSlashCommands(plain)).toBe(plain)
  // a joiner anywhere else is the model's own
  const other = { text: `a${J}b /${J}learning x/${J}plan` }
  expect(restoreSlashCommands(other)).toBe(other)
  expect(restoreSlashCommands({ c: `/${J}custom` }, ["custom"])).toEqual({ c: "/custom" })
})
