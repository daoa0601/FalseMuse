"""Prepare a completed Pi transcript and report for upload using Phase 1's gate."""
import json
from pathlib import Path
import sys
from optchat_memory.redaction import Redactor, scan_and_redact

source, report_source, output = map(Path, sys.argv[1:4])
report_only = "--report-only" in sys.argv[4:]
output.mkdir(parents=True, exist_ok=True, mode=0o700)
redactor = Redactor()
transcript = output / "transcript.jsonl"
if source.exists() and not report_only:
    with source.open() as incoming, transcript.open("w") as outgoing:
        for line in incoming:
            event = redactor.event(json.loads(line))
            if event is not None:
                outgoing.write(json.dumps(event, ensure_ascii=False) + "\n")
    transcript.chmod(0o600)
else:
    transcript.unlink(missing_ok=True)
(output / "report.json").write_text(json.dumps({"text": redactor.text(report_source.read_text())}))
(output / "report.json").chmod(0o600)
scan_and_redact(output, Path(__file__).resolve().parents[1] / "gitleaks.toml")
