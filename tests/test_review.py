import json
import unittest

from node.review import prepare


class ToolReviewTests(unittest.TestCase):
    def test_preserves_the_proposed_edit_for_review(self):
        proposal = {"tool": "edit", "cwd": "/work/repo", "input": {"path": "README.md", "oldText": "Pending", "newText": "Complete"}}
        review = json.loads(prepare(proposal))
        self.assertEqual(review["input"]["oldText"], "Pending")
        self.assertEqual(review["input"]["newText"], "Complete")

    def test_redacts_credentials_before_upload(self):
        secret = "sk-proj-" + "exampleCredentialValue" * 3
        review = prepare({"tool": "bash", "input": {"command": f"export OPENAI_API_KEY={secret}"}})
        self.assertNotIn(secret, review)
        self.assertIn("[REDACTED]", review)
        self.assertIn("Credential values were redacted", review)

    def test_large_proposals_need_smaller_tool_calls(self):
        with self.assertRaisesRegex(ValueError, "split the change"):
            prepare({"tool": "write", "input": {"path": "large.txt", "content": "Reviewed text.\n" * 12_000}})
