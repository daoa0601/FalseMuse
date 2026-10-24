# OptChat memory over all local agent logs

Goal: one master agent whose memory is a
[Taelin OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) tree. The
master spawns **Pi sessions as subagents** on any connected machine (this laptop or a home server)
and coding threads in T3 Code. History from every past Codex, Claude Code, Prime, and Pi session
seeds the memory. Model calls use the ChatGPT Pro subscription; there is no API key or AI Gateway.

This follows the gist's own design: §9's master that spawns subagents and logs only their reports,
and §10's always-on host. The host began as a Durable Object; since 2026-10-24 it is the laptop, and
Pi's RPC mode is the subagent runtime. Cloudflare keeps an inbox and the backup. See
[Direction: a local Master](#direction-a-local-master-decided-2026-10-24).

## Status

| Phase                                 | State                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Corpus measurement                 | Done                                                                                                                                                                                                                                                                                                                      |
| 1. Normalizer and redaction           | Done 2026-10-05, with zero Gitleaks findings after redaction                                                                                                                                                                                                                                                              |
| 2. Local memory prototype (one month) | Done 2026-10-09. Three complete trees of one month's messages. Retrieval, 10 questions answered by Sol with zoom, date and search, graded by Sol: Luna on gist `3c190e0` 9/10 in 28 tool calls, Luna on `f51fe5c` 8.5/10 in 42, Sol on `f51fe5c` 10/10 in 32. Every miss said it could not find the answer; none guessed. |
| 3. Master                             | Log, tree, compactor, turn loop, web and terminal chat. History imported 2026-10-10 with no failing nodes. Ran as a Durable Object until it moved to the laptop on 2026-10-24 (L1–L5 below).                                                                                                                              |
| 4. Laptop node and spawn              | Deployed: daemon under launchd, Pi RPC tasks, per-call owner approval, steering, abort, report outbox, task recovery, R2 audit, quota ledger                                                                                                                                                                              |
| 5. More nodes                         | Home server not set up; live ingest on since 2026-10-11, following hand-run sessions from the import's end. The Sandbox fallback was removed in L5.                                                                                                                                                                       |
| 6. Muse behaviour                     | Scheduled prompts and Code Mode deployed; Telegram/Discord and gated self-redeploy not started                                                                                                                                                                                                                            |

**Next:** a first restore from the R2 backup (see Open issues).

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
since its API is young; the node daemon keeps log ingest, and t3code replaces its Pi task runner.

## Direction: a local Master (decided 2026-10-24)

The Durable Object buys little, because the Master's work depends on the laptop anyway.

- Model calls go through the laptop's relay, because chatgpt.com refuses bulk calls from Cloudflare.
- T3 Code threads and helpers run on the laptop, and live ingest reads its logs.
- With the laptop asleep, the Master can at best answer one chat turn from memory.

The phone already reaches the laptop through T3 Connect, where OptChat is an ACP provider. The cloud
hop costs more than it gives:

- It needs the model relay.
- It needs owner auth on a public URL. Cloudflare Access has blocked every request, the node's too,
  since 2026-10-23 22:36 UTC.
- The node socket reconnected about 1,500 times a day.
- Every prompt change needs a deploy.
- It runs on a beta `cf` CLI with a 128 MB heap.

What Cloudflare still does well is hold a copy off the laptop and take a message while the laptop
sleeps, so it keeps those two jobs.

| Step | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1   | **Host seam.** The Master's logic moves to `src/master.ts` behind a `MasterHost`: SQL, key-value settings and one alarm, a bucket for transcripts, images and audit, node sockets, the model call, and optional Code Mode and Sandbox. Every Cloudflare type stays in `src/worker.ts`, whose Durable Object becomes an adapter with no change in behaviour.                                                                                                                                                                                                                                                          |
| L2   | **Local host.** Done: `node/master.ts` runs the same Master on the laptop. It uses `node:sqlite` and files in `data/master/`, a timer for the alarm, and the laptop's own Codex or Pi login for model calls, with no relay. It serves the owner API, the page and the node WebSocket on 127.0.0.1 behind the owner key. Code Mode scripts run in a child Node process under the permission model (no files, network, DNS, processes, workers or environment), 20 seconds at most.                                                                                                                                    |
| L3   | **Move.** Done 2026-10-24. An Access application on the Worker admits the owner and the laptop's service token. The Durable Object was parked (it answers 410 outside `/api/export/`, with no alarm and no sockets) and exported: 27 tables matched by count, including 21,631 messages and 43,252 nodes, and 9,092 objects (11 GB) matched by size. `com.anhdao.optchat-master` serves it from `data/master/`; chat, the ACP agent, live ingest and the node daemon point at it. The old data stays in place until L5.                                                                                              |
| L4   | **Backup and inbox.** Done 2026-10-24; see below. A message left in the live inbox reached the local Master on connect and its reply was posted to T3 Code. The first backup sent a 32.6 MB snapshot and 125 changed files (234 MB), counting 9,091 files already in R2.                                                                                                                                                                                                                                                                                                                                             |
| L5   | **Remove.** Done 2026-10-24. The deploy reconciled the Master and Sandbox classes as deleted, with their data; their tombstones stay in `cloudflare.config.ts` until a deploy lists them as removable. The `optchat-pi` container application and its 21 image tags were deleted. The Worker serves only the inbox page, its sign-in, `/api/inbox`, `/master/inbox` and `/backup/*`, and the relay, the Worker Loader binding and the Master's device login are gone. The Master's tests now run on the local host; porting them showed it handled a node's messages concurrently, and it now handles them in order. |

L4 in detail:

- **Inbox.** An `Inbox` Durable Object in the Worker keeps messages in SQLite. The Worker's page
  becomes an inbox: the owner writes a message, sees whether the laptop is connected, and sees what
  was delivered. The local Master connects out to `/master/inbox` with the owner key and the Access
  service token. The object sends each undelivered message, and the Master queues it once as an
  owner turn (by message id) before acknowledging it. The reply is posted to T3 Code like a turn
  nobody prompted for, so the phone is notified. Pings get an automatic response, so the object
  stays hibernated between messages; the Master reconnects with backoff, as after sleep.
- **Snapshot.** Once a day, at the first chance after 03:00 local time, the host runs `VACUUM INTO`
  on a temporary file, gzips it, and uploads it in 32 MiB parts to
  `snapshots/master-<date>.sqlite.gz` through owner routes `/backup/*` (R2 multipart). Seven are
  kept.
- **Files.** After the snapshot, bucket files whose size or modification time changed since their
  last upload go to R2 under their own keys, so R2 stays a copy of the bucket. The first run counts
  files already in R2 at the same size as uploaded. The record of uploads is
  `data/master/backup.sqlite`, outside the snapshot.

Decisions:

- **The Sandbox goes.** The laptop already runs Pi and T3 Code. The export showed the Sandbox ran 4
  tasks (3 done, 1 aborted) against the laptop's 7.
- **T3 sign-ins** move with the database, and their refresh tokens keep working. New sign-ins
  redirect to localhost.
- **A home server** later either connects to the laptop's Master over Tailscale or hosts the Master
  itself, since `node/master.ts` is portable.
- **The laptop sleeps.** Schedules and thread checks that fall due while it sleeps run when it
  wakes.

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
- **With the laptop off there is no Master.** The inbox holds messages until it wakes. A home server
  running `node/master.ts` would remove the single point.
- **Restoring from R2** is by hand: gunzip the newest snapshot into `data/master/master.sqlite` and
  copy the bucket's keys, except `snapshots/` and `backups/`, into `data/master/bucket/`. No restore
  has been tried.
- **Not yet verified live:** model calls after the Codex CLI's access token expires while the Master
  runs, recovery of a turn interrupted mid-call, and abort during model streaming.
- **Tombstones.** `Master` and `Sandbox` stay in `cloudflare.config.ts` as deleted exports until a
  deploy reports them removable.
- **Posted replies** go to the inbox of the first signed-in computer that takes them, so a second
  computer gets its own inbox only while the first is offline. Repeated posts are no-ops by request
  id, but an inbox that refuses a post is replaced, so a passing T3 Code error can leave a second
  inbox. Five failed tries leave a post unsent, with its reason in `/api/posts`.
- **Images** go to the model inline on every step of their turn (up to 20 MiB a message); memory
  keeps only the `[image key]` marker and the reply's words. The web page cannot attach images yet.
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
2. Secrets are redacted (pattern rules plus Gitleaks) before anything enters memory or the bucket.
   T3 Code thread text is the exception: it reaches the Master directly, so the Master redacts it
   with the same pattern rules (`src/redact.ts`), without Gitleaks.
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
   The compactor runs beside turns, and any wake ends the alarm's wait on it, since alarm runs do
   not overlap.

Everything else follows revision `3c190e0`: the batched view (128 KB down to 64 KB), the
compactions' own 16–32 KB view, the merge rule `(T - last) / 2^l` (tested against Taelin's push),
one system prompt and tool list for turns and compactions, the ruler and retry text, up to 8
parallel leaves from a queue, and the saved view. Text over 30,000 characters is logged as
consecutive messages; the `[part k/n]` markers are ours. The prompt in `src/prompts.ts` names its
changes. Prompt caching needs a `session-id` header; with `prompt_cache_key` alone the backend
cached nothing (probed).

**Model access.** chatgpt.com refuses bulk calls from Cloudflare's network: during the first history
batch (2026-10-09), compactions from the cloud Master got non-JSON 403s and fell to about one node a
minute, while the laptop only ever saw 429s. That led first to a relay through the laptop and then
to moving the Master there. The Master calls `chatgpt.com/backend-api` with the laptop's Codex CLI
token, or Pi's login, and never rotates either; each node uses its own Pi login. The Claude
subscription is usable only through Claude Code itself, so it is not a path for the Master.

**Cloudflare budget.** Only the `Inbox` Durable Object remains. Pings get an automatic response, so
it stays hibernated between messages and bills almost no duration; the backup goes to R2 through the
Worker.

**Subagents cost time.** The Master fans out: any number of T3 Code threads (`launch`), helpers
(`delegate`) and Pi tasks (`spawn`) run at once on the owner's computers, each reporting back as a
`work` message, and a T3 Code thread can start its own child agents with T3 Code's `delegate_task`.
The limit is the subscription's rate limits.

**Compactor probe (2026-10-04).** 24 real messages through the earlier COMPACT prompt on Sol: 0
refusals, 6 lines over 512 bytes by 1–44 bytes, which the retry loop handles.

## Architecture

```
   you: web page / terminal / T3 Code (ACP), and the phone through T3 Connect
                                  ▼
┌──────────── laptop ───────────────────────────────────────────────────┐
│ Master: node/master.ts under launchd, on 127.0.0.1:8790               │
│   SQLite: log, tree, FTS5, quota ledger, machines, spawns, turns      │
│   compactor pump (8 jobs, pauses at 80% of either quota window)       │
│   turn loop beside it: view + message → ChatGPT backend               │
│   tools: memory, schedules, codemode, spawn, T3 Code threads, helpers │
│   bucket: data/master/bucket (transcripts, images, audit)             │
│ node daemon: pi --mode rpc, live ingest + redaction                   │
│ T3 Code: threads and helpers, reached over MCP                        │
└──────────┬────────────────────────────────────────────────────────────┘
           │ outbound: /master/inbox WebSocket and /backup/*
┌──────────▼──── Cloudflare, behind Access ─────────────────────────────┐
│ Worker: inbox page, owner sign-in, backup routes                      │
│ Durable Object "Inbox": the owner's messages while the laptop is away │
│ R2: daily database snapshots and a copy of the bucket                 │
└───────────────────────────────────────────────────────────────────────┘
```

- **Node daemon:** connects out over a WebSocket, runs approved tasks as `pi --mode rpc` in an
  allowed directory, and sends one report per task after local redaction. `tell` maps to Pi steering
  and `abort` to Pi abort. The Master handles each node's messages one at a time, in order.
- **Durable turns:** each step of a turn is saved in SQLite, so a restart resumes mid-turn. Messages
  sent during a turn join it at the next tool boundary.
- **Security:** only the owner can start turns. Each node has its own key and directory allowlist;
  Pi `bash`, `edit`, and `write` calls wait for owner approval after a local secret scan; every
  spawn and decision is audited in the bucket. A public persona would need a separate Master without
  `spawn`.
