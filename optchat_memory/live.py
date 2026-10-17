"""Prepare changed recordings locally and upload completed scope-A batches."""

import argparse
from contextlib import redirect_stdout
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
from urllib.request import Request, urlopen

from .normalize import CONFIG
from .redaction import Redactor, scan_and_redact
from .sources import ROOTS, Session, custom_report, identify, positioned, records, scope_a, text_blocks


def session_name(session: Session) -> str:
    family = "codex" if session.source == "codex-archived" else session.source
    return f"{family}/{session.id}"


def completed_line(source: str, events) -> int:
    boundary = 0
    claude_finals = set()
    for line, event in events:
        payload = event.get("payload", {})
        message = event.get("message", {})
        if source.startswith("codex"):
            if event.get("type") == "event_msg" and payload.get("type") == "task_complete":
                boundary = line
        elif source == "claude":
            if event.get("type") == "assistant" and event.get("uuid") and message.get("stop_reason") == "end_turn" and text_blocks(message.get("content")):
                claude_finals.add(event.get("uuid"))
            if event.get("type") == "last-prompt" and event.get("leafUuid") in claude_finals:
                boundary = line
        elif event.get("type") == "message" and message.get("role") == "assistant" and message.get("stopReason") == "stop":
            boundary = line
        if event.get("type") == "custom_message" and custom_report(event):
            boundary = line
    return boundary


@dataclass(frozen=True)
class Copy:
    """How far a recording's redacted copy reaches: the native offset and line read, and its size."""
    offset: int = 0
    line: int = 0
    size: int = 0


def prepare(session: Session, work: Path, transcript: Path, after_line: int, done: Copy = Copy()) -> tuple[int, list[dict], Copy]:
    """Redact and scan the records after `done`, append them to the redacted `transcript`, and
    return the completed boundary, the scope-A messages after `after_line`, and how far the copy
    now reaches. New records are scanned on their own: a secret never spans two JSONL records."""
    work.mkdir(mode=0o700)
    # Compute completion from native metadata; redaction can withhold its payload.
    boundary = completed_line(session.source, records(session.path, session.snapshot_bytes))
    if not transcript.exists() or transcript.stat().st_size < done.size:
        done = Copy()
    redactor = Redactor()
    added = work / "added"
    added.mkdir()
    offset, line = done.offset, done.line
    with (added / "transcript.jsonl").open("w") as handle:
        for line, event, offset in positioned(session.path, session.snapshot_bytes, (done.offset, done.line)):
            cleaned = redactor.event(event)
            if cleaned is not None:
                handle.write(json.dumps({"line": line, "event": cleaned}, ensure_ascii=False) + "\n")
    scan_and_redact(added, CONFIG)
    # A copy longer than `done` holds records from an attempt that was never recorded.
    with transcript.open("ab") as handle:
        handle.truncate(done.size)
        handle.write((added / "transcript.jsonl").read_bytes())
    copy = Copy(offset, line, transcript.stat().st_size)
    if session.kind != "main":
        return boundary, [], copy
    complete = work / "complete.jsonl"
    with complete.open("w") as handle:
        for _, wrapper in records(transcript):
            if wrapper["line"] > boundary:
                break
            handle.write(json.dumps(wrapper, ensure_ascii=False) + "\n")
    messages = [
        {**asdict(message), "session": session_name(session), "index": message.line}
        for message in scope_a(session, complete) if message.line > after_line
    ]
    if not messages:
        return boundary, [], copy
    joined = work / "messages"
    joined.mkdir()
    (joined / "messages.jsonl").write_text("".join(json.dumps(message, ensure_ascii=False) + "\n" for message in messages))
    # Joined text can reveal a secret split across recorded Claude blocks.
    scan_and_redact(joined, CONFIG)
    messages = [row for _, row in records(joined / "messages.jsonl")]
    if any("text" not in row for row in messages):
        raise ValueError("A live message could not be safely redacted; the original recording remains local")
    return boundary, messages, copy


class LiveIngest:
    def __init__(self, home: Path, state: Path, baseline: Path | None = None):
        self.home = home
        self.directory = state.parent
        self.paths = {}
        self.skipped = set()
        state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = sqlite3.connect(state)
        self.database.execute("CREATE TABLE IF NOT EXISTS recordings (session TEXT PRIMARY KEY, size INTEGER, modified INTEGER, line INTEGER)")
        columns = {row[1] for row in self.database.execute("PRAGMA table_info(recordings)")}
        for column in ("copy_offset", "copy_line", "copy_size"):
            if column not in columns:
                self.database.execute(f"ALTER TABLE recordings ADD COLUMN {column} INTEGER")
        # Each recording's redacted copy, extended as it grows so only new records are scanned.
        self.copies = self.directory / "live-copies"
        self.copies.mkdir(exist_ok=True, mode=0o700)
        self.database.execute("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT)")
        if baseline and not self.database.execute("SELECT 1 FROM settings WHERE name='baseline'").fetchone():
            for _, entry in records(baseline / "manifest.jsonl"):
                family = "codex" if entry["source"] == "codex-archived" else entry["source"]
                name = family + "/" + entry["session"].split("/", 1)[1]
                normalized = baseline / entry["normalized"] if entry.get("normalized") else None
                line = max((row["line"] for _, row in records(normalized)), default=0) if normalized else 0
                self.database.execute("INSERT OR IGNORE INTO recordings (session, size, modified, line) VALUES (?, ?, 0, ?)", (name, entry["snapshot_bytes"], line))
                self.paths[entry["source_path"]] = (entry["snapshot_bytes"], 0)
            self.database.execute("INSERT INTO settings VALUES ('baseline', ?)", (str(baseline),))
            self.database.commit()

    def changed(self):
        sessions = []
        candidates = {}
        for source, directory in ROOTS.items():
            root = self.home / directory
            for path in root.rglob("*.jsonl"):
                if path.name in ("semantic-edges.jsonl", "journal.jsonl"):
                    continue
                stat = path.stat()
                old = self.paths.get(str(path))
                if old and old[0] == stat.st_size and old[1] in (0, stat.st_mtime_ns):
                    continue
                if next(records(path), None) is None:
                    continue
                session = identify(source, root, path)
                name = session_name(session)
                if name not in candidates or session.snapshot_bytes > candidates[name].snapshot_bytes:
                    candidates[name] = session
        for name, session in candidates.items():
            previous = self.database.execute("SELECT size, modified FROM recordings WHERE session=?", (name,)).fetchone()
            modified = session.path.stat().st_mtime_ns
            if previous and (previous == (session.snapshot_bytes, modified) or (previous[1] == 0 and previous[0] == session.snapshot_bytes)):
                self.paths[str(session.path)] = (session.snapshot_bytes, modified)
                continue
            if previous and session.snapshot_bytes < previous[0]:
                # Another recording under a known name (Claude subagent ids repeat across parent
                # sessions) or a shortened one: it stays local and the others go on.
                self.skipped.add(str(session.path))
                self.paths[str(session.path)] = (session.snapshot_bytes, modified)
                continue
            sessions.append((session, modified))
        return sorted(sessions, key=lambda pair: (pair[0].started_at, pair[0].name))

    def sync(self, upload) -> dict:
        counts: dict = {"recordings": 0, "messages": 0}
        already = set(self.skipped)
        for session, modified in self.changed():
            name = session_name(session)
            previous = self.database.execute("SELECT line, copy_offset, copy_line, copy_size FROM recordings WHERE session=?", (name,)).fetchone()
            after = previous[0] if previous else 0
            if previous and completed_line(session.source, records(session.path, session.snapshot_bytes)) <= after:
                # Only completed records become messages; the rest waits for its turn to finish.
                self.paths[str(session.path)] = (session.snapshot_bytes, modified)
                continue
            done = Copy(*previous[1:]) if previous and previous[1] is not None else Copy()
            transcript = self.copies / (hashlib.sha256(name.encode()).hexdigest()[:32] + ".jsonl")
            with tempfile.TemporaryDirectory(prefix="optchat-live-", dir=self.directory) as temp:
                with redirect_stdout(io.StringIO()):
                    boundary, messages, copy = prepare(session, Path(temp) / "prepared", transcript, after, done)
                upload(session, transcript, messages)
            self.database.execute(
                "INSERT INTO recordings (session, size, modified, line, copy_offset, copy_line, copy_size) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(session) DO UPDATE SET size=excluded.size, modified=excluded.modified, line=excluded.line, "
                "copy_offset=excluded.copy_offset, copy_line=excluded.copy_line, copy_size=excluded.copy_size",
                (name, session.snapshot_bytes, modified, max(after, boundary), copy.offset, copy.line, copy.size))
            self.database.commit()
            self.paths[str(session.path)] = (session.snapshot_bytes, modified)
            counts["recordings"] += 1
            counts["messages"] += len(messages)
        if self.skipped - already:
            counts["skipped"] = sorted(self.skipped - already)
        return counts

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--state", type=Path, default=Path("data/live-ingest.sqlite"))
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--interval", type=int, default=60)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    ingest = LiveIngest(args.home, args.state, args.baseline)

    def upload(session, transcript, messages):
        # Cloudflare refuses urllib's default User-Agent (error 1010) before the Worker sees it.
        headers = {"authorization": "Bearer " + config["key"], "user-agent": "OptChat-node/1"}
        name = session_name(session)
        body = {"session": name, "kind": session.kind}
        with urlopen(Request(config["url"] + "/node/recordings", json.dumps(body).encode(), {**headers, "content-type": "application/json"}), timeout=60) as response:
            response.read()
        key = f"live/{config['name']}/{name}"
        with urlopen(Request(config["url"] + "/node/transcript?session=" + key, transcript.read_bytes(), headers, method="PUT"), timeout=60) as response:
            response.read()
        with urlopen(Request(config["url"] + "/node/ingest", json.dumps({"session": name, "messages": messages}).encode(), {**headers, "content-type": "application/json"}), timeout=60) as response:
            response.read()

    try:
        while True:
            try:
                print(json.dumps({"date": datetime.now(timezone.utc).isoformat(), **ingest.sync(upload)}), flush=True)
            except (OSError, ValueError) as error:
                if not args.watch:
                    raise
                print(json.dumps({"date": datetime.now(timezone.utc).isoformat(), "error": str(error), "action": "recordings remain local; retrying"}), flush=True)
            if not args.watch:
                break
            time.sleep(max(10, args.interval))
    finally:
        ingest.database.close()


if __name__ == "__main__":
    main()
