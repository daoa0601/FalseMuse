# OptChat memory over all local agent logs, on Cloudflare

Goal: one always-on master agent in a Durable Object, whose memory is a
[Taelin OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) tree. The
master spawns **Pi sessions as subagents** on any connected machine (this laptop, a home server, or
a Cloudflare Sandbox container). History from every past Codex, Claude Code, Prime, and Pi session
seeds the memory. Model calls use the ChatGPT Pro subscription; there is no API key or AI Gateway.

This follows the gist's own design: §9's master that spawns subagents and logs only their reports,
and §10's always-on host. The Durable Object is that host, and Pi's RPC mode is the subagent
runtime.

## Status

| Phase                                 | State                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Corpus measurement                 | Done                                                                                                                                                                                                                                                                                                                      |
| 1. Normalizer and redaction           | Done 2026-10-05, with zero Gitleaks findings after redaction                                                                                                                                                                                                                                                              |
| 2. Local memory prototype (one month) | Done 2026-10-09. Three complete trees of one month's messages. Retrieval, 10 questions answered by Sol with zoom, date and search, graded by Sol: Luna on gist `3c190e0` 9/10 in 28 tool calls, Luna on `f51fe5c` 8.5/10 in 42, Sol on `f51fe5c` 10/10 in 32. Every miss said it could not find the answer; none guessed. |
| 3. Master Durable Object              | Deployed: log, tree, compactor, turn loop, web and terminal chat, model relay through the laptop. History imported 2026-10-10 with no failing nodes; all main and subagent transcripts are in R2.                                                                                                                         |
| 4. Laptop node and spawn              | Deployed: daemon under launchd, Pi RPC tasks, per-call owner approval, steering, abort, report outbox, task recovery, R2 audit, quota ledger                                                                                                                                                                              |
| 5. More nodes                         | Sandbox fallback deployed; home server not set up; live ingest on since 2026-10-11, following hand-run sessions from the import's end                                                                                                                                                                                     |
| 6. Muse behaviour                     | Scheduled prompts and Code Mode deployed; Telegram/Discord and gated self-redeploy not started                                                                                                                                                                                                                            |

**Next:** the open issues below.

## Direction: a chief of staff over t3code (decided 2026-10-10)

The Master becomes the owner's own always-on assistant: it remembers everything, delegates work to
coding sessions on any of the owner's computers, follows them, and reports back. Persona, voice and
companionship come after that works.

[t3code](https://github.com/pingdotgg/t3code) (MIT, v0.0.x) already provides the sessions and the
apps: desktop (macOS, Windows, Linux), iOS, Android and web clients, remote access through T3
Connect tunnels or Tailscale, and providers for Codex, Claude, Cursor, Grok Build, Muse Code,
OpenCode, Pi and any ACP agent. Each environment serves an MCP endpoint to outside agents
(`https://<environment>/mcp`), approved once with OAuth and a pairing code at read-only, supervised
or full access, revocable at once. Its tools list and launch projects and threads, send, steer, wait
on, interrupt, search and fork threads, delegate tasks, and answer a thread's pending approval
requests.

| Milestone | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | A turn never waits on the compactor (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M1        | Live 2026-10-11 with the laptop connected through T3 Connect: the Master signs in to each computer's T3 Code as an outside MCP agent (`src/t3.ts`, `src/mcp.ts`) and has `computers`, `launch`, `threads`, `read_thread`, `send` and `interrupt`; watched threads are checked every 30 s and report once as `work` messages, and a thread waiting on the owner reports that once.                                                                                                                                                               |
| M2        | Live 2026-10-11: OptChat is an ACP agent (`bin/optchat-acp`, `scripts/acp.ts`) and a provider in the laptop's T3 Code, so it appears in t3code's desktop and mobile apps beside the threads it runs; prompts become Master turns and the turn's steps stream back. The Worker's web page stays as the fallback that needs no computer.                                                                                                                                                                                                          |
| M3        | Live 2026-10-11: a reply nobody prompted for (to a report or a schedule) is posted to a persistent OptChat inbox thread in T3 Code, renamed after its first line, so T3 Code's own push notifies the phone and the owner answers in the same thread; `QUIET` keeps it off. Turns carry the owner's local time and instructions, and the prompt casts the Master as chief of staff. The Master sees images sent with a message and reopens them with `look`. Voice input is T3 Code's dictation; spoken replies are not built.                   |
| M4        | Live 2026-10-18 on the laptop: named helpers. `hire`, `helpers`, `delegate` and `retire` (`src/helpers.ts`) keep a helper's instructions, model and one T3 Code thread per helper, briefed again when its instructions change. A model is checked against the computer's `orchestrator_capabilities` and switched in place with `t3_thread_configure`. A thread the computer can no longer read, or a `fresh` start, is replaced by one given the helper's last eight logged jobs and results. Retiring a helper leaves its threads in T3 Code. |

Rules that carry over: approvals of a thread's tool calls go to the owner, never to the model,
because the Master reads untrusted logs; t3code calls sit behind one adapter pinned to a version,
since its API is young; the node daemon keeps log ingest and the model relay, and t3code replaces
its Pi task runner.

## Import

Each historical session is appended as one contiguous block, ordered by start time, so parallel
sessions never interleave. Only scope A enters the tree: your messages, final assistant replies, and
subagent reports (`work`). Tool traffic and full transcripts stay in R2, reachable through the
`transcript` and `session` tools. Ids are permanent, so this scope is fixed before the first import.

Messages over 512 bytes need a model call; the rest are free leaves.

**Measured cost (one month's prototype).**

| Run                  | Paid nodes | Requests | Requests per node | Input tokens per request | Cached | Uncached input |
| -------------------- | ---------: | -------: | ----------------: | -----------------------: | -----: | -------------: |
| Luna, gist `f51fe5c` |      2,732 |    5,186 |              1.90 |                   25,619 |    14% |         114.9M |
| Sol, gist `f51fe5c`  |      2,783 |    3,162 |              1.14 |                   26,628 |     0% |          83.9M |
| Luna, gist `3c190e0` |      2,759 |    7,036 |              2.55 |                    7,577 |    81% |          10.3M |

The `3c190e0` run took 47 minutes, against 84, at roughly a tenth of the uncached input of the first
prototype.

## Open issues

- **Compactor effort** is `high` (`COMPACTOR_EFFORT`). On 576 nodes built at each effort, lines kept
  over 512 bytes fell from 3% (levels 1–3) and 10% (4+) at `low` to 1% and 0%, for about a third
  more output tokens at the same pace; `xhigh` reached 0% with fewer retries but took 3 times as
  long and 3–6 times the output. Only 34 nodes were above level 3: re-measure on a larger import.
- **Rate limits.** The backend answered 476 of 7,966 calls with 429 at 8 parallel jobs; failed nodes
  retry after 10 seconds.
- **The Master depends on the laptop to think at full speed.** With the laptop off, it calls the
  backend itself, which refuses bulk calls from Cloudflare (403); a chat turn may still get through.
  A second model node (the home server) would remove the single point.
- **Not yet verified live:** subscription credential refresh, recovery of a turn interrupted
  mid-call, abort during model streaming, and loss of an unsaved Sandbox workspace.
- **Posted replies** go to the inbox of the first signed-in computer that takes them, so a second
  computer gets its own inbox only while the first is offline. Repeated posts are no-ops by request
  id, but an inbox that refuses a post is replaced, so a passing T3 Code error can leave a second
  inbox. Five failed tries leave a post unsent, with its reason in `/api/posts`.
- **Images** go to the model inline on every step of their turn (up to 20 MiB a message, inside the
  relay's 32 MiB WebSocket limit); memory keeps only the `[image key]` marker and the reply's words.
  The web page cannot attach images yet.
- **Spoken replies:** T3 Code has dictation but no text-to-speech, so replies are read, not heard.
- **Node keys** are stored and compared in plaintext SQLite; hash them before adding more nodes.
- **Schema changes** are applied with column probes in each constructor; move to a versioned
  migration list before the next schema change.
- **Python** (normalizer, redaction, live ingest) runs on the system `python3` rather than `uv`.
- **`cf` 1.0.0-beta.12** never finishes `cf build` when a pnpm workspace package lies outside this
  directory, so the workspace holds only this package.

## Design decisions

**Deviations from the gist:**

1. Sessions are concatenated by start time, each contiguous.
2. Secrets are redacted locally (pattern rules plus Gitleaks) before anything reaches Cloudflare. T3
   Code thread text is the exception: it reaches the Worker directly, so the Worker redacts it with
   the same pattern rules (`src/redact.ts`), without Gitleaks.
3. A `search` tool (FTS5 over summaries) sits next to `zoom` and `date`; the spec allows only zoom.
   The system prompt says to zoom into a hit before relying on it.
4. A failed node retries after 10 seconds rather than at the next message, so a bulk import keeps
   moving.
5. Unsummarized lines count as 0 bytes in a view's size, since no call sees them. Otherwise a bulk
   import, which appends every message first, keeps both views over budget.
6. Ready merges start before leaves, so built parents keep both views within budget.
7. A turn waits at most 10 seconds for its view, where the gist waits for every earlier message to
   be summarized. The gist has one writer; here imports and other nodes' logs also append, so that
   wait could last minutes or never end. While a turn waits, merges are held back and the compactor
   builds leaves only. A line still missing then shows its kind and size instead of its text,
   `(not summarized yet: echo, 9000 bytes; zoom(41, 1) reads it)`, so no call sees half a message.
   The compactor runs beside turns, and any wake ends the alarm's wait on it, since Durable Object
   alarms do not overlap.

Everything else follows revision `3c190e0`: the batched view (128 KB down to 64 KB), the
compactions' own 16–32 KB view, the merge rule `(T - last) / 2^l` (tested against Taelin's push),
one system prompt and tool list for turns and compactions, the ruler and retry text, up to 8
parallel leaves from a queue, and the saved view. Text over 30,000 characters is logged as
consecutive messages; the `[part k/n]` markers are ours. The prompt in `src/prompts.ts` names its
changes. Prompt caching needs a `session-id` header; with `prompt_cache_key` alone the backend
cached nothing (probed).

**Model access.** chatgpt.com refuses bulk calls from Cloudflare's network: during the first history
batch (2026-10-09), compactions from the Master got non-JSON 403s and fell to about one node a
minute, while the laptop only ever saw 429s. So a node with `"models": true` in its configuration
serves the Master's model calls, turns and compactions alike, over its WebSocket (`model_request` /
`model_result`), with that machine's Codex or Pi login. Without such a node online, the Master calls
`chatgpt.com/backend-api` itself with its own device login, rotating its refresh token in Durable
Object storage. Each node uses its own Pi login, and the Sandbox's Durable Object is the only writer
of its refresh token. The Claude subscription is usable only through Claude Code itself, so it is
not a cloud path.

**Compactor probe (2026-10-04).** 24 real messages through the earlier COMPACT prompt on Sol: 0
refusals, 6 lines over 512 bytes by 1–44 bytes, which the retry loop handles.

## Architecture

```
            you: web chat / terminal (only you; one log, one writer)
                              ▼
┌──────────────── Cloudflare ─────────────────────────────────────────┐
│ Worker: owner auth                                                   │
│ Durable Object "Master" (always addressable, wakes on msg/alarm)     │
│   SQLite: log, tree, FTS5, quota ledger, machines, spawns, turns     │
│   compactor pump (alarms, 8 jobs, pauses at 80% of either window)    │
│   turn loop beside it: view + message → ChatGPT backend              │
│   tools: zoom, date, session, search, transcript, machines, spawn,   │
│          tell, abort, schedule(s), codemode                          │
│ R2: transcripts, audit log, Sandbox workspace backups                │
└────────────▲───────────────────────▲─────────────────────▲──────────┘
             │ outbound WebSocket    │                     │
     node daemon (laptop)    node daemon (server)   Sandbox container
       pi --mode rpc            pi --mode rpc         pi --mode rpc
       live ingest + redaction
```

- **Model relay:** the laptop node makes the Master's model calls, since the backend refuses bulk
  calls from Cloudflare.
- **Node daemon:** connects out over a hibernatable WebSocket, runs approved tasks as
  `pi --mode rpc` in an allowed directory, and sends one report per task after local redaction.
  `tell` maps to Pi steering and `abort` to Pi abort.
- **Durable turns:** each step of a turn is saved in SQLite, so an eviction resumes mid-turn.
  Messages sent during a turn join it at the next tool boundary.
- **Security:** only the owner can start turns. Each node has its own key and directory allowlist;
  Pi `bash`, `edit`, and `write` calls wait for owner approval after a local secret scan; every
  spawn and decision is audited in R2. A public persona would need a separate Durable Object without
  `spawn`.
