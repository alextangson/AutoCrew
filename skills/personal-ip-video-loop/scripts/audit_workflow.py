#!/usr/bin/env python3
"""Read-only coverage and recovery audit. No provider calls, spending or scheduler."""
import argparse
import json
import math
from pathlib import Path


def require(value, message):
    if not value:
        raise ValueError(message)


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def union_frames(intervals):
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(end, merged[-1][1])
        else:
            merged.append([start, end])
    return sum(end - start for start, end in merged)


def coverage(plan):
    total, fps = plan["duration_frames"], plan["fps"]
    require(type(total) is int and total > 0, "duration_frames must be a positive integer")
    require(number(fps) and fps > 0, "fps must be positive")
    require(plan.get("timeline_id") and plan.get("timeline_revision"), "timeline identity/revision required")
    groups = {"broll": [], "mixed": []}
    for segment in plan["segments"]:
        start, end, mode = segment["start"], segment["end"], segment["mode"]
        require(type(start) is int and type(end) is int and 0 <= start < end <= total, "invalid frame interval")
        require(mode in ("aroll", "broll", "mixed", "keyword"), "unknown coverage mode")
        if mode == "broll" or (mode == "mixed" and segment.get("explanation_dominant") is True):
            groups[mode].append((start, end))
    frames = {key: union_frames(intervals) for key, intervals in groups.items()}
    frames["effective"] = union_frames(groups["broll"] + groups["mixed"])
    percentage = 100 * frames["effective"] / total
    return {
        "timeline_id": plan["timeline_id"], "timeline_revision": plan["timeline_revision"],
        "seconds": {key: round(value / fps, 3) for key, value in frames.items()},
        "effective_percent": round(percentage, 2),
        "note": "Mixed dominance is supplied editorial judgment; this checks interval arithmetic only.",
    }


PHASE_GATE = {"rough_cut": 0, "storyboard": 1, "generate": 2, "finish": 2,
              "export": 3, "cover": 3, "deliver": 4, "archive": 4,
              "cleanup": 4, "complete": 4}
REVIEW_PHASES = {"rough_cut": "gate1", "storyboard": "gate2", "finish": "gate3", "cover": "gate4"}
JOB_STATES = {"submission_started", "queued", "running", "succeeded", "failed"}
STEPS = {"retrieved", "downloaded", "qc", "imported"}


def assembly(record):
    """Check recorded placement and packaging, never infer live editor truth."""
    require(record.get("schema_version") == 1, "unsupported assembly schema")
    root = Path(record["project_root"]).expanduser()
    require(root.is_absolute() and root.is_dir(), "existing absolute project_root required")
    root = root.resolve()
    missing = []

    def evidence(value):
        if not isinstance(value, str) or not value:
            return False
        path = root / value
        return path.resolve().is_relative_to(root) and path.is_file() and path.stat().st_size > 0

    timeline = record.get("timeline", {})
    for key in ("project_id", "timeline_id", "timeline_revision", "srt_sha256"):
        if not timeline.get(key):
            missing.append("timeline." + key)
    total = timeline.get("duration_frames")
    if type(total) is not int or total <= 0:
        missing.append("timeline.duration_frames")
    for key in ("snapshot_path", "srt_path"):
        if not evidence(timeline.get(key)):
            missing.append("timeline." + key)
    if not evidence(record.get("plan_evidence_path")):
        missing.append("plan_evidence_path")
    expected = record.get("approved_shot_ids")
    require(isinstance(expected, list) and all(isinstance(x, str) and x for x in expected),
            "approved_shot_ids must explicitly list the approved package")
    require(len(expected) == len(set(expected)), "duplicate approved shot id")
    shots = record.get("shots", [])
    require(isinstance(shots, list) and all(isinstance(s, dict) and s.get("shot_id") for s in shots),
            "invalid shots")
    ids = [shot["shot_id"] for shot in shots]
    require(len(ids) == len(set(ids)), "duplicate shot record; use multiple placements within a shot")
    require(set(ids) <= set(expected), "unplanned shot; reconcile approved scope")
    by_id = {shot["shot_id"]: shot for shot in shots}
    item_ids = set()
    for shot_id in expected:
        shot = by_id.get(shot_id, {})
        prefix = "shot." + shot_id
        if shot.get("media_kind") not in ("provider_video", "deterministic_video", "editorial_still"):
            missing.append(prefix + ".media_kind")
        if not evidence(shot.get("source_path")) or not shot.get("source_sha256"):
            missing.append(prefix + ".source")
        placements = shot.get("placements", [])
        if not placements:
            missing.append(prefix + ".placements")
        for index, placed in enumerate(placements):
            label = f"{prefix}.placements[{index}]"
            start, end = placed.get("start_frame"), placed.get("end_frame")
            if not (type(start) is int and type(end) is int and type(total) is int and 0 <= start < end <= total):
                missing.append(label + ".range")
            if not placed.get("asset_id") or not placed.get("item_id"):
                missing.append(label + ".editor_ids")
            elif placed["item_id"] in item_ids:
                missing.append(label + ".duplicate_item_id")
            else:
                item_ids.add(placed["item_id"])
            if placed.get("verified") is not True or not evidence(placed.get("evidence_path")):
                missing.append(label + ".verification")

    checks = record.get("checks", {})
    for name in ("coverage", "transitions", "text", "grade", "bgm", "sfx", "mix", "continuous_playback", "review_surface"):
        item = checks.get(name, {})
        valid = item.get("status") == "verified" and evidence(item.get("evidence_path"))
        # Editorial omissions are intentional choices, never substitutes for failed QA.
        if name in ("transitions", "text", "grade", "bgm", "sfx") and item.get("status") == "not_applicable":
            valid = bool(item.get("reason")) and evidence(item.get("evidence_path"))
            if name == "bgm":
                valid = valid and evidence(item.get("user_scope_evidence_path"))
        if not valid:
            missing.append("checks." + name)
    return {"action": "ready_for_gate3" if not missing else "complete_assembly",
            "ready_for_gate3": not missing, "missing": missing,
            "note": "Evidence ledger only. Re-read the live timeline/revision and inspect/listen to the cited media; this audit does not approve it."}


def archive_next(state):
    """Ledger-only guidance; never authorizes or performs a copy/deletion."""
    archive = state.get("archive", {})
    require(archive.get("requested") is True, "archive request required")
    require(archive.get("project_id") == state["project_id"], "archive project mismatch")
    require(archive.get("user_message") and archive.get("requested_at") and archive.get("destination"),
            "archive request evidence and destination required")
    mode = archive.get("mode")
    require(mode in ("archive_and_cleanup", "backup_only"), "invalid archive mode")
    for gate in ("gate3", "gate4"):
        require(state["gates"][gate].get("status") == "approved",
                f"{gate}: approval required before archive")
    status = archive.get("status", "pending")
    require(status in ("pending", "copying", "blocked", "checksum-verified",
                       "archived_cleanup_partial", "archived_and_cleaned"), "invalid archive status")
    if status == "blocked":
        require(archive.get("reason"), "blocked archive needs reason")
        return {"action": "resolve_archive_blocker", "reason": archive["reason"]}
    if status in ("pending", "copying"):
        return {"action": "archive_and_verify", "destination": archive["destination"]}
    require(archive.get("proof_path"), "archive checksum evidence required")
    if mode == "backup_only":
        return {"action": "archive_backup_complete", "local_cleanup": False}
    if not archive.get("restore_verified") or not archive.get("restore_evidence_path"):
        return {"action": "verify_archive_restore", "local_cleanup": False}
    if not archive.get("cleanup_manifest_path"):
        return {"action": "inventory_project_cleanup", "local_cleanup": False}
    pending, blocked = [], []
    for kind in ("local", "browser"):
        item = archive.get("cleanup", {}).get(kind, {})
        value = item.get("status", "pending")
        require(value in ("pending", "complete", "not_applicable", "blocked"),
                "invalid cleanup status")
        if value == "blocked":
            require(item.get("reason"), "blocked cleanup needs reason")
            blocked.append({"scope": kind, "reason": item["reason"]})
        elif value == "pending":
            pending.append(kind)
        else:
            require(item.get("evidence_path"), "cleanup evidence required")
            if value == "not_applicable":
                require(item.get("reason"), "not_applicable cleanup needs inventory reason")
    # Complete independent work even when the other cleanup scope is blocked.
    if pending:
        return {"action": "execute_verified_project_cleanup", "scope": pending[0],
                "blocked": blocked, "note": "Recheck referenced evidence and live state before deletion."}
    if blocked:
        return {"action": "resolve_cleanup_blocker", "blocked": blocked}
    if status != "archived_and_cleaned":
        return {"action": "finalize_archive_cleanup_receipt"}
    return {"action": "archive_cleanup_complete"}


def resume(state):
    require(state.get("schema_version") == 1, "unsupported workflow schema")
    require(state.get("project_id") and state.get("project_root"), "project identity required")
    phase = state["phase"]
    require(phase in PHASE_GATE, "unknown phase")
    gates = state["gates"]
    # An approval is valid only against the artifact version actually shown.
    for index in range(1, 5):
        key = f"gate{index}"
        gate = gates[key]
        if gate.get("status") == "approved":
            require(gate.get("user_message") and gate.get("shown_at") and gate.get("approved_at"),
                    f"{key}: missing actual review evidence")
            require(gate.get("artifact_sha256") and gate.get("approved_sha256") == gate["artifact_sha256"],
                    f"{key}: stale artifact approval")
        if index <= PHASE_GATE[phase]:
            require(gate.get("status") == "approved", f"{key}: approval required before {phase}")
    budget = state["budget"]
    entries = state.get("spend", [])
    ids = [entry["id"] for entry in entries]
    require(len(ids) == len(set(ids)), "duplicate spend operation")
    committed = 0
    for entry in entries:
        require(entry["state"] in ("reserved", "committed", "settled", "void"), "invalid spend state")
        require(number(entry["amount"]) and entry["amount"] >= 0, "invalid spend amount")
        require(entry["currency"] == budget["currency"], "currency mismatch; use evidenced conversion first")
        require(entry["category"] in ("storyboard", "h3", "music", "sfx", "cover", "other"), "invalid spend category")
        if entry["state"] != "void":
            require(entry.get("authorization_id"), "spend is missing authorization scope")
            committed += entry["amount"]
    if entries:
        require(number(budget.get("cap")) and budget["cap"] >= committed, "budget cap missing or exceeded")
        require(budget.get("user_message") and budget.get("authorization_id"), "missing actual budget approval")
        require(all(e.get("authorization_id") == budget["authorization_id"] for e in entries if e["state"] != "void"),
                "budget authorization mismatch; reconcile amendments without resetting ledger")
    jobs = state.get("jobs", [])
    require(len({job["id"] for job in jobs}) == len(jobs), "duplicate local job id")
    actions = []
    for job in jobs:
        status = job["state"]
        require(status in JOB_STATES, "unknown job state")
        require(job.get("provider") and job.get("kind") and job.get("receipt_path"), "job provenance missing")
        if status == "submission_started" or not job.get("request_id"):
            actions.append((0, {"action": "reconcile_existing_submission", "job_id": job["id"], "may_submit": False}))
            continue
        if status in ("queued", "running"):
            actions.append((3, {"action": "poll_existing_job", "job_id": job["id"],
                                "next_poll_at": job.get("next_poll_at"), "may_submit": False}))
        elif status == "succeeded":
            required = job.get("required_steps")
            require(isinstance(required, list) and required and all(step in STEPS for step in required),
                    "completed job must declare required downstream checks")
            for step in required:
                if job.get(step) is not True:
                    actions.append((1, {"action": f"complete_{step}", "job_id": job["id"], "may_submit": False}))
                    break
        elif status == "failed":
            if job.get("retry_successor_id"):
                successors = [item for item in jobs if item["id"] == job["retry_successor_id"]]
                require(len(successors) == 1 and jobs.index(successors[0]) > jobs.index(job),
                        "retry successor must be a later recorded job")
                # The successor itself is audited below; the original failure remains.
                continue
            resolution = job.get("resolution", {})
            if resolution:
                require(resolution.get("evidence_path"), "resolved failure needs evidence")
                require(resolution.get("kind") in ("retried", "fallback"), "invalid failure resolution")
                if resolution["kind"] == "retried":
                    successors = [item for item in jobs if item["id"] == resolution.get("successor_id")]
                    require(len(successors) == 1 and successors[0] is not job, "missing retry successor")
                    require(successors[0]["state"] == "succeeded" and successors[0].get("qc") is True,
                            "retry successor is not checked; recover it before resolving failure")
                else:
                    require(resolution.get("authorization_id"), "fallback needs approved scope")
                continue
            actions.append((2, {"action": "review_failure_evidence_and_retry_scope", "job_id": job["id"], "may_submit": False}))
    if actions:
        return sorted(actions, key=lambda item: item[0])[0][1]
    if phase == "finish":
        if not state.get("assembly"):
            return {"action": "reconcile_assembly", "note": "Media-bin import is not timeline placement."}
        require(Path(state["assembly"]["project_root"]).resolve() == Path(state["project_root"]).resolve(),
                "assembly project mismatch")
        result = assembly(state["assembly"])
        if not result["ready_for_gate3"]:
            return result
    review = REVIEW_PHASES.get(phase)
    if review and gates[review]["status"] == "shown":
        return {"action": "await_user_review", "gate": review}
    archive_requested = state.get("archive", {}).get("requested") is True
    require(phase not in ("archive", "cleanup") or archive_requested, "archive request required")
    if phase in ("deliver", "archive", "cleanup", "complete") or archive_requested:
        required = {"video", "srt", "cover_3x4", "cover_4x3", "editable_project"}
        verified = {item["role"] for item in state.get("delivery", []) if item.get("verified") is True and item.get("path_or_id") and item.get("evidence_path")}
        missing = sorted(required - verified)
        if missing:
            require(phase != "complete", "cannot mark complete: unverified delivery " + ", ".join(missing))
            return {"action": "verify_delivery", "missing": missing}
        if archive_requested:
            result = archive_next(state)
            require(phase != "complete" or result["action"] in
                    ("archive_backup_complete", "archive_cleanup_complete"),
                    "cannot mark complete: archive or cleanup still pending")
            return result
        return {"action": "delivery_complete"}
    # This helper does not grant authority to execute the returned phase action.
    return {"action": "continue_phase", "phase": phase, "recorded_next_action": state.get("next_action")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("coverage", "resume", "assembly"))
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        result = {"coverage": coverage, "resume": resume, "assembly": assembly}[args.command](json.loads(args.file.read_text()))
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 2 if args.command == "assembly" and not result["ready_for_gate3"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
