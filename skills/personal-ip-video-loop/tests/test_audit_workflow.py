import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("audit", ROOT / "scripts/audit_workflow.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.state = json.loads((ROOT / "assets/workflow-state.json").read_text())
        self.state.update(project_id="test", project_root="/test")

    def approve(self, n):
        for i in range(1, n + 1):
            self.state["gates"][f"gate{i}"].update(status="approved", artifact_sha256="current",
                approved_sha256="current", user_message="通过", shown_at="observed", approved_at="observed")

    def job(self, **extra):
        value = dict(id="job1", provider="fal.ai", kind="h3", receipt_path="private.json",
                     request_id="request1", state="succeeded", required_steps=["retrieved", "downloaded", "qc", "imported"])
        value.update(extra)
        self.state["jobs"] = [value]
        return value

    def test_unknown_submission_cannot_resubmit(self):
        self.job(state="submission_started", request_id=None)
        result = AUDIT.resume(self.state)
        self.assertEqual(result["action"], "reconcile_existing_submission")
        self.assertFalse(result["may_submit"])

    def test_completed_job_requires_dependent_work(self):
        self.job(retrieved=True)
        self.assertEqual(AUDIT.resume(self.state)["action"], "complete_downloaded")

    def test_export_download_requires_qc(self):
        self.job(kind="export", retrieved=True, downloaded=True)
        self.assertEqual(AUDIT.resume(self.state)["action"], "complete_qc")

    def test_missing_gate_blocks_generation(self):
        self.state["phase"] = "generate"
        with self.assertRaisesRegex(ValueError, "gate1"):
            AUDIT.resume(self.state)

    def test_checked_retry_resolves_previous_failure(self):
        failed = self.job(state="failed", resolution=dict(kind="retried", successor_id="retry", evidence_path="qc.json"))
        self.state["jobs"].append(dict(failed, id="retry", state="succeeded",
            resolution=None, retrieved=True, downloaded=True, qc=True, imported=True))
        self.assertEqual(AUDIT.resume(self.state)["action"], "continue_phase")

    def test_inflight_retry_is_recovered_instead_of_retrying_old_failure(self):
        failed = self.job(state="failed", retry_successor_id="retry")
        self.state["jobs"].append(dict(failed, id="retry", retry_successor_id=None, state="running"))
        result = AUDIT.resume(self.state)
        self.assertEqual(result["action"], "poll_existing_job")
        self.assertEqual(result["job_id"], "retry")

    def test_natural_approval_and_no_magic_phrase(self):
        self.approve(2)
        self.state["phase"] = "generate"
        self.assertEqual(AUDIT.resume(self.state)["action"], "continue_phase")

    def test_stale_approval_blocks(self):
        self.approve(2)
        self.state["gates"]["gate1"]["artifact_sha256"] = "new"
        with self.assertRaisesRegex(ValueError, "stale"):
            AUDIT.resume(self.state)

    def test_fake_approval_blocks(self):
        self.approve(1)
        self.state["gates"]["gate1"]["user_message"] = ""
        with self.assertRaisesRegex(ValueError, "evidence"):
            AUDIT.resume(self.state)

    def test_all_media_categories_share_budget(self):
        self.state["budget"].update(cap=10, authorization_id="budget1", user_message="通过")
        self.state["spend"] = [
            dict(id=str(i), category=c, amount=3, currency="USD", state="committed", authorization_id="budget1")
            for i, c in enumerate(["h3", "storyboard", "music", "cover"])
        ]
        with self.assertRaisesRegex(ValueError, "exceeded"):
            AUDIT.resume(self.state)

    def subscription_cover(self):
        # Synthetic receipt: observed call count is not cash or a model verification.
        self.state["quota_usage"] = [dict(
            id="cover-draft", category="cover", runtime="codex_builtin_image_gen",
            billing_mode="codex_subscription", model_requested="Image 2.5",
            model_reported=None, generation_count=4, request_or_receipt="fixture.json",
            output_paths=["draft-3x4.png", "draft-4x3.png"], state="completed",
            limit_status="unknown")]

    def test_subscription_cover_does_not_require_cash_cap(self):
        self.approve(3)
        self.state["phase"] = "cover"
        self.subscription_cover()
        self.assertIsNone(self.state["budget"]["cap"])
        self.assertEqual(AUDIT.resume(self.state)["action"], "continue_phase")
        self.assertEqual(self.state["spend"], [])
        self.assertIsNone(self.state["quota_usage"][0]["model_reported"])

    def test_paid_cover_still_requires_cash_cap(self):
        self.approve(3)
        self.state["phase"] = "cover"
        self.subscription_cover()
        self.state["spend"] = [dict(id="api-cover", category="cover", amount=1,
            currency="USD", state="committed", authorization_id="unapproved-api")]
        with self.assertRaisesRegex(ValueError, "budget cap missing"):
            AUDIT.resume(self.state)

    def test_subscription_cover_does_not_consume_h3_cash_budget(self):
        self.approve(3)
        self.state["phase"] = "cover"
        self.subscription_cover()
        self.state["budget"].update(cap=0.6, authorization_id="h3-budget", user_message="通过")
        self.state["spend"] = [dict(id="h3", category="h3", amount=0.6,
            currency="USD", state="settled", authorization_id="h3-budget")]
        self.assertEqual(AUDIT.resume(self.state)["action"], "continue_phase")
        self.assertEqual(sum(e["amount"] for e in self.state["spend"]), 0.6)

    def test_currency_mismatch_not_summed(self):
        self.state["spend"] = [dict(id="a", category="h3", amount=1, currency="CNY", state="committed")]
        with self.assertRaisesRegex(ValueError, "currency"):
            AUDIT.resume(self.state)

    def test_complete_requires_deliverables(self):
        self.approve(4)
        self.state["phase"] = "complete"
        with self.assertRaisesRegex(ValueError, "unverified delivery"):
            AUDIT.resume(self.state)

    def test_only_shown_gate_pauses(self):
        self.state["gates"]["gate1"]["status"] = "shown"
        self.assertEqual(AUDIT.resume(self.state)["action"], "await_user_review")

    def archive_fixture(self):
        self.approve(4)
        self.state["phase"] = "archive"
        self.state["delivery"] = [dict(role=role, verified=True, path_or_id="fixture",
            evidence_path="fixture-proof.json") for role in
            ("video", "srt", "cover_3x4", "cover_4x3", "editable_project")]
        self.state["archive"] = dict(requested=True, project_id="test", user_message="归档这条",
            requested_at="observed", destination="/nas/test", mode="archive_and_cleanup",
            status="pending")
        return self.state["archive"]

    def checked_archive_fixture(self):
        archive = self.archive_fixture()
        archive.update(status="checksum-verified", proof_path="proof.json", restore_verified=True,
            restore_evidence_path="restore.json", cleanup_manifest_path="cleanup.json")
        return archive

    def test_cover_approval_alone_does_not_authorize_archive(self):
        self.archive_fixture()
        self.state.pop("archive")
        self.state["phase"] = "complete"
        self.assertEqual(AUDIT.resume(self.state)["action"], "delivery_complete")

    def test_archive_request_continues_from_approved_cover_phase(self):
        self.archive_fixture()
        self.state["phase"] = "cover"
        self.assertEqual(AUDIT.resume(self.state)["action"], "archive_and_verify")

    def test_archive_request_cannot_target_another_project(self):
        self.archive_fixture()["project_id"] = "other"
        with self.assertRaisesRegex(ValueError, "project mismatch"):
            AUDIT.resume(self.state)

    def test_nas_copy_alone_does_not_allow_cleanup(self):
        archive = self.archive_fixture()
        archive.update(status="checksum-verified", proof_path="proof.json")
        self.assertEqual(AUDIT.resume(self.state)["action"], "verify_archive_restore")
        self.state["phase"] = "complete"
        with self.assertRaisesRegex(ValueError, "still pending"):
            AUDIT.resume(self.state)

    def test_browser_blocker_does_not_skip_independent_local_cleanup(self):
        archive = self.checked_archive_fixture()
        archive["cleanup"] = dict(browser=dict(status="blocked", reason="unmapped media"))
        result = AUDIT.resume(self.state)
        self.assertEqual(result["scope"], "local")
        archive["cleanup"]["local"] = dict(status="complete", evidence_path="local.json")
        self.assertEqual(AUDIT.resume(self.state)["action"], "resolve_cleanup_blocker")
        self.state["phase"] = "complete"
        with self.assertRaisesRegex(ValueError, "still pending"):
            AUDIT.resume(self.state)

    def test_archive_cleanup_finishes_only_with_both_scope_receipts(self):
        archive = self.checked_archive_fixture()
        archive["cleanup"] = {k: dict(status="complete", evidence_path=k+".json")
                              for k in ("local", "browser")}
        self.assertEqual(AUDIT.resume(self.state)["action"], "finalize_archive_cleanup_receipt")
        archive["status"] = "archived_and_cleaned"
        self.state["phase"] = "complete"
        self.assertEqual(AUDIT.resume(self.state)["action"], "archive_cleanup_complete")
        archive["cleanup"]["browser"].pop("evidence_path")
        with self.assertRaisesRegex(ValueError, "cleanup evidence"):
            AUDIT.resume(self.state)

    def test_backup_only_does_not_request_local_deletion(self):
        archive = self.archive_fixture()
        archive.update(mode="backup_only", status="checksum-verified", proof_path="proof.json")
        self.state["phase"] = "complete"
        self.assertEqual(AUDIT.resume(self.state)["action"], "archive_backup_complete")

    def test_archive_cannot_skip_unapproved_cover(self):
        self.archive_fixture()
        self.state["phase"] = "cover"
        self.state["gates"]["gate4"]["status"] = "pending"
        with self.assertRaisesRegex(ValueError, "gate4"):
            AUDIT.resume(self.state)

    def test_union_coverage_excludes_decorations(self):
        plan = dict(duration_frames=5840, fps=10, timeline_id="live", timeline_revision="v1",
            segments=[
                dict(mode="broll", start=0, end=2000),
                dict(mode="mixed", start=1500, end=2920, explanation_dominant=True),
                dict(mode="mixed", start=2920, end=5840, explanation_dominant=False),
                dict(mode="keyword", start=0, end=5840),
            ])
        result = AUDIT.coverage(plan)
        self.assertEqual(result["effective_percent"], 50)
        self.assertEqual(result["seconds"]["effective"], 292)

    def test_out_of_range_coverage_rejected(self):
        plan = dict(duration_frames=100, fps=25, timeline_id="x", timeline_revision="v",
                    segments=[dict(mode="broll", start=0, end=101)])
        with self.assertRaises(ValueError):
            AUDIT.coverage(plan)


if __name__ == "__main__":
    unittest.main()
