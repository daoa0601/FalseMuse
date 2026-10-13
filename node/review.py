"""Prepare a tool proposal locally before it reaches the owner's web chat."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile

from optchat_memory.redaction import Redactor, scan_and_redact


def prepare(proposal: dict) -> str:
    redactor = Redactor()
    with tempfile.TemporaryDirectory(prefix="optchat-review-") as temporary:
        directory = Path(temporary)
        path = directory / "proposal.jsonl"
        path.write_text(json.dumps(redactor.event(proposal), ensure_ascii=False) + "\n")
        with redirect_stdout(io.StringIO()):
            scanned = scan_and_redact(directory, Path(__file__).resolve().parents[1] / "gitleaks.toml")
        if scanned["withheld_records"]:
            raise ValueError("The scanner withheld this proposal; review it locally")
        result = json.loads(path.read_text())
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if any(redactor.counts.values()) or scanned["redacted_findings"]:
            text = "Credential values were redacted from this proposal.\n\n" + text
        if len(text.encode()) > 128_000:
            raise ValueError("This proposal exceeds the review limit; split the change into smaller tool calls")
        return text


if __name__ == "__main__":
    try:
        print(json.dumps({"text": prepare(json.load(sys.stdin))}, ensure_ascii=False))
    except (OSError, ValueError) as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
