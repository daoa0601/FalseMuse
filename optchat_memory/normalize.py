"""Export scope A and redacted transcripts. This command performs no network I/O."""

import argparse
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess

from .redaction import Redactor, check_export, scan_and_redact
from .sources import ROOTS, Session, discover, records, scope_a

CONFIG = Path(__file__).resolve().parents[1] / "gitleaks.toml"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="home directory containing the agent logs")
    parser.add_argument("--output", type=Path, required=True, help="new, private local directory; must not already exist")
    parser.add_argument("--source", action="append", choices=list(ROOTS), help="limit a trial run to a source; repeat to select several")
    parser.add_argument("--resume", action="store_true", help="resume the prepared transcripts in --output")
    args = parser.parse_args()
    try:
        if args.resume:
            finish_export(args.output.resolve())
        else:
            export(args.home.resolve(), args.output.resolve(), args.source or list(ROOTS))
    except (OSError, ValueError) as error:
        parser.exit(1, f"Phase 1 stopped: {error}\n")


def export(home: Path, output: Path, sources: list[str]) -> dict:
    if not shutil.which("gitleaks"):
        raise ValueError("gitleaks is required; install it with brew install gitleaks")
    if output.exists():
        raise ValueError(f"{output}: choose a new output directory")
    if any(output.is_relative_to(home / ROOTS[source]) for source in sources):
        raise ValueError("output must be outside the source log directories")
    os.umask(0o077)
    output.mkdir(parents=True, mode=0o700)
    print("Discovering main and subagent sessions", flush=True)
    sessions, duplicates, non_chat_files = discover(home, sources)
    if not sessions:
        raise ValueError("no sessions found in the selected sources")
    redactor = Redactor()
    print(f"Redacting transcripts for {len(sessions):,} sessions", flush=True)
    transcript_rows = 0
    for index, session in enumerate(sessions, 1):
        path = output / "transcripts" / f"{session.name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as handle:
            for line, event in records(session.path, session.snapshot_bytes):
                cleaned = redactor.event(event)
                if cleaned is not None:
                    write_json(handle, {"line": line, "event": cleaned})
                    transcript_rows += 1
        if index % 100 == 0 or index == len(sessions):
            print(f"Transcripts: {index:,}/{len(sessions):,}", flush=True)
    preparation = {
        "format_version": 2,
        "sessions": [{**asdict(session), "path": str(session.path)} for session in sessions],
        "duplicate_sessions_skipped": duplicates, "non_chat_files_skipped": non_chat_files,
        "transcript_records": transcript_rows, "redactions": dict(redactor.counts),
    }
    (output / "preparation.json").write_text(json.dumps(preparation, indent=2) + "\n")
    return finish_export(output)


def finish_export(output: Path) -> dict:
    if (output / "summary.json").exists():
        raise ValueError(f"{output}: this export is already complete")
    preparation = json.loads((output / "preparation.json").read_text())
    if preparation.get("format_version") != 2:
        raise ValueError("unsupported preparation format")
    os.umask(0o077)
    sessions = [Session(**{**entry, "path": Path(entry["path"])}) for entry in preparation["sessions"]]
    transcript_scan = scan_and_redact(output / "transcripts", CONFIG)
    redactor = Redactor()
    counts = write_memory(output, sessions, redactor)
    # Scan derived text too: joining Claude blocks can reveal a previously split credential.
    final_scan = check_export(output, CONFIG)
    summary = {
        "format_version": 2, "created_at": datetime.now(timezone.utc).isoformat(), "scope": "A",
        "sources": {source: dict(counter) for source, counter in counts.items()},
        "duplicate_sessions_skipped": preparation["duplicate_sessions_skipped"],
        "non_chat_files_skipped": preparation["non_chat_files_skipped"],
        "transcript_records": preparation["transcript_records"],
        "redactions": preparation["redactions"], "transcript_scan": transcript_scan,
        "preparation_note": preparation.get("recovery_note"),
        "final_scan": final_scan,
        "gitleaks_version": subprocess.check_output(["gitleaks", "version"], text=True).strip(),
        "spot_check": "pending: review samples.jsonl before upload",
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2), flush=True)
    return summary


def write_memory(output: Path, sessions: list[Session], redactor: Redactor) -> dict:
    print("Writing scope-A sessions in start-time order", flush=True)
    (output / "sessions").mkdir(exist_ok=True)
    counts: dict[str, Counter] = defaultdict(Counter)
    manifest = []
    with (output / "import.jsonl").open("w") as combined:
        for session in sessions:
            transcript = output / "transcripts" / f"{session.name}.jsonl"
            entry = {
                "session": session.name, "source": session.source, "started_at": session.started_at,
                "kind": session.kind, "source_path": str(session.path),
                "snapshot_bytes": session.snapshot_bytes,
                "transcript": str(transcript.relative_to(output)),
            }
            counts[session.source][f"{session.kind}_sessions"] += 1
            if session.kind == "main":
                messages = scope_a(session, transcript)
                path = output / "sessions" / f"{session.name}.jsonl"
                path.parent.mkdir(parents=True, exist_ok=True)
                kinds = Counter(message.kind for message in messages)
                entry.update({"messages": len(messages), "kinds": dict(kinds), "normalized": str(path.relative_to(output))})
                counts[session.source].update(kinds)
                with path.open("w") as handle:
                    for number, message in enumerate(messages, 1):
                        row = {"session": session.name, "index": number, **asdict(message), "text": redactor.text(message.text)}
                        write_json(handle, row)
                        write_json(combined, row)
            manifest.append(entry)
    with (output / "manifest.jsonl").open("w") as handle:
        for entry in manifest:
            write_json(handle, entry)
    write_samples(output, manifest)
    return counts


def write_samples(output: Path, manifest: list[dict]) -> None:
    groups: dict[str, list[dict]] = defaultdict(list)
    for entry in manifest:
        if entry["kind"] == "main" and entry.get("messages"):
            groups[entry["source"]].append(entry)
    with (output / "samples.jsonl").open("w") as handle:
        for source, entries in groups.items():
            for index in spread_indices(len(entries), 20):
                entry = entries[index]
                messages = [row for _, row in records(output / entry["normalized"])]
                selected = set(spread_indices(len(messages), 3))
                for kind in ("user", "talk", "work"):
                    first = next((i for i, row in enumerate(messages) if row["kind"] == kind), None)
                    if first is not None:
                        selected.add(first)
                excerpts = [{"index": messages[i]["index"], "line": messages[i]["line"], "kind": messages[i]["kind"], "text": messages[i]["text"][:360]} for i in sorted(selected)]
                write_json(handle, {"source": source, "session": entry["session"], "started_at": entry["started_at"], "normalized": entry["normalized"], "transcript": entry["transcript"], "excerpts": excerpts})


def spread_indices(length: int, count: int) -> list[int]:
    if length <= count:
        return list(range(length))
    return [i * (length - 1) // (count - 1) for i in range(count)]


def write_json(handle, value: dict) -> None:
    handle.write(json.dumps(value, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
