"""Redact locally, then use the native Gitleaks rules as the export gate."""

from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import binascii
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

MARKER = "[REDACTED]"
SECRET_NAME = re.compile(
    r"(?i)^(?:authorization|proxy.?authorization|cookie|set.?cookie|password|passwd|pwd|"
    r"secret|client.?secret|private.?key|api.?key|open.?ai.?key|access.?token|refresh.?token|"
    r"id.?token|auth.?token|bearer.?token|token|credential|credentials|"
    r"(?-i:[A-Za-z][A-Za-z0-9]*(?:Token|Password|Secret|APIKey|ApiKey|PrivateKey))|"
    r"[\w.-]+[_-](?:api[_-]?key|token|password|passwd|secret|private[_-]?key))$"
)
PATTERNS = (
    ("private-key", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----.*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|\Z)", re.S)),
    ("key-shaped", re.compile(r"\b(?:sk-(?:proj-|ant-[\w-]+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("bearer", re.compile(r"(?i)\bBearer\s+[A-Za-z0-9_+./=-]{16,}")),
    # Start once per scheme; retrying at every letter makes long non-URLs slow.
    ("url-password", re.compile(r"(?i)(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(@)")),
)
BASIC = re.compile(r"(?i)\bBasic\s+([A-Za-z0-9+/]+={0,2})(?![\w+/=-])")
ASSIGNMENT = re.compile(
    r'''(?im)(?<![\w.-])(?P<prefix>["']?(?P<name>[A-Z_][\w.-]*)["']?\s*(?::|=|→|->)\s*)'''
    r'''(?P<value>"[^"\n]*"|'[^'\n]*'|[^\s,;\]}]+)'''
)


class Redactor:
    def __init__(self) -> None:
        self.counts: Counter[str] = Counter()

    def event(self, value: object) -> object:
        if isinstance(value, dict):
            if value.get("type") in ("reasoning", "thinking", "redacted_thinking"):
                self.counts["reasoning-removed"] += 1
                return None
            if value.get("type") == "message" and value.get("role") == "assistant" and value.get("channel") == "analysis":
                self.counts["reasoning-removed"] += 1
                return None
            result = {}
            for key, item in value.items():
                if key in ("thinkingSignature", "encrypted_content", "signature"):
                    self.counts["reasoning-removed"] += 1
                    continue
                if SECRET_NAME.fullmatch(key) and item:
                    result[key] = MARKER
                    self.counts["credential-field"] += 1
                    continue
                cleaned = self.event(item)
                if cleaned is not None or item is None:
                    result[key] = cleaned
            return result
        if isinstance(value, list):
            result = []
            for item in value:
                cleaned = self.event(item)
                if cleaned is not None or item is None:
                    result.append(cleaned)
            return result
        return self.text(value) if isinstance(value, str) else value

    def text(self, text: str) -> str:
        for name, pattern in PATTERNS:
            replacement = r"\1[REDACTED]\2" if name == "url-password" else MARKER
            text, count = pattern.subn(replacement, text)
            self.counts[name] += count

        def basic(match: re.Match) -> str:
            try:
                decoded = base64.b64decode(match[1], validate=True)
            except (ValueError, binascii.Error):
                return match[0]
            if b":" not in decoded:
                return match[0]
            self.counts["basic-auth"] += 1
            return MARKER

        text = BASIC.sub(basic, text)

        return self.assignments(text)

    def assignments(self, text: str) -> str:
        def redact(match: re.Match) -> str:
            # A value an earlier rule redacted stays as it is.
            if not SECRET_NAME.fullmatch(match["name"]) or match["value"].startswith(MARKER[:-1]):
                return match[0]
            self.counts["credential-assignment"] += 1
            quote = match["value"][0] if match["value"][0] in "\"'" else ""
            return match["prefix"] + quote + MARKER + quote

        return ASSIGNMENT.sub(redact, text)


def scan_and_redact(directory: Path, config: Path) -> dict:
    """Finding values stay in a private temporary directory and never reach diagnostics."""
    rules: Counter[str] = Counter()
    withheld = 0
    with tempfile.TemporaryDirectory(prefix="optchat-gitleaks-") as temporary:
        temp = Path(temporary)
        for attempt in range(1, 5):
            print(f"Gitleaks pass {attempt}: {directory.name}", flush=True)
            findings = scan(directory, config, temp)
            if not findings:
                return {"passes": attempt, "findings": 0, "redacted_findings": sum(rules.values()), "rules": dict(rules), "withheld_records": withheld}
            rules.update(finding["RuleID"] for finding in findings)
            if attempt == 4:
                raise ValueError(f"Gitleaks still found {len(findings)} secrets after three redaction passes; export remains local")
            withheld += redact_findings(directory, findings)
    raise AssertionError("scan loop did not return")


def check_export(directory: Path, config: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="optchat-gitleaks-") as temporary:
        print("Gitleaks: checking scope A and metadata", flush=True)
        temp = Path(temporary)
        derived = temp / "derived"
        derived.mkdir()
        # Transcripts already passed the native scan and are no longer written.
        for name in ("sessions", "import.jsonl", "manifest.jsonl", "samples.jsonl", "preparation.json"):
            source = directory / name
            if source.is_dir():
                shutil.copytree(source, derived / name)
            else:
                shutil.copyfile(source, derived / name)
        findings = scan(derived, config, temp)
        if findings:
            rules = dict(Counter(finding["RuleID"] for finding in findings))
            raise ValueError(f"export has {len(findings)} Gitleaks findings ({rules}); no completed summary was written")
        (directory / "gitleaks.json").write_text(json.dumps(findings) + "\n")
    return {"findings": 0, "scope": "scope-A-and-metadata"}


def scan(directory: Path, config: Path, temporary: Path) -> list[dict]:
    paths = sorted(directory.rglob("*.jsonl")) + sorted(directory.glob("*.json"))
    batches = [paths[index:index + 100] for index in range(0, len(paths), 100)]
    if len(batches) <= 1:
        return scan_target(directory, config, temporary)
    findings = []
    print(f"Gitleaks: {len(batches)} batches, four local processes", flush=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(scan_batch, directory, batch, config) for batch in batches]
        for completed, future in enumerate(as_completed(futures), 1):
            findings.extend(future.result())
            if completed % 10 == 0 or completed == len(batches):
                print(f"Gitleaks batches: {completed}/{len(batches)}", flush=True)
    return findings


def scan_batch(directory: Path, paths: list[Path], config: Path) -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="optchat-scan-batch-", dir=directory.parent) as temporary:
        temp = Path(temporary)
        batch = temp / "input"
        batch.mkdir()
        for path in paths:
            link = batch / path.relative_to(directory)
            link.parent.mkdir(parents=True, exist_ok=True)
            # Scanner input is read-only. Links avoid copying gigabytes into every pass.
            os.link(path, link)
        findings = scan_target(batch, config, temp)
        for finding in findings:
            relative = Path(finding["File"]).relative_to(batch)
            finding["File"] = str(directory / relative)
        return findings


def scan_target(directory: Path, config: Path, temporary: Path) -> list[dict]:
    report = temporary / "findings.json"
    environment = {key: value for key, value in os.environ.items() if key not in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML")}
    result = subprocess.run(
        ["gitleaks", "dir", str(directory), "--config", str(config),
         "--gitleaks-ignore-path", str(temporary), "--ignore-gitleaks-allow",
         "--max-target-megabytes", "0", "--max-decode-depth", "2",
         "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", str(report)],
        capture_output=True, env=environment,
    )
    # Even a zero exit is incomplete if the scanner logged a file-read error.
    if result.returncode not in (0, 1) or result.stderr.strip():
        raise ValueError(f"Gitleaks failed (exit {result.returncode}); scanner diagnostics withheld because they may contain credentials")
    if not report.exists():
        raise ValueError("Gitleaks did not produce its JSON report")
    findings = json.loads(report.read_text())
    if result.returncode == 1 and not findings:
        raise ValueError("Gitleaks reported failure without findings")
    return findings


def redact_findings(directory: Path, findings: list[dict]) -> int:
    files: dict[Path, dict[int, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for finding in findings:
        path = Path(finding["File"]).resolve()
        if not path.is_relative_to(directory.resolve()):
            raise ValueError("Gitleaks returned a finding outside the export directory")
        for line in range(finding["StartLine"], finding["EndLine"] + 1):
            files[path][line].append(finding)
    withheld = 0
    for path, lines in files.items():
        replacement = path.with_suffix(".redacting")
        with path.open() as original, replacement.open("w") as output:
            for number, raw in enumerate(original, 1):
                if number not in lines:
                    output.write(raw)
                    continue
                record = json.loads(raw)
                for finding in lines[number]:
                    record, changed = replace_secret(record, finding["Secret"])
                    if not changed:
                        # Decoded or fragmented findings cannot always be mapped to a substring.
                        # Withhold that event, retaining its source location for local inspection.
                        record = {"line": record["line"], "event": {"type": "redacted_event", "reason": "gitleaks", "rule": finding["RuleID"]}}
                        withheld += 1
                        break
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
        replacement.replace(path)
    return withheld


def replace_secret(value: object, secret: str) -> tuple[object, bool]:
    if not secret:
        return value, False
    if isinstance(value, str):
        return value.replace(secret, MARKER), secret in value
    if isinstance(value, list):
        replacements = [replace_secret(item, secret) for item in value]
        return [item for item, _ in replacements], any(changed for _, changed in replacements)
    if isinstance(value, dict):
        replacements = {key: replace_secret(item, secret) for key, item in value.items()}
        return {key: item for key, (item, _) in replacements.items()}, any(changed for _, changed in replacements.values())
    return value, False
