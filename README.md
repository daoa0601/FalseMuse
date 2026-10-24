# optchat-memory

An always-on master agent in a Cloudflare Durable Object, with
[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) memory built from
every local Codex, Claude Code, Prime, and Pi session. It spawns Pi sessions on connected machines.
Design, status, and open issues are in [PLAN.md](PLAN.md).

## Layout

| Path              | Runs on                  | Contents                                                                 |
| ----------------- | ------------------------ | ------------------------------------------------------------------------ |
| `src/`            | Worker (and shared)      | Memory tree, compactor, Master Durable Object, Sandbox, node protocol    |
| `node/`           | Each machine             | Node daemon, Pi RPC client, Pi extensions, task journal, SQLite adapter  |
| `scripts/`        | Laptop                   | Owner CLI: chat, login, node registration, prototype, Sandbox image prep |
| `optchat_memory/` | Laptop (Python)          | History normalizer, secret redaction, live ingest of hand-run sessions   |
| `tests/`          | Node test runner, Python | Unit tests and Worker tests on the local Cloudflare runtime              |
| `data/`           | Laptop only, ignored     | Exports, prototype databases, credentials, node state. Never committed.  |

TypeScript runs directly through Node type stripping (Node 22.22+), so nothing is compiled except
the Worker bundle.

## Setup and checks

```bash
pnpm install
pnpm hooks:install
pnpm quality:offline
```

`hooks:install` copies `.githooks/` into Git's hooks directory: `quality:quick` runs before each
commit and `quality:offline` before each push. It refuses to replace a different existing hook.

`quality:offline` runs formatting, lint, both strict typechecks (Node and Worker), the secret scan,
the JavaScript tests, and the Python tests. `pnpm test` builds the Worker and its Sandbox image with
`cf build` (Docker must be running) and then runs the JavaScript tests. Before the first build,
stage the Sandbox image context:

```bash
node scripts/prepare-sandbox.ts
```

The Python tests and tools need Python 3.11+ and [Gitleaks](https://github.com/gitleaks/gitleaks).

## History export (Phase 1)

```bash
python3 -m optchat_memory.normalize --output data/phase1
```

This reads the local agent logs, writes scope-A sessions, `import.jsonl` (sessions in start order),
and redacted transcripts, and fails unless Gitleaks finds nothing after redaction. Add
`--source prime --source pi` for a small trial, `--home <dir>` for another corpus, and `--resume` to
continue a stopped scan. Nothing is uploaded and no model is called.

## Memory prototype (Phase 2)

```bash
pnpm prototype 2026-09 gpt-6-luna 4000
```

This builds the tree for the sessions active in one month in `data/prototype-<month>-<model>/`,
resuming from its SQLite database. The third argument limits paid nodes. Add `cloud` to start the
quota guard from the deployed ledger (or `local`), then optionally a label for a separate run
directory; compaction pauses at 80% of either quota window. `COMPACTOR_EFFORT` sets the reasoning
effort (`high` by default). It uses the Codex CLI's current access token, or Pi's subscription
login, and never rotates either.

## Cloud

```bash
cf build
cf deploy --secrets-file data/owner-secrets.json
node scripts/cloud-login.ts
```

If your Cloudflare login reaches more than one account, set `CLOUDFLARE_ACCOUNT_ID` in `.env`.
`data/owner-secrets.json` holds `OWNER_KEY`, which signs in the web page and authenticates the CLI.
`cloud-login.ts` starts the Master's own subscription device login; open the printed URL and enter
the code within 15 minutes.

```bash
pnpm chat "Your message"
```

The terminal chat queues a turn and waits for its reply; stopping the CLI leaves the turn running.

```bash
node scripts/instructions.ts data/instructions.md
```

Sets the instructions the Master reads at the start of each turn (who you are, how you want work
done) from a private file; without a file it prints them, and an empty file clears them. Turns also
carry the time in `OWNER_TIMEZONE` (`cloudflare.config.ts`), so the Master can schedule check-ins.

## Local Master

```bash
node node/master.ts
```

Runs the Master on this computer at `http://127.0.0.1:8790`, with its database and files in
`data/master/` and the same owner key as the cloud. It makes model calls with this computer's Codex
or Pi login, and runs Code Mode scripts in a child Node process that Node's permission model keeps
from files, network and other processes. An optional `data/master.json` sets `port`, `directory`,
`masterModel`, `compactorModel`, `compactorEffort`, `timezone` and `backupHour`.

With `worker` (the Worker's URL) in `data/cloud.json`, the Master also connects out to the Worker,
through Access with `data/access-token.json`:

- **Inbox.** The Worker's page takes a message while the laptop is away. The Master takes it as an
  owner turn when it connects, and posts the reply to T3 Code.
- **Backup.** Once a day from `backupHour` (default 3, in `timezone`), the Master sends a gzipped
  snapshot of its database to `snapshots/master-<date>.sqlite.gz` in R2, keeping seven, and sends
  every bucket file that changed under its own key. What was sent is recorded in
  `data/master/backup.sqlite`.

To move the cloud Master here, put Cloudflare Access's service token for the Worker in
`data/access-token.json` (`client_id`, `client_secret`), then:

```bash
node scripts/move-to-laptop.ts
node scripts/install-master-service.ts
```

The move parks the cloud copy (`/api/export/park`: it stops acting and answers only the export) and
copies its tables, instructions and transcripts into `data/master/`, resuming downloads if run
again. The service runs the Master under launchd as `com.anhdao.optchat-master`, logging to
`data/master.log`. Then set `url` to `http://127.0.0.1:8790` in `data/cloud.json`, which the CLI and
the ACP agent use, and in the node configuration, and restart the node daemon.

## Nodes

```bash
node scripts/register-node.ts laptop /path/to/allowed/root
node node/login.ts
node scripts/install-node-service.ts data/laptop-node.json
```

Registration issues a node key and a directory allowlist (`read` only by default). `login.ts` gives
the node its own Pi subscription login. On macOS the daemon runs under launchd as
`com.anhdao.optchat-memory`, logging to `data/node-daemon.log`; elsewhere run
`node node/daemon.ts data/<name>-node.json`. Each `bash`, `edit`, or `write` call waits for approval
in the web chat.

To have the laptop make the Master's model calls with its own Codex or Pi login (chatgpt.com refuses
bulk calls from Cloudflare), add `"models": true` to its node configuration and allow it once from
the owner side; the Sandbox cannot be allowed:

```bash
node -e 'import("./scripts/cloud-client.ts").then(({cloudClient}) => cloudClient().request("/api/nodes/laptop/models", {allowed: true})).then(console.log)'
```

The Sandbox fallback is started, logged in, and saved from the web chat. Its image contains only the
staged `.sandbox-build/` context: the daemon, the scanner, and a Git bundle of the committed
repository.

## Computers (T3 Code)

The Master starts and follows coding threads on any computer running [T3 Code](https://t3.codes),
signed in as an outside MCP agent. Turn on T3 Connect in that T3 Code. Its settings offer **Copy MCP
URL** only for other computers, so on the computer itself read the public host from the requests
that reached it through the tunnel:

```bash
grep -ohE '"server.address":"[a-z0-9.-]+\.t3coderelay\.com"' ~/.t3/userdata/logs/server.trace.ndjson | sort -u
```

```bash
node scripts/connect-computer.ts laptop https://<environment-address>/mcp
```

Open the printed page, enter a pairing code from the same settings screen, and choose the access to
grant; every thread the Master starts runs within it, and asks you in T3 Code before going beyond
it. A sign-in lasts 30 days. `GET /api/computers` lists the computers and whether each is signed in.

## OptChat in T3 Code

`bin/optchat-acp` serves OptChat as an ACP agent, so it is a provider in T3 Code on this computer
and on every phone or computer that reaches it through T3 Connect. Add it under **Settings →
Providers → Add provider → ACP**, source **Local command**, executable the absolute path of
`bin/optchat-acp`. Each OptChat thread's prompts go to the Master's one conversation, and its tool
calls and replies show in the thread; stopping a reply stops the Master's.

Give the provider the instance id `optchat` (its key under `providerInstances` in
`~/.t3/userdata/settings.json`). The Master uses it to post each reply nobody prompted for, to a
thread's report or a schedule, into one OptChat inbox thread in the Scratch project of the first
signed-in computer: it renames the inbox `OptChat: <the reply's first line>`, and T3 Code notifies
phones that allow its notifications when the post finishes. Answer in the inbox like any OptChat
thread. Deleting the inbox makes the next post start a new one. A reply of only `QUIET` is not
posted. Images attached to a message are stored in R2 under `images/` and seen with it; the Master's
`look` tool shows one again later.

## Helpers

Ask OptChat to hire a named helper, for example "hire a reviewer on my laptop in optchat-memory,
using codex gpt-6.1-sol, that reviews diffs for bugs". A helper has standing instructions, a model
(a T3 Code provider instance and model, or the project's default), and one T3 Code thread titled
`Helper: <name>` that keeps its context between jobs. Jobs you give it through OptChat queue in that
thread and report back like any thread the Master starts; open the thread to talk to the helper
directly. OptChat may give a helper part of a task you asked for; it starts work you did not ask for
only through a helper hired with `auto`. `GET /api/helpers` lists them.

A model must be one the computer's T3 Code offers (OptChat's `computers` tool lists them), and
changing it switches the helper's thread in place; going back to the project's default starts a new
thread. "Give the reviewer a fresh start" also starts a new thread. A new thread, including one that
replaces a thread you deleted, gets the helper's last eight jobs and results. Conversations you have
in the thread yourself are not among them.

OptChat splits a task whose parts can run on their own into threads and helper jobs, titled
`<task>: <part>`, and reports once when the last part is in. At most six threads run for it at once
(a thread counts for 12 hours from its start); it starts the rest as reports arrive.

## Live ingest

After the history import, set `ingest: {"baseline": "data/phase1-2026-10-05"}` in the node
configuration and restart the daemon. It then follows hand-run sessions, uploads each redacted
transcript, and appends completed scope-A messages in arrival order. A session is prepared again
only when a turn in it finishes; its redacted copy in `data/live-copies/` grows by the new records,
so Gitleaks scans only those.
