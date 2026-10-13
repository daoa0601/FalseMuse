import io
import json
from pathlib import Path
import tempfile
import unittest
from contextlib import redirect_stdout

from optchat_memory.live import LiveIngest, prepare
from optchat_memory.sources import ROOTS, identify


class LiveIngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.path = self.home / ROOTS["codex"] / "session.jsonl"
        self.path.parent.mkdir(parents=True)
        self.add({"type": "session_meta", "payload": {"id": "session", "timestamp": "2026-10-01T10:00:00Z", "source": "cli"}})

    def add(self, event):
        with self.path.open("a") as handle:
            handle.write(json.dumps({"timestamp": "2026-10-01T10:00:00Z", **event}) + "\n")

    def message(self, role, text, **extra):
        return {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}], **extra}}

    def test_completed_turn_is_uploaded_once_and_unfinished_records_wait(self):
        self.add(self.message("user", "Find the parser bug."))
        self.add(self.message("assistant", "Inspecting it.", phase="commentary"))
        ingest = LiveIngest(self.home, self.root / "state.sqlite")
        uploads = []
        def upload(session, transcript, messages):
            uploads.append(messages)
        ingest.sync(upload)
        self.assertEqual(uploads[-1], [])
        self.add(self.message("assistant", "Fixed the parser.", phase="final_answer"))
        self.add({"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Fixed the parser."}})
        ingest.sync(upload)
        self.assertEqual([m["text"] for m in uploads[-1]], ["Find the parser bug.", "Fixed the parser."])
        self.assertEqual([m["index"] for m in uploads[-1]], [2, 4])
        ingest.database.close()
        restarted = LiveIngest(self.home, self.root / "state.sqlite")
        self.assertEqual(restarted.sync(upload)["messages"], 0)
        restarted.database.close()

    def test_a_forked_codex_rollout_is_its_own_session(self):
        # A fork starts with its own session_meta, then copies its parent's.
        fork = self.path.with_name("fork.jsonl")
        meta = lambda id, source, at: json.dumps({"timestamp": at, "type": "session_meta", "payload": {"id": id, "timestamp": at, "source": source}})
        fork.write_text(meta("fork", {"subagent": {}}, "2026-10-01T11:00:00Z") + "\n" + meta("session", "cli", "2026-10-01T10:00:00Z") + "\n")
        session = identify("codex", self.home / ROOTS["codex"], fork)
        self.assertEqual((session.id, session.started_at, session.kind), ("fork", "2026-10-01T11:00:00.000Z", "subagent"))

    def test_a_smaller_recording_under_a_known_name_is_skipped_once_without_blocking_others(self):
        self.add(self.message("user", "Read the configuration."))
        ingest = LiveIngest(self.home, self.root / "state.sqlite")
        try:
            ingest.sync(lambda *args: None)
            # Another recording with the same name and fewer bytes, as Claude subagent files from
            # different parents can be.
            other = self.home / ROOTS["codex"] / "copy" / "session.jsonl"
            other.parent.mkdir()
            other.write_text(self.path.read_text().splitlines()[0] + "\n")
            uploads = []
            first = ingest.sync(lambda session, transcript, messages: uploads.append(session.path))
            self.add(self.message("assistant", "Configuration read.", phase="final_answer"))
            self.add({"type": "event_msg", "payload": {"type": "task_complete"}})
            second = ingest.sync(lambda session, transcript, messages: uploads.append(session.path))
            self.assertEqual(uploads, [self.path])
            self.assertEqual(first["skipped"], [str(other)])
            self.assertNotIn("skipped", second)
        finally:
            ingest.database.close()

    def test_failed_upload_does_not_advance_the_cursor(self):
        self.add(self.message("user", "Read the configuration."))
        self.add(self.message("assistant", "Configuration read.", phase="final_answer"))
        self.add({"type": "event_msg", "payload": {"type": "task_complete"}})
        ingest = LiveIngest(self.home, self.root / "state.sqlite")
        try:
            with self.assertRaisesRegex(OSError, "offline"):
                ingest.sync(lambda *args: (_ for _ in ()).throw(OSError("offline")))
            batches = []
            ingest.sync(lambda session, transcript, messages: batches.append(messages))
            self.assertEqual(len(batches[0]), 2)
        finally:
            ingest.database.close()

    def test_secret_redaction_applies_to_transcript_and_scope_a(self):
        self.add(self.message("user", "API_KEY=sk-" + "aB7cD9eF3gH5jK2mN8pQ4rT6"))
        self.add(self.message("assistant", "Removed the credential.", phase="final_answer"))
        self.add({"type": "event_msg", "payload": {"type": "task_complete"}})
        session = identify("codex", self.path.parent, self.path)
        output = self.root / "prepared"
        with redirect_stdout(io.StringIO()):
            boundary, messages = prepare(session, output, 0)
        self.assertEqual(boundary, 4)
        self.assertIn("[REDACTED]", messages[0]["text"])
        self.assertNotIn("sk-aB7", (output / "transcript.jsonl").read_text())

    def test_claude_reply_waits_for_its_final_leaf_marker(self):
        path = self.home / ROOTS["claude"] / "project" / "claude-session.jsonl"
        path.parent.mkdir(parents=True)
        rows = [
            {"type": "user", "uuid": "user", "message": {"role": "user", "content": "Explain the view."}},
            {"type": "assistant", "uuid": "reply", "message": {"id": "model-reply", "role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": "The view contains summaries."}]}},
        ]
        path.write_text("".join(json.dumps({"timestamp": "2026-10-01T10:00:00Z", **r}) + "\n" for r in rows))
        session = identify("claude", path.parent.parent, path)
        with redirect_stdout(io.StringIO()):
            _, pending = prepare(session, self.root / "pending", 0)
        self.assertEqual(pending, [])
        with path.open("a") as handle:
            handle.write(json.dumps({"type": "last-prompt", "leafUuid": "reply"}) + "\n")
        session = identify("claude", path.parent.parent, path)
        with redirect_stdout(io.StringIO()):
            _, finished = prepare(session, self.root / "finished", 0)
        self.assertEqual([m["kind"] for m in finished], ["user", "talk"])


if __name__ == "__main__":
    unittest.main()
