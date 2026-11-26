# agy-cli

This standalone version of [magpie-community/plugins agy-cli](https://github.com/magpie-community/plugins/tree/main/packages/agy-cli)
adds **isolated multiple accounts and refresh_token import**, accepting a raw `1//...` token or account JSON.
Upstream MIT notices and attribution are retained. These changes have not been published to npm.

Turn the local Antigravity CLI (`agy`) into a model provider inside Magpie. Once
it is set up, clients such as OpenCode and Claude Code can reach the models agy
offers this plugin through Magpie, and every request is actually carried out by
an `agy` process.

**[中文 → README.md](README.md)** · Provenance, licensing and migration notes:
[NOTICE.md](NOTICE.md)

## What it is

The plugin runs as a Magpie provider. A client sends an Anthropic Messages
request; the plugin turns it into Agent Client Protocol (ACP) messages, hands
them to a local `agy acp` process, and converts the output back into a streamed
response.

- The work is done by the real agy CLI over the ACP channel it ships with. The
  ACP handshake uses `clientInfo.name: t3-code` and version `0.1.12`, pinned to
  the T3 server version checked on 2026-11-26 (no automatic synchronization).
  The npm package name and version are unchanged. This does not imply T3 Code affiliation,
  authorization, or reduced suspension risk. The plugin does not call Google's
  internal endpoints directly.
- Tools that belong to the client, such as file reads, writes and shell commands,
  are exposed to the model over MCP. The client runs them and the results flow
  back into the same agy conversation, so the model sees ordinary native tool
  calls.
- Account standing is outside the plugin's control. If Google changes its usage
  policies, the plugin cannot promise your account will not be restricted.

## How it differs from Antigravity ACP

The community Antigravity ACP plugin (`antigravity-acp`) serves the same
channel: Antigravity's models over ACP. The differences:

- **What runs**: Antigravity ACP downloads Google's ACP server
  (`agy_acp_server.par`, about 400 MB) and rides the Antigravity IDE's sign-in.
  This plugin downloads nothing; it runs the `agy` CLI you installed and signed
  in to yourself (`agy acp`).
- **Sessions**: Antigravity ACP opens a new session per request and carries the
  history as context. This plugin keeps a pool of agy processes, reuses one agy
  session for one conversation, and picks it up again with `session/resume`
  after a restart; only when that fails does it replay the history, within a
  byte budget.
- **Tool calls**: Antigravity ACP ends the turn with the call as the reply's
  `tool_calls`. This plugin feeds the client's result back into the same agy
  turn (see "Tool bridge" below).
- **Usage**: since 0.2.18, subscription quota and plan queries are disabled. Per-turn token accounting from ACP and local conversation records is retained.

## Tool bridge

agy reaches `--ide-mcp-port` by running `nc 127.0.0.1 <port>`. The plugin puts
a private `nc` first on agy's PATH, which connects that line to the plugin's own
MCP server. The control port listens on loopback only, with a token per process.

- This rests on how agy dials, not on an interface agy promises. It was checked
  on 1.4.12 and 1.5.0. On an agy older than 1.4.12 the plugin refuses the session
  and says to update.
- The private `nc` applies only to the agy processes the plugin starts, but for
  those it stands in for every `nc` agy runs.
- Every client tool is listed with `_meta: {"antigravity/alwaysLoad": true}`.
  Without it agy loads larger tools on demand, out of the model's function
  list, and the model cannot reach them (#989).

## Features

- **The models agy offers**: the list follows the model option agy advertises
  in the ACP session. A model `agy models` lists but the session does not offer
  this client (agy may keep Claude and GPT-OSS for clients it recognises) is
  left out. To list models, the plugin opens one session with `agy acp` (no
  prompt is sent) and reads what it offers; until it has, only Gemini is listed.
  The last list agy gave and offered is kept in `models.json` beside the session
  state file, so after a restart that list is served while agy is asked again.
  Models and thinking levels can be switched mid-conversation without losing
  history.
- **Streaming with thought summaries**: summaries come back as `thinking` blocks.
  Set `AGY_BRIDGE_THINKING=0` to turn them off.
- **Image input**: inline base64 PNG, JPEG, GIF and WebP. This needs agy 1.5.0 or
  newer, because the ACP server has to advertise image support. An image a tool
  returns (a screenshot from `read`) goes to agy as a prompt image too: over MCP,
  agy would save it to a file the model can't open.
- **Tool calls**: parallel and consecutive calls both work. A tool that runs past
  150 seconds first gets a "still running" placeholder; once the real result
  arrives, the same turn continues, and the client executes each call exactly once.
- **Session resume**: each finished turn is recorded. After a Magpie or plugin
  restart, the session continues through `session/resume` as long as the history
  and instruction hashes still match. The state file stores session IDs and
  hashes, never message text.
- **Isolation**: your global MCP configuration is never read. Every agy process
  runs with a temporary agent, and every permission request agy raises for its
  own tools (shell, file edits, browser) is refused. A request for one of the
  client's tools on the bridge's `ide-tools` server is allowed once, since that
  tool runs in the client under the client's own permissions. Real actions
  happen on the client side.
- **Assistant prefill**: requests that end with a text-only assistant message
  (SillyTavern presets, "continue"/"impersonate", bot frameworks) are served
  instead of rejected; the session ledger stays aligned across turns. See
  "Assistant prefill" below.
- **Usage and routing**: per-turn tokens remain available. Subscription windows are empty, not exhausted. Magpie still owns routing, but the plugin no longer supplies quota-based model-group limits.

## Assistant prefill

A client request that ends with a **text-only assistant message** (a
SillyTavern preset prefill, a "continue" / "impersonate" turn, a bot
framework's assembled context) used to be rejected with a 400. The prefill now
becomes part of the current turn:

- The prefill stays in the tail, so the session ledger (expectedMessages,
  client bytes) stays aligned with the client's own history across turns — the
  session is reused after a prefill turn instead of replaying from scratch;
- The prefill text renders as a continuation carrier (a note line plus the
  fragment itself), telling the model to continue from where the fragment
  stops;
- `AGY_BRIDGE_PREFILL=0` restores the stock 400 reject;
  `AGY_BRIDGE_PREFILL_CARRIER_NOTE` overrides the carrier's note line.

Known limits: a prefill alongside a live tool_result, or directly after an
unanswered tool_use, is still rejected; a
contiguous assistant tail with no user message before it is treated as one
prefill run (that turn degrades to a fresh session and self-heals on the next
turn); the models a client gets remain agy's decision.

## Requirements

- The Antigravity CLI (`agy`) with the `acp` subcommand. Signing in from Magpie
  needs agy 1.5.0 or later (`agy acp --login`); with an older one, run `agy` in
  a terminal once to sign in. Text and tool calls have been verified on 1.4.12
  and 1.5.0; image input needs 1.5.0.
- A Magpie build with OpenCode-style provider plugin support.
- agy older than 1.4.12 is refused for sessions (see "Tool bridge"). Quota refresh is local status only, with no HTTP or CLI `/usage` query.
- **Auto-update**: the agy processes the plugin starts get
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` by default, so the processes in the pool
  don't update one binary under each other. agy runs you start yourself are not
  affected and update as usual. If you set `AGY_CLI_DISABLE_AUTO_UPDATE`
  yourself (`false` included), the plugin passes your value on as written. If
  you use agy only through this plugin, run `agy` in a terminal now and then so
  it updates: an old version stands out too.

## Install

Install this repository's version, including multiple accounts, refresh-token import and Linux / Docker support:

```sh
magpie plugin add github:DJB-Developer/agy-cli
```

If already installed, update this GitHub plugin to **0.2.19** and reload it.
Accounts, credentials and suspension records remain intact; no reimport is needed.
Refresh each account's quota so the host receives empty windows. If old values or quota cooldowns
remain visible, refresh provider state and inspect the host cache; do not treat old values as current limits.
Internal HTTP quota/plan queries are removed, with no fallback to CLI `/usage`.
See [CHANGELOG.md](CHANGELOG.md) for historical release notes.

The marketplace and npm commands below install the upstream community version, without this repository's changes.

From the Magpie community plugins: find "Antigravity (local agy CLI)" on
Magpie's Plugins page and install it, or run:

```sh
magpie plugin add @magpie-community/opencode-agy-cli-auth
```

The provider id is `agy-cli`, so models are named `agy-cli/<model>`. The
default concurrency is 16; change it under Concurrency on Magpie's Providers
page (0 means no limit).

After installing, sign in from Magpie; no terminal needed.

## Usage

1. Open Sign in for `agy-cli` on Magpie's Providers page.
2. Choose **Add an account (refresh token)**, enter a name such as `personal` or
   `work`, and paste a raw `1//...` token or JSON containing `refresh_token`
   (also accepts `token.refresh_token`). The token must match agy's OAuth client.
3. Repeat with another name to add another account. Each gets a separate Magpie
   account record; Magpie controls enablement, priority and request scheduling.
4. Keep using `agy-cli/<model>`; model IDs do not need account prefixes.

**Add an account with Google** creates an independent profile through browser
sign-in instead. Enter a new name, open the link, then paste the authorization
code back into Magpie. Links wait 15 minutes.

### Account isolation and upgrades

- The existing `agy` default account from 0.1.43 keeps working after upgrading.
  **Use the existing CLI account (legacy default)** registers that login again.
- Each named account owns its CLI credentials, process pool, tool calls, resumable
  sessions, model catalog and local status reader. Magpie stores an `agy:<name>` reference;
  agy refreshes the actual token.
- Names use 1–64 letters, digits, underscores or hyphens and are normalized to
  lowercase. Reserved names such as `default` are rejected. Existing names cannot
  be overwritten. Failed imports remove only the newly created profile.
- Removing a Magpie account record does not delete its local credentials.
  **Use a saved named account** registers the profile again using its original name;
  do not import the refresh token again or add a `-` suffix just to restore the row.
  This reuses the saved credential and does not clear suspension records. To replace a token,
  add it under a new name, verify it, then disable the old account.
- Profiles live under `$XDG_CONFIG_HOME/magpie-agy-cli/accounts/<name>`, or
  `~/.config/magpie-agy-cli/accounts/<name>` when XDG is unset. Override the root
  with `AGY_BRIDGE_ACCOUNTS_DIR`. Credentials are mode `0600`; newly created account
  directories are mode `0700`.
- Named accounts use `--gemini_dir` and native file storage without a keyring.
  Their subprocesses do not inherit Gemini/Google API key, ADC or Vertex auth.
  The default account retains its original storage and environment behavior.
- Missing or unreadable selected credentials fail closed, without using the
  default account.

#### 1Panel / official Magpie Docker image

Keep the existing `magpie-config:/config` volume; **no Compose change is needed**.
The [official image](https://github.com/yetone/magpie/blob/main/Dockerfile) sets
`XDG_CONFIG_HOME=/config`, so new profiles persist under
`/config/magpie-agy-cli/accounts/<name>/`. The legacy default remains at
`/config/home/.gemini/antigravity-cli/antigravity-oauth-token`.
No D-Bus or GNOME Keyring installation is needed. Do not put tokens in Compose.

Verified with native agy 1.5.9 in a non-root Linux container without network access:
`models` and ACP read the selected profile for both accounts rather than
using the default credential. This used dummy tokens to verify storage isolation,
not real model calls.

## Concurrency

- Each account's pool is capped by `AGY_BRIDGE_MAX_PROCS`, which defaults to 16
  agy processes.
- Magpie's Providers page has its own Concurrency field that accepts 0 to 1000,
  where 0 means no limit. A value set there overrides the default of 16 that the
  plugin declares in `magpie.maxConcurrency`.
- When the pool is full and no process can be evicted, the plugin answers with
  HTTP 503. Keep the two numbers aligned: if the Providers page allows more
  concurrent requests than the pool holds, the extra ones will get 503.

## Platforms

- **macOS and Linux**: supported.
- **Native Windows**: supported for `.exe`, `.cmd` and `.bat` lookup and launch,
  silent background update checks, and `magpie quota`. So far only the command
  construction has unit tests; end-to-end runs on real Windows hardware are still
  pending.

## Quota and plans (0.2.18)

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

**Subscription quota and plan queries are disabled; chat still uses official `agy acp`.**
This follows [T3 Code PR #43026](https://github.com/pingdotgg/t3code/pull/43026): its maintainer reports
Google's warning that external clients should use ACP and internal API calls can flag accounts.
That warning does not establish why any particular account was suspended, or guarantee this release is ban-proof.

- Removes direct HTTP `retrieveUserQuotaSummary`, `fetchAvailableModels` and `loadCodeAssist` requests.
- Refresh returns `windows: []`, an unavailable explanation and `signIn: kept`, with no plan. Unknown limits are neither 0% nor 100%, and are not a sign-out.
- No access-token extraction, background OAuth refresh, keepalive/inference probes or CLI `/usage` fallback.
- Per-turn token reporting and read-only local conversation accounting remain; these are not subscription balances.
- Account selection, concurrency, session isolation and actual chat errors remain intact; queried quota-based model-group windows are no longer supplied.
- Existing TOS records still return the reason and `signIn: expired`, and may notify local Magpie to disable the account. That loopback management call is not a Google quota request.
- The absence of a local suspension record does not prove chat eligibility. Refresh neither probes for new bans nor clears existing ones.

Rolling back to 0.2.16 alone does not remove all internal HTTP: that version still queries plans.
Reload the plugin and refresh host state after upgrading.

## Request diagnostics and session isolation (0.2.16)

Enable **Request timing diagnostics** in Magpie's agy-cli plugin options. Changes apply to new requests;
no container restart is needed. On older hosts use `AGY_BRIDGE_TIMINGS=1`; the Magpie UI value takes precedence.
The switch is off by default. Inspect server logs, not chat output:

```sh
docker logs --since 10m magpie 2>&1 | grep -F '"event":"agy_bridge_request"'
```

There are at most 120 rows per account per minute, with dropped rows reported as `suppressed` on the next emitted row.
Rows contain anonymous account/conversation hashes, a request ID, outcome and monotonic timings, never account names,
raw session IDs, prompts, credentials or tool arguments.

- `stages_ms.catalog` and `lock_wait` measure catalog and plugin conversation-lock waits, **not Magpie routing queues**.
- `startup` includes `process_prepare`, `initialize`, `session_new` / `session_resume` and model configuration. Nested spans are not additive.
- `prompt_dispatch_ms`, `acp_first_output_ms`, `acp_first_text_ms` measure time from request entry to prompt dispatch and native CLI output.
- `first_output_ms` / `first_text_ms` measure the bridge's first content event / text, excluding SSE headers and heartbeat pings. Output includes thinking/tools.
- `after_first_output_ms` can include tool waits and usage settlement, not just generation. `usage_settlement` measures response token accounting, **not account quota queries**.
- `total_ms` covers this plugin response; `session` is `new`, `reused`, `resumed` or `tool_continuation`; `resume` gives fixed fallback reasons.
- `status` classifies the outcome, including in-stream errors; it is not necessarily the outer HTTP 200. Cancellation is logged as `cancelled` / `499`, not returned as HTTP 499.
- Non-streaming first-text timings refer to the internal stream, not client-visible JSON delivery. Proxy buffering and client network latency are not measured.

**Multi-user callers must supply stable, non-colliding session identities.** Send
`X-Magpie-Session: <server-generated user-and-chat-unique ID>` on every turn and tool-result request.
The plugin scopes sessions by Magpie's forwarded `X-Magpie-Session` / `X-Magpie-Subagent` headers and
`metadata.user_id` / `metadata.session_id` when the host preserves these body fields. Do not assume arbitrary
metadata survives OpenAI-to-Anthropic conversion. `identity_source` reports `magpie_header`, `metadata`, or
`legacy`; legacy history matching alone cannot distinguish different users with identical requests.
These fields are correlation hints, not authentication: the application must authenticate users and bind their IDs server-side.

Live tool results cannot cross a user/session boundary. Parked checkpoints also bind the account profile,
working directory, history and instructions. Old unbound or incompatible checkpoints are not resumed;
a new session replays only the request's own history. Credentials are unchanged. Resume diagnostics do not include raw CLI errors.

Cancellation covers catalog/lock waits, startup, streaming and non-streaming generation. An acknowledged
cancel can still reuse a history-matched session. An unacknowledged cancel stops its process after at most
15 seconds of grace and invalidates its checkpoint. A completed tool response is not a disconnect: the
next HTTP request may still return its tool results. This work does not change account routing or add automatic request/tool replay.

## Environment variables

| Name | Default value | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_ACCOUNTS_DIR` | `magpie-agy-cli/accounts` under the XDG config directory | Root for named profiles and state |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum agy processes per account |
| `AGY_BRIDGE_TIMINGS` | off | Set to `1` for content-free timing logs; Magpie UI setting takes precedence |
| `AGY_BRIDGE_CANCEL_SETTLE_MS` | 15000 | Cancellation acknowledgement grace; can be reduced, capped at 15 seconds |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to stop forwarding thought summaries |
| `AGY_BRIDGE_EFFORT` | unset | Force a thinking level: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | off | Set to `1` to drop agy's own prompt components; Magpie's saved UI switch takes precedence. See "Minimal agent" below |
| `AGY_BRIDGE_IDLE_MS` | 600000 | How long a process may sit idle before it is reclaimed; the session can still resume |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | How long a reclaimed session stays resumable (6 hours) |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | Where resumable session records are kept |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | After this long, a still-running client tool gets a "still running" reply |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | Limits for process startup, agy silence, and waiting on a client tool result |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | How long a suspended tool turn whose client disconnected may keep its pool slot |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for the replayed history prompt |
| `AGY_BRIDGE_STORED_SIGNIN` | unset | `skip` stops the plugin from reading agy's stored sign-in |
| `AGY_BRIDGE_MCP_TRACE` | unset | Writes MCP channel traffic to the given file; for debugging only |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` for the plugin's agy processes | agy's own variable. When you set it, agy gets your value; see "Requirements" |
| `AGY_BRIDGE_PREFILL` | on | Set to `0` to restore the stock 400 reject for assistant prefill tails; see "Assistant prefill" |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | English system note | The note line rendered before a prefill fragment (sent to the model) |

## Minimal agent

Since 0.2.3, open **Providers → agy-cli → Edit → Plugin options**, change
**Minimal agent prompt**, and Save. No Compose edit or container restart is needed.
The switch applies to every agy-cli account. Magpie saves it across restarts.

Changes apply to new conversation turns. Running replies and pending tool calls
finish with their original setting. After a mode change, the next turn rebuilds
the session from the client's history instead of reusing the old prompt.
Sessions saved before this version lack a mode record and rebuild once on their
first continuation as well.

The default is off, or on if `AGY_BRIDGE_MINIMAL_AGENT=1` was already set.
A saved UI value overrides the environment, including an explicit off. Older
Magpie hosts and OpenCode retain the environment fallback. If Plugin options is
missing after updating the plugin, update Magpie too.

By default agy runs every request with its own system prompt, and the
client's system prompt is added to it: in the session when agy advertises
`systemPrompt.append`, otherwise as `<external_system_instructions>` at the
start of the first prompt.

Antigravity answers a 429 "Resource has been exhausted" to a few system
prompt lines whatever quota is left (Claude Code's billing line, the Claude
Agent SDK, Codex, Hermes Agent, OpenCode and pi identities, oh-my-pi's RFC
2119 line). The
plugin leaves the billing line out and rewords the others with the same
meaning before agy sends them ("built on the Claude Agent SDK by Anthropic",
"built on GPT-5", "RFC 2119 key words: …", "You're Hermes Agent / OpenCode /
a coding agent running in the Codex CLI", "running within pi"), as the
Antigravity provider does (`cloak.mjs`). Zero-width spaces no longer help:
since 11-14 Google's check reads past them. Should such a 429 still come
back, it is reported as a 400 about the prompt, not as a quota.

DeepSeek Harness's paragraph on `@` paths ("Tokens prefixed with @ are
paths…") goes reworded with the same meaning, as the Antigravity provider
sends it: word for word, it got most `gemini-4-argon` answers fast, without
thinking and shallow (#1028).

With the switch on (or the environment variable set to `1`), the temporary agent carries `excludeDefaultComponents: true`. The
request that goes upstream then has none of agy's own system prompt, only
the plugin's one-line tool note and the client's system prompt (sent in one
of the two ways above). The original author measured about 8,400 input
tokens per model call with agy's prompt and about 500 without. The cost is
that upstream no longer sees agy's own request shape, which is why it is
off unless you turn it on.

## Troubleshooting

- **agy cannot be found**: set `AGY_PATH` to the executable, or make sure `agy`
  is on PATH.
- **Sign in fails, or agy reports a login problem**: click Sign in again, or run
  `agy` in a terminal to sign in there.
- **HTTP 503**: the pool is full. Raise `AGY_BRIDGE_MAX_PROCS` and the Providers
  page Concurrency, or reduce the number of simultaneous sessions.
- **Limits unavailable or plans missing**: expected in 0.2.18 after internal API removal. Repeated refresh/sign-in will not restore this feature; ACP chat and per-turn token accounting remain.
- **Image requests return HTTP 400**: the running agy does not advertise image
  support (1.5.0 or later is needed). Only inline base64 is accepted; image URLs
  and binary documents such as PDFs are rejected.
- **A reply contains "Agent execution terminated due to error."**: that is agy's
  in-band error marker. The plugin reads the real cause from agy's log and ends
  the turn with an error instead of passing the marker through as text. agy
  1.5.8's "There was a network issue connecting to the server" and "Your AI
  credits balance is too low to continue." end the turn the same way (the
  latter as a rate limit), and its `⚠ API error (attempt N)` retry lines are
  dropped.
- **HTTP 409 saying tool results do not match the history**: usually the client
  rewrote the history or tool IDs mid-conversation. When the plugin can work out
  the correct match it rebuilds the session; when it cannot, it refuses rather
  than guessing.
- **Turning thought summaries off**: set `AGY_BRIDGE_THINKING=0`, or send
  `thinking: { "type": "disabled" }` with the request.

## Development

```sh
bun test                       # from this repository root
```

The tests run the full ACP and MCP path against a fake agy (an ACP stdio server
under `test/`), so they never start the real agy and use no quota.

## License

MIT. Copyright notices live in [LICENSE](LICENSE); upstream provenance and the
list of changes are in [NOTICE.md](NOTICE.md).


## Service suspension and failover (0.2.10)

Explicit CLI service-disabled/TOS wording or structured 403 PERMISSION_DENIED with
TOS_VIOLATION marks only that profile suspended. Detection covers terminal warning
chunks, retry lines, ACP errors, current-turn logs and database errors. Generic
403s, region restrictions, expired credentials and quota limits do not mark a suspension.
0.2.18 removes network quota/plan checks. Chat remains on `agy acp`.

Whole responses return HTTP 403. Streams emit `permission_error` with numeric
`status: 403`, `code: TOS_VIOLATION` and the suspension reason, rather than successful
assistant text. Current Magpie can fail over to another available account before
answer content is sent. For another provider after all accounts fail, configure a
fallback model in a Magpie routing group and request that group. Seamless switching
after partial output is not guaranteed. Older Magpie protocol translation can lose
the numeric stream status; automatic account disabling below does not rely on it.

The mark persists in `<profile>/bridge-state/service-status.json`, or beside the
legacy default profile's `sessions.json`. It stores only a reason code and detection
time. Subsequent chat requests fail locally without launching CLI. Usage shows the
reason and reports `signIn: expired` through Magpie's available account-state API;
the host may label this as an expired sign-in, while the reason identifies suspension.
Token refresh, quota refresh and restart do not clear the mark. Persistence failure
is logged and the current runtime stays blocked.

The absence of a local suspension record does not prove inference eligibility. Detection requires an
explicit CLI suspension signal during actual chat; no extra inference probes are sent. Manually turn off any account
already known to be suspended until a signal has been observed. After a successful
appeal, stop Magpie/the plugin, remove only that profile's `service-status.json`,
restart and refresh usage, then re-enable the account in Magpie if needed.


## Concurrent openings across models (0.2.11)

Ports community 0.1.50–0.1.51. Magpie's model test sends the same `hi` opening to
several models at once; these now receive independent agy processes. Acquisition
and turn start hold the same conversation lock. Duplicate openings for a model
whose turn is still running remain busy, including secondary concurrent processes.
Per-account process limits and account isolation remain in force. This fix does
not replace explicit user and session identities in multi-user chat applications.

Under tool-budget pressure, ordinary property description fragments are dropped
so tool purposes and complex parameter contracts retain more room. Catalogs that
fit remain unchanged; tool names and schema structure are preserved. CLI chat,
the minimal-agent UI option and persistent TOS suspension detection are retained.


## Account state during quota refresh (historical)

0.2.12–0.2.17 used HTTP metadata to detect new suspension signals. 0.2.18 removes that path.
Refresh now reports only locally recorded suspension. Explicit TOS errors from actual CLI chat
still persist and quarantine the account; recovery after an appeal remains manual.

## Automatic routing quarantine (0.2.13)

The **Automatically disable TOS-blocked accounts** plugin switch defaults to on.
After explicit TOS denial, the profile stays blocked locally and the plugin calls
the existing `POST http://127.0.0.1:3430/api/login/off` asynchronously using the
container's existing `MAGPIE_WEB_KEY`. This is the same account toggle as the UI,
not credential deletion or a direct edit to Magpie files. Magpie continues to own
account selection, session affinity, concurrency, quota routing and attribution.
Chat still uses agy CLI; quota refresh reports local state without querying Google.

This targets `magpie web` on port 3430 with a fixed web key, including the inspected
v0.1.3078 API. Requests only go to loopback, bypass vendor proxies, never follow
redirects and never print the key. Reload the plugin and refresh quotas to handle
previously marked named profiles. Concurrent detections coalesce; failures retry
on later checks at most once a minute; success is held for five minutes. Usage
errors show the outcome. Missing keys, another port, legacy default profiles and
API failures leave the local CLI guard active and request manual account disable.

v0.1.3078 refuses to disable the last enabled account; another enabled account
with a valid sign-in must exist. With none available, requests fail locally or use
a configured routing-group fallback. Switching after partial output is not
guaranteed. Old 402 rest history may remain, but a disabled account leaves future
routing. Recovery is manual after a successful appeal: remove the service-state
file as described above and re-enable the account. Turning this switch off leaves
only local blocking, not automatic changes to Magpie's enabled-account list.


## Upstream compatibility fixes (0.2.14)

- Avoid duplicate required `toolSummary` fields on `run_command`. Restore a default summary only when the client declares the property and agy omits it; preserve supplied summaries and other tools.
- Mark temporary static/probing model lists as fallback so Magpie preserves saved model selections. Catalog state remains account-local.
- Emit explicit status 400 for recognized request-content rejections (including HTTP 400 for non-streaming replies). Ordinary quota errors remain 429; TOS errors retain 403, `TOS_VIOLATION`, and automatic account quarantine.

That historical fix did not adopt upstream single-account replacement login, prompt relocation or CLI installation. Magpie 0.1.4246 is not required. Version 0.2.18 separately removes quota and plan queries.


## Per-prompt database errors and recovery hints (0.2.15)

In addition to existing ACP, warning and log handling, the bridge reads only the current account/session's final step added by the current `session/prompt`. A terminal native error no longer becomes a successful `end_turn`. Historical errors, model quotations, recovered intermediate retries and cancelled responses are not treated as terminal database errors.

- Uses each profile's `antigravity-cli/conversations`, independently of token accounting. Missing, locked, incompatible or identity-check-failing stores yield no extra evidence; existing checks continue. No database writes or polling.
- For quota/temporary-service failures, accepts explicit future `quotaResetTimeStamp`, then `quotaResetDelay`, then `retryDelay`. No guessed reset for missing/invalid metadata.
- SSE errors carry ISO `reset_at` and Unix-second `resets_at` (rounded up); whole errors also carry `Retry-After`. Absolute, zoned reset wording survives translators that discard custom fields. A retry hint does not guarantee successful recovery.
- Explicit TOS denial retains 403/`TOS_VIOLATION`, persistent account blocking and automatic quarantine, without an automatic recovery date. Generic 403 is not a permanent TOS ban; recognized request rejection remains 400.
- Output is not buffered until completion. A late database error cannot retract already-streamed text/tool calls and does not transparently replay tools.

Chat still uses agy CLI. Version 0.2.18 removes quota and plan queries but retains per-prompt database error detection. Reload after upgrading; no credential migration or container changes are required.
