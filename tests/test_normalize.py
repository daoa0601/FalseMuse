"""Observable import behavior, exercised with the real local scanner."""

import base64
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from optchat_memory.normalize import export, finish_export
from optchat_memory.sources import ROOTS, records


class NormalizationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "home"
        self.output = Path(self.temporary.name) / "export"

    def session(self, source, identifier, events, *, start="2026-01-01T00:00:00Z", subagent=False):
        root = self.home / ROOTS[source]
        if source == "claude":
            path = root / "project" / ("subagents" if subagent else "main") / f"{identifier}.jsonl"
            header = []
        elif source.startswith("codex"):
            path = root / f"{identifier}.jsonl"
            header = [{"type": "session_meta", "timestamp": start, "payload": {"id": identifier, "timestamp": start, "source": {"subagent": {}} if subagent else "cli"}}]
        else:
            path = root / f"{identifier}.jsonl"
            header = [{"type": "session", "id": identifier, "timestamp": start, "rlmDepth": int(subagent)}]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps({"timestamp": start, **event}) + "\n" for event in header + events))
        return path

    def run_export(self, *sources):
        with redirect_stdout(io.StringIO()):
            summary = export(self.home, self.output, list(sources))
        return summary, [row for _, row in records(self.output / "import.jsonl")]

    def codex_message(self, role, text, **extra):
        return {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}], **extra}}

    def test_sessions_are_contiguous_and_ordered_by_start(self):
        self.session("codex", "late", [self.codex_message("user", "Fix the parser."), self.codex_message("assistant", "Parser fixed.", channel="final")], start="2026-02-01T00:00:00Z")
        self.session("codex", "early", [self.codex_message("user", "Explain the tree."), self.codex_message("assistant", "It has two children.", channel="final")])
        _, rows = self.run_export("codex")
        self.assertEqual([row["session"] for row in rows], ["codex/early", "codex/early", "codex/late", "codex/late"])
        self.assertEqual(rows[2]["text"], "Fix the parser.")

    def test_codex_keeps_final_replies_and_reports_without_harness_or_tools(self):
        events = [self.codex_message("user", "# AGENTS.md instructions for a repo"), self.codex_message("user", "Find the failing test."), self.codex_message("assistant", "I will inspect it.", channel="commentary"), self.codex_message("assistant", "Private deliberation.", channel="analysis"), {"type": "response_item", "payload": {"type": "function_call_output", "output": "tool output"}}, self.codex_message("user", "<subagent_notification>Worker found an off-by-one.</subagent_notification>"), self.codex_message("assistant", "Fixed the off-by-one.", channel="final")]
        self.session("codex", "main", events)
        _, rows = self.run_export("codex")
        self.assertEqual([row["kind"] for row in rows], ["user", "work", "talk"])
        transcript = (self.output / "transcripts/codex/main.jsonl").read_text()
        self.assertIn("tool output", transcript)
        self.assertNotIn("Private deliberation", transcript)

    def test_human_requests_attached_to_editor_context_are_preserved(self):
        self.session("codex", "main", [self.codex_message("user", "# Files mentioned by the user\nparser.py\n\n## My request for Codex:\nFix the parser."), self.codex_message("user", "<system-reminder>Current file: parser.py</system-reminder>\nKeep the public API."), self.codex_message("user", "Caveat: preserve the stored history.")])
        _, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Fix the parser.", "Keep the public API.", "Caveat: preserve the stored history."])

    def test_browser_context_and_user_shell_output_keep_only_the_request(self):
        self.session("codex", "main", [self.codex_message("user", "# In app browser:\nCurrent URL: https://example.test\n## My request for Codex:\nExplain this page."), self.codex_message("user", "# Applications mentioned by the user:\nA screenshot without typed text."), self.codex_message("user", "<user_shell_command><command>ls</command><result>file listing</result></user_shell_command>")])
        _, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Explain this page.", "ls"])

    def test_codex_phases_and_completion_emit_one_final_reply(self):
        self.session("codex", "main", [self.codex_message("user", "Fix it."), self.codex_message("assistant", "I am inspecting it.", phase="commentary"), self.codex_message("assistant", "Fixed it.", phase="final_answer"), {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Fixed it."}}])
        _, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Fix it.", "Fixed it."])

    def test_old_codex_completion_marks_the_final_reply(self):
        self.session("codex", "main", [self.codex_message("user", "Fix it."), self.codex_message("assistant", "I will inspect it."), self.codex_message("assistant", "Fixed it."), {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Fixed it."}}])
        _, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Fix it.", "Fixed it."])

    def test_report_after_final_reply_preserves_message_order(self):
        self.session("codex", "main", [self.codex_message("user", "Fix it."), self.codex_message("assistant", "Fixed it.", phase="final_answer"), self.codex_message("user", "<subagent_notification>Worker finished.</subagent_notification>"), {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "Fixed it."}}])
        _, rows = self.run_export("codex")
        self.assertEqual([row["kind"] for row in rows], ["user", "talk", "work"])

    def test_claude_continuation_checks_stay_out_of_memory(self):
        self.session("claude", "check", [{"type": "progress"}, {"type": "user", "sessionId": "check", "message": {"role": "user", "content": "Analyze this conversation and determine: Does the assistant have more autonomous work to do RIGHT NOW?\nConversation: []"}}, {"type": "assistant", "message": {"id": "decision", "role": "assistant", "content": [{"type": "text", "text": '{"should_continue": false}'}]}}])
        summary, rows = self.run_export("claude")
        self.assertEqual(rows, [])
        self.assertEqual(summary["sources"]["claude"]["harness_sessions"], 1)

    def test_swe_bench_selector_is_a_harness_session(self):
        self.session("claude", "selector", [{"type": "user", "message": {"role": "user", "content": "You are evaluating 3 candidate patches for SWE-bench instance `example`."}}])
        summary, rows = self.run_export("claude")
        self.assertEqual(rows, [])
        self.assertEqual(summary["sources"]["claude"]["harness_sessions"], 1)

    def test_scheduled_prompts_and_quiet_heartbeats_do_not_enter_memory(self):
        self.session("claude", "scheduled", [{"type": "user", "message": {"role": "user", "content": '<scheduled-task name="monitor">Run the monitor.</scheduled-task>'}}])
        self.session("codex", "main", [self.codex_message("user", "Check the run."), self.codex_message("assistant", "<heartbeat><decision>DONT_NOTIFY</decision><message>Healthy.</message></heartbeat>", phase="final_answer")])
        summary, rows = self.run_export("claude", "codex")
        self.assertEqual([row["text"] for row in rows], ["Check the run."])
        self.assertEqual(summary["sources"]["claude"]["harness_sessions"], 1)

    def test_camel_case_credentials_and_arrow_output_are_redacted(self):
        value = "opaque-credential-value-123"
        self.session("codex", "main", [self.codex_message("user", "cursorAuth/openAIKey → " + value), {"type": "response_item", "payload": {"type": "function_call_output", "output": {"accessToken": value, "apiKey": value}}}])
        _, rows = self.run_export("codex")
        self.assertNotIn(value, rows[0]["text"])
        self.assertNotIn(value, (self.output / "transcripts/codex/main.jsonl").read_text())

    def test_cli_worker_prompts_are_separate_from_human_sessions(self):
        self.session("codex", "worker", [self.codex_message("user", "# AGENTS.md instructions for a repo"), self.codex_message("user", "You are logical subagent candidate_a, turn 1/1.\nOverall objective: inspect the incident.")])
        self.session("codex", "supervisor", [self.codex_message("user", "You are the supervisor inside a deterministic agent harness.\nObjective: inspect the incident.")])
        summary, rows = self.run_export("codex")
        self.assertEqual(rows, [])
        self.assertEqual(summary["sources"]["codex"]["subagent_sessions"], 1)
        self.assertEqual(summary["sources"]["codex"]["harness_sessions"], 1)

    def test_issue_runner_sessions_stay_out_of_the_human_log(self):
        self.session("claude", "issue", [{"type": "user", "message": {"role": "user", "content": "You are a coding agent working on issue **DAO-15: Fix the parser**."}}])
        self.session("claude", "continuation", [{"type": "user", "message": {"role": "user", "content": "Continue working on DAO-15: Fix the parser.\nThis is turn 3. Check the workspace state and continue from where the previous turn left off."}}])
        summary, rows = self.run_export("claude")
        self.assertEqual(rows, [])
        self.assertEqual(summary["sources"]["claude"]["subagent_sessions"], 2)

    def test_subagents_have_transcripts_but_no_memory_leaves(self):
        self.session("codex", "main", [self.codex_message("user", "Review the code.")])
        self.session("codex", "worker", [self.codex_message("user", "Inspect implementation details.")], subagent=True)
        summary, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Review the code."])
        self.assertEqual(summary["sources"]["codex"]["subagent_sessions"], 1)
        self.assertTrue((self.output / "transcripts/codex/worker.jsonl").exists())

    def test_active_and_archived_copies_import_once(self):
        self.session("codex", "main", [self.codex_message("user", "Fix the parser.")])
        self.session("codex-archived", "main", [self.codex_message("user", "Fix the parser."), self.codex_message("assistant", "Parser fixed.", channel="final")])
        summary, rows = self.run_export("codex", "codex-archived")
        self.assertEqual([row["kind"] for row in rows], ["user", "talk"])
        self.assertEqual(summary["duplicate_sessions_skipped"], 1)

    def test_claude_joins_text_blocks_and_deduplicates_record_ids(self):
        def reply(uuid, text, identifier="answer", tools=False):
            content = [{"type": "text", "text": text}]
            if tools:
                content.append({"type": "tool_use", "name": "read", "input": {"file": "README.md"}})
            return {"type": "assistant", "uuid": uuid, "sessionId": "main", "message": {"role": "assistant", "id": identifier, "content": content}}
        events = [{"type": "user", "uuid": "question", "sessionId": "main", "message": {"role": "user", "content": "Fix it."}}, reply("tool-text", "Reading the file.", "tool-turn", True), reply("first", "Fixed the parser."), reply("first", "Fixed the parser."), reply("second", "The public API test passes.")]
        self.session("claude", "main", events)
        _, rows = self.run_export("claude")
        self.assertEqual([row["kind"] for row in rows], ["user", "talk"])
        self.assertEqual(rows[1]["text"], "Fixed the parser.\nThe public API test passes.")

    def test_claude_resume_record_does_not_merge_distinct_sessions(self):
        self.session("claude", "parent", [{"type": "user", "sessionId": "parent", "message": {"role": "user", "content": "Read the parser."}}])
        self.session("claude", "child", [{"type": "progress", "sessionId": "parent"}, {"type": "user", "sessionId": "child", "message": {"role": "user", "content": "Now fix the parser."}}], start="2026-02-01T00:00:00Z")
        summary, rows = self.run_export("claude")
        self.assertEqual(summary["sources"]["claude"]["main_sessions"], 2)
        self.assertEqual([row["text"] for row in rows], ["Read the parser.", "Now fix the parser."])

    def test_prime_child_reports_and_pi_custom_reports_enter_memory(self):
        self.session("prime", "main", [{"type": "custom_message", "customType": "agent_message", "details": {"fromRelationship": "child", "from": {"sessionId": "worker"}, "message": "The test now passes."}}, {"type": "custom_message", "customType": "harness_digest", "content": "Injected harness instructions."}])
        self.session("pi", "main", [{"type": "custom_message", "customType": "subagent-notify", "content": "[worker] Found the issue."}])
        _, rows = self.run_export("prime", "pi")
        self.assertEqual([row["kind"] for row in rows], ["work", "work"])
        self.assertEqual({row["text"] for row in rows}, {"[worker] The test now passes.", "[worker] Found the issue."})

    def test_pi_nested_run_is_a_subagent(self):
        path = self.session("pi", "worker", [{"type": "message", "message": {"role": "user", "content": "Read the source."}}])
        nested = path.parent / "parent/worker/run-0/session.jsonl"
        nested.parent.mkdir(parents=True)
        path.rename(nested)
        summary, rows = self.run_export("pi")
        self.assertEqual(rows, [])
        self.assertEqual(summary["sources"]["pi"]["subagent_sessions"], 1)

    def test_redaction_covers_memory_and_full_tool_transcripts(self):
        key = "ghp_" + "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4"
        password = "local" + "-password-123"
        self.session("codex", "main", [self.codex_message("user", "Use this key " + key), {"type": "response_item", "payload": {"type": "function_call_output", "output": "DB_PASSWORD=" + password + "\nhttps://reader:" + password + "@example.test/path"}}, self.codex_message("assistant", "Updated config.", channel="final")])
        summary, rows = self.run_export("codex")
        self.assertIn("[REDACTED]", rows[0]["text"])
        transcript = (self.output / "transcripts/codex/main.jsonl").read_text()
        self.assertNotIn(key, transcript)
        self.assertNotIn(password, transcript)
        self.assertIn("DB_PASSWORD=", transcript)
        self.assertIn("https://reader:[REDACTED]@example.test/path", transcript)
        self.assertEqual(summary["final_scan"]["findings"], 0)

    def test_native_gitleaks_rules_redact_keys_not_covered_by_key_patterns(self):
        key = "glpat-" + "aB3cD4eF5gH6iJ7kL8mN9"
        self.session("codex", "main", [self.codex_message("user", "Use " + key + ". gitleaks:allow")])
        summary, rows = self.run_export("codex")
        self.assertNotIn(key, rows[0]["text"])
        self.assertGreater(summary["transcript_scan"]["redacted_findings"], 0)

    def test_overlapping_secret_rules_preserve_the_surrounding_request(self):
        key = "glpat-" + "aB3cD4eF5gH6iJ7kL8mN9"
        self.session("codex", "main", [self.codex_message("user", 'Configure {"apiKey": "' + key + '"} and run the tests.')])
        summary, rows = self.run_export("codex")
        self.assertEqual(len(rows), 1)
        self.assertIn("and run the tests.", rows[0]["text"])
        self.assertNotIn(key, rows[0]["text"])
        self.assertEqual(summary["transcript_scan"]["withheld_records"], 0)

    def test_a_private_key_cut_off_before_its_end_line_is_redacted_to_the_end(self):
        body = "MIIEowIBAAKCAQEAx2" + "Lm9Qr" * 8
        text = "Saved it:\n-----BEGIN RSA PRIVATE " + "KEY-----\n" + body
        self.session("codex", "main", [self.codex_message("assistant", text, channel="final")])
        _, rows = self.run_export("codex")
        self.assertNotIn(body, rows[0]["text"])
        self.assertTrue(rows[0]["text"].startswith("Saved it:"))

    def test_basic_prose_is_preserved_while_basic_auth_is_redacted(self):
        prose = "Prime and Pi share the same basic token-budget-triggered compaction design."
        credential = base64.b64encode(b"reader:local-password-123").decode()
        self.session("codex", "main", [self.codex_message("user", prose), self.codex_message("assistant", "Header: Basic " + credential, channel="final")])
        _, rows = self.run_export("codex")
        self.assertEqual(rows[0]["text"], prose)
        self.assertNotIn(credential, rows[1]["text"])

    def test_decoded_secret_event_is_withheld_without_exposing_its_value(self):
        key = "ghp_" + "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4"
        encoded = base64.b64encode(key.encode()).decode()
        self.session("codex", "main", [self.codex_message("user", "blob: " + encoded)])
        summary, rows = self.run_export("codex")
        self.assertEqual(rows, [])
        self.assertGreater(summary["transcript_scan"]["withheld_records"], 0)
        self.assertNotIn(encoded, (self.output / "transcripts/codex/main.jsonl").read_text())

    def test_invalid_record_stops_with_source_location(self):
        path = self.session("codex", "main", [])
        with path.open("a") as handle:
            handle.write('{"private_value": invalid}\n')
        with self.assertRaisesRegex(ValueError, "main.jsonl:2: invalid JSON record"), redirect_stdout(io.StringIO()):
            export(self.home, self.output, ["codex"])
        self.assertFalse((self.output / "summary.json").exists())

    def test_unfinished_live_record_is_deferred(self):
        path = self.session("codex", "main", [self.codex_message("user", "Fix the code.")])
        with path.open("a") as handle:
            handle.write('{"type": "response_item"')
        _, rows = self.run_export("codex")
        self.assertEqual([row["text"] for row in rows], ["Fix the code."])

    def test_truncated_recording_stops_with_a_snapshot_error(self):
        path = self.session("codex", "main", [self.codex_message("user", "Fix the code.")])
        boundary = path.stat().st_size
        path.write_text('{"type": "session_meta"}\n')
        with self.assertRaisesRegex(ValueError, "recording ended before its snapshot boundary"):
            list(records(path, boundary))

    def test_existing_output_is_never_overwritten(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, "choose a new output directory"):
            export(self.home, self.output, ["codex"])

    def test_prepared_transcripts_can_resume_without_the_original_logs(self):
        self.session("codex", "main", [self.codex_message("user", "Read the parser.")])
        _, rows = self.run_export("codex")
        (self.output / "summary.json").unlink()
        import shutil
        shutil.rmtree(self.home)
        with redirect_stdout(io.StringIO()):
            summary = finish_export(self.output)
        self.assertEqual(summary["sources"]["codex"]["user"], 1)
        self.assertEqual([row["text"] for _, row in records(self.output / "import.jsonl")], ["Read the parser."])

    def test_native_scanner_covers_a_large_session_set(self):
        key = "glpat-" + "aB3cD4eF5gH6iJ7kL8mN9"
        for index in range(101):
            text = "Read module " + str(index)
            if index == 100:
                text += " using " + key
            self.session("codex", f"session-{index}", [self.codex_message("user", text)])
        summary, rows = self.run_export("codex")
        self.assertEqual(len(rows), 101)
        self.assertGreater(summary["transcript_scan"]["redacted_findings"], 0)
        self.assertNotIn(key, next(row["text"] for row in rows if row["session"] == "codex/session-100"))


if __name__ == "__main__":
    unittest.main()
