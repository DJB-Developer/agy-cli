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
  ACP handshake's `clientInfo` is the plugin's own package name and version
  (`opencode-agy-cli-auth`), not Zed or any other editor, and the plugin does
  not call Google's internal endpoints directly.
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
- **Usage**: this plugin reads agy's own `/usage` report; Antigravity ACP reads
  the quota each reply carries.

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
  newer, because the ACP server has to advertise image support.
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
- **Usage visibility**: Magpie shows the agy subscription usage windows. They are
  informational only; running out of quota does not block requests automatically.

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
- A Magpie build with OpenCode-style provider plugin support. Usage reporting was
  verified on Magpie 0.1.1599.
- agy older than 1.4.12 is refused for sessions (see "Tool bridge"), and older
  than 1.1.11 for usage queries too, because those builds can treat `/usage` as
  an ordinary model prompt.
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

If already installed, update this GitHub plugin to 0.2.2 on Magpie's Plugins page. Existing accounts remain usable; add further accounts as needed.
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
  sessions, model catalog and usage reader. Magpie stores an `agy:<name>` reference;
  agy refreshes the actual token.
- Names use 1–64 letters, digits, underscores or hyphens and are normalized to
  lowercase. Reserved names such as `default` are rejected. Existing names cannot
  be overwritten. Failed imports remove only the newly created profile.
- Removing a Magpie account record does not delete its local credentials.
  **Use a saved named account** registers the profile again. To replace a token,
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
`models`, ACP and `/usage` read the selected profile for both accounts rather than
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

## Usage quota

```sh
magpie quota agy-cli --json
magpie quota refresh agy-cli --json
```

The numbers come from the selected account's agy `/usage` report, broken down
by model group. Named accounts query through their own credential directories. A window with no
measurable data shows "Limits not available" rather than a fake 0% or 100%.

A signed-out agy opens Google's sign-in page in the browser when it runs, so
before running agy for usage or the model list, the plugin looks at agy's stored
sign-in in the system keychain (macOS), Credential Manager (Windows), Secret Service (desktop Linux), or native credential file (headless Linux) and only
reads whether one is there and when it ends. With none, with one that has ended
and can't be renewed, or with one agy already failed on, agy is not run: the
account shows its sign-in has expired until you sign in again. Other failed
usage reads wait 10 minutes before the next try, doubling up to 6 hours.

Since 0.2.1, each failed CLI usage query emits one `[agy-usage]` JSON log entry
with the account name, query stage, CLI version, exit code and redacted original
error in `detail`. Credentials, authentication headers, sensitive URL contents
and email addresses are filtered; diagnostic length is bounded. Shared concurrent
queries log once, and backoff reads do not repeat the log. Successful queries and
intentional cancellations do not produce error logs.

Check the `magpie` container logs in 1Panel, or run on the server:

```sh
docker logs --since 10m magpie 2>&1 | grep -F '[agy-usage]'
```

Since 0.2.2, Magpie's quota error also includes redacted original CLI output after
`CLI error (redacted):`, limited to 4096 characters with a truncation marker when
needed. Update and reload the plugin, then refresh the affected account's quota
to read the details directly in Magpie. Details remain available during failure
backoff; changed credentials or a successful query clear the old details.
Only explicit ineligibility or unsupported-region errors produce an account
eligibility conclusion.


## Environment variables

| Name | Default value | What it does |
|---|---|---|
| `AGY_PATH` | PATH lookup | Path to the agy executable |
| `AGY_BRIDGE_ACCOUNTS_DIR` | `magpie-agy-cli/accounts` under the XDG config directory | Root for named profiles and state |
| `AGY_BRIDGE_MAX_PROCS` | 16 | Maximum agy processes per account |
| `AGY_BRIDGE_THINKING` | on | Set to `0` to stop forwarding thought summaries |
| `AGY_BRIDGE_EFFORT` | unset | Force a thinking level: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `AGY_BRIDGE_MINIMAL_AGENT` | off | Set to `1` to drop agy's own prompt components; see "Minimal agent" below |
| `AGY_BRIDGE_IDLE_MS` | 600000 | How long a process may sit idle before it is reclaimed; the session can still resume |
| `AGY_BRIDGE_RESUME_TTL_MS` | 21600000 | How long a reclaimed session stays resumable (6 hours) |
| `AGY_BRIDGE_STATE_FILE` | `$XDG_STATE_HOME/magpie-agy-bridge/sessions.json` | Where resumable session records are kept |
| `AGY_BRIDGE_IDE_CALL_DEADLINE_MS` | 150000 | After this long, a still-running client tool gets a "still running" reply |
| `AGY_BRIDGE_START_TIMEOUT_MS` / `_TURN_TIMEOUT_MS` / `_TOOL_TIMEOUT_MS` | 60 s / 5 min / 30 min | Limits for process startup, agy silence, and waiting on a client tool result |
| `AGY_BRIDGE_DETACHED_EVICT_MS` | 30000 | How long a suspended tool turn whose client disconnected may keep its pool slot |
| `AGY_BRIDGE_MAX_PROMPT_BYTES` | 114688 (112 KiB) | Byte budget for the replayed history prompt |
| `AGY_BRIDGE_USAGE_TIMEOUT_MS` | 15000 | Total time budget for a usage query, capped at 18000 |
| `AGY_BRIDGE_STORED_SIGNIN` | unset | `skip` stops the plugin from reading agy's stored sign-in |
| `AGY_BRIDGE_MCP_TRACE` | unset | Writes MCP channel traffic to the given file; for debugging only |
| `AGY_CLI_DISABLE_AUTO_UPDATE` | `true` for the plugin's agy processes | agy's own variable. When you set it, agy gets your value; see "Requirements" |
| `AGY_BRIDGE_PREFILL` | on | Set to `0` to restore the stock 400 reject for assistant prefill tails; see "Assistant prefill" |
| `AGY_BRIDGE_PREFILL_CARRIER_NOTE` | English system note | The note line rendered before a prefill fragment (sent to the model) |

## Minimal agent (`AGY_BRIDGE_MINIMAL_AGENT=1`)

By default agy runs every request with its own system prompt, and the
client's system prompt is added to it: in the session when agy advertises
`systemPrompt.append`, otherwise as `<external_system_instructions>` at the
start of the first prompt.

Antigravity answers a 429 "Resource has been exhausted" to a few system
prompt lines whatever quota is left (Claude Code's billing line, the Claude
Agent SDK, Codex and Hermes Agent identities, oh-my-pi's RFC 2119 line). The
plugin leaves the billing line out and rewords the others with the same
meaning before agy sends them ("built on the Claude Agent SDK by Anthropic",
"built on GPT-5", "built by Nous Research", "RFC 2119 key words: …"), as the
Antigravity provider does (`cloak.mjs`). Zero-width spaces no longer help:
since 11-14 Google's check reads past them. Should such a 429 still come
back, it is reported as a 400 about the prompt, not as a quota.

DeepSeek Harness's paragraph on `@` paths ("Tokens prefixed with @ are
paths…") goes reworded with the same meaning, as the Antigravity provider
sends it: word for word, it got most `gemini-4-argon` answers fast, without
thinking and shallow (#1028).

Set to `1`, the temporary agent carries `excludeDefaultComponents: true`. The
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
- **Usage shows "Limits not available" or a version error**: that window has no
  measurable data. For a version error, upgrade agy to 1.1.11 or later.
- **Image requests return HTTP 400**: the running agy does not advertise image
  support (1.5.0 or later is needed). Only inline base64 is accepted; image URLs
  and binary documents such as PDFs are rejected.
- **A reply contains "Agent execution terminated due to error."**: that is agy's
  in-band error marker. The plugin reads the real cause from agy's log and ends
  the turn with an error instead of passing the marker through as text.
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
