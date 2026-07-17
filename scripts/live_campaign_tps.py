#!/usr/bin/env python3
"""Report exact live response and promoted-corpus throughput for a campaign."""
import argparse
import gzip
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import tiktoken


def timestamp(value):
    if not value:
        return None
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)


def environment(episode_id):
    value = str(episode_id or "")
    if value.startswith("rv2-"):
        return "centauri"
    if value.startswith("mixed-they-sing-"):
        return "they_sing"
    if value.startswith("court-"):
        return "court"
    return "unknown"


def empty_row():
    return {
        "attempts": 0,
        "valid_attempts": 0,
        "failed_attempts": 0,
        "api_output_tokens": 0,
        "reasoning_output_tokens": 0,
        "response_content_tokens": 0,
        "first_started_at": None,
        "last_completed_at": None,
    }


def add_time(row, started, completed):
    if started and (row["first_started_at"] is None or started < row["first_started_at"]):
        row["first_started_at"] = started
    if completed and (row["last_completed_at"] is None or completed > row["last_completed_at"]):
        row["last_completed_at"] = completed


def finalize(row):
    start, end = row["first_started_at"], row["last_completed_at"]
    seconds = max(0.001, (end - start).total_seconds()) if start and end else 0
    row["observed_seconds"] = round(seconds, 3)
    row["api_output_tps"] = round(row["api_output_tokens"] / seconds, 3) if seconds else 0
    row["response_content_tps"] = round(row["response_content_tokens"] / seconds, 3) if seconds else 0
    row["first_started_at"] = start.isoformat().replace("+00:00", "Z") if start else None
    row["last_completed_at"] = end.isoformat().replace("+00:00", "Z") if end else None
    return row


def count_training_files(paths, encoding):
    totals = {"examples": 0, "input_tokens": 0, "assistant_tokens": 0, "total_tokens": 0}
    for path in paths:
        opener = gzip.open if path.name.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                row = json.loads(line)
                messages = row.get("messages", [])
                input_text = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") != "assistant")
                output_text = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") == "assistant")
                input_tokens = len(encoding.encode(input_text))
                assistant_tokens = len(encoding.encode(output_text))
                totals["examples"] += 1
                totals["input_tokens"] += input_tokens
                totals["assistant_tokens"] += assistant_tokens
                totals["total_tokens"] += input_tokens + assistant_tokens
    return totals


parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--since", required=True, help="ISO timestamp for the active run")
args = parser.parse_args()

root = Path(args.root)
since = timestamp(args.since)
encoding = tiktoken.get_encoding("o200k_base")
by_env = defaultdict(empty_row)
overall = empty_row()

for receipt_path in (root / "model_calls").rglob("call-*.receipt.json"):
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        continue
    started = timestamp(receipt.get("started_at"))
    if not started or started < since:
        continue
    completed = timestamp(receipt.get("completed_at"))
    env = environment(receipt.get("episode_id"))
    response_path = receipt_path.with_name(receipt_path.name.replace(".receipt.json", ".response.json"))
    response_tokens = 0
    if response_path.exists() and receipt.get("response_valid_json"):
        response_tokens = len(encoding.encode(response_path.read_text(encoding="utf-8-sig").strip()))
    for row in (by_env[env], overall):
        row["attempts"] += 1
        valid = receipt.get("exit_code") == 0 and bool(receipt.get("response_valid_json")) and not receipt.get("failure")
        row["valid_attempts"] += int(valid)
        row["failed_attempts"] += int(not valid)
        usage = receipt.get("usage") or {}
        row["api_output_tokens"] += int(usage.get("output_tokens") or 0)
        row["reasoning_output_tokens"] += int(usage.get("reasoning_output_tokens") or 0)
        row["response_content_tokens"] += response_tokens
        add_time(row, started, completed)

primary_dir = root / "training" / "primary"
promoted_files = sorted(primary_dir.rglob("*.jsonl.gz")) if primary_dir.exists() else []
promoted = count_training_files(promoted_files, encoding)
elapsed = max(0.001, (datetime.now(timezone.utc) - since).total_seconds())
promoted["campaign_elapsed_seconds"] = round(elapsed, 3)
promoted["effective_usable_tps"] = round(promoted["total_tokens"] / elapsed, 3)

print(json.dumps({
    "schema": "aicourt.live-campaign-tps.v1",
    "since": since.isoformat().replace("+00:00", "Z"),
    "overall": finalize(overall),
    "by_env": {key: finalize(value) for key, value in sorted(by_env.items())},
    "promoted_usable_corpus": promoted,
}, indent=2, sort_keys=True))
