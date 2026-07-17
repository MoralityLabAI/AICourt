#!/usr/bin/env python3
"""Validate unified episode JSONL(.gz) shards and report corpus statistics."""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

try:
    import jsonschema
except ImportError:  # pragma: no cover - fallback is intentionally supported
    jsonschema = None

try:
    import tiktoken
except ImportError:  # pragma: no cover
    tiktoken = None


ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = ROOT / "corpus.schema.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", help="JSONL/JSONL.GZ files or directories")
    parser.add_argument("--out", help="Write the JSON report to this path")
    parser.add_argument("--max-episodes-per-shard", type=int, default=500)
    parser.add_argument("--no-token-count", action="store_true")
    return parser.parse_args()


def discover(paths: Iterable[str]) -> list[Path]:
    files: set[Path] = set()
    for raw in paths:
        path = Path(raw).resolve()
        if path.is_dir():
            files.update(item for item in path.rglob("*") if item.is_file() and (item.name.endswith(".jsonl") or item.name.endswith(".jsonl.gz")))
        elif path.is_file():
            files.add(path)
    return sorted(files)


def rows(path: Path) -> Iterable[tuple[int, str]]:
    opener = gzip.open if path.name.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line.strip():
                yield line_number, line.rstrip("\r\n")


def token_counter(disabled: bool):
    if disabled:
        return (lambda _text: 0), "disabled"
    if tiktoken is not None:
        encoding = tiktoken.get_encoding("cl100k_base")
        return (lambda text: len(encoding.encode(text))), "tiktoken:cl100k_base"
    return (lambda text: max(1, len(text) // 4)), "estimated:characters/4"


def semantic_errors(episode: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    seats = [player.get("seat") for player in episode.get("players", [])]
    seat_set = set(seats)
    if len(seats) != len(seat_set):
        errors.append("player seats are not unique")
    previous_turn = 0
    commitments: dict[str, dict[str, Any]] = {}
    resolutions: list[dict[str, Any]] = []
    resolution_counts: Counter[str] = Counter()
    for turn in episode.get("turns", []):
        number = turn.get("turn", 0)
        if number <= previous_turn:
            errors.append("turn numbers are not strictly increasing")
        previous_turn = number
        for event in turn.get("events", []):
            event_type = event.get("type")
            if event_type in {"public_message", "private_message", "commitment"} and event.get("from") not in seat_set:
                errors.append(f"event from unknown seat {event.get('from')}")
            if event_type == "private_message" and event.get("to") not in seat_set:
                errors.append(f"private message to unknown seat {event.get('to')}")
            if event_type == "action" and event.get("actor") not in seat_set:
                errors.append(f"action by unknown seat {event.get('actor')}")
            if event_type == "commitment":
                commitment_id = event.get("id")
                if commitment_id in commitments:
                    errors.append(f"duplicate commitment id {commitment_id}")
                commitments[commitment_id] = event
                if event.get("to") not in seat_set:
                    errors.append(f"commitment to unknown seat {event.get('to')}")
                if event.get("deadline_turn", 0) < number:
                    errors.append(f"commitment {commitment_id} deadline precedes creation")
            elif event_type == "commitment_resolution":
                resolutions.append(event)
                resolution_counts[event.get("commitment_id")] += 1
    for resolution in resolutions:
        if resolution.get("commitment_id") not in commitments:
            errors.append(f"resolution references missing commitment {resolution.get('commitment_id')}")
    for commitment_id, count in resolution_counts.items():
        if count > 1:
            errors.append(f"commitment {commitment_id} resolved {count} times")
    for winner in episode.get("outcome", {}).get("winner_seats", []):
        if winner not in seat_set:
            errors.append(f"winner {winner} is not a player seat")
    expected = Counter({seat: 0 for seat in seat_set})
    actual = episode.get("outcome", {}).get("commitments_summary", {}).get("per_seat", {})
    for commitment in commitments.values():
        expected[commitment.get("from")] += 1
    for seat, count in expected.items():
        if actual.get(seat, {}).get("made") != count:
            errors.append(f"commitment summary for {seat} says made={actual.get(seat, {}).get('made')}, expected {count}")
    return errors


def validate(files: list[Path], max_per_shard: int, no_tokens: bool) -> dict[str, Any]:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()) if jsonschema else None
    count_tokens, token_method = token_counter(no_tokens)
    errors: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_episode_ids: dict[str, str] = {}
    per_env: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "episodes": 0, "tokens": 0, "commitments_made": 0, "commitments_broken": 0,
        "wins_by_disposition": Counter(), "appearances_by_disposition": Counter()
    })
    coverage: dict[str, Counter[str]] = defaultdict(Counter)
    archetype_coverage: dict[str, Counter[str]] = defaultdict(Counter)
    disposition_archetype_coverage: dict[str, Counter[str]] = defaultdict(Counter)
    total_episodes = 0
    total_tokens = 0

    for path in files:
        shard_count = 0
        for line_number, raw in rows(path):
            shard_count += 1
            total_episodes += 1
            location = f"{path}:{line_number}"
            try:
                episode = json.loads(raw)
            except json.JSONDecodeError as exc:
                errors.append({"location": location, "error": f"invalid JSON: {exc}"})
                continue
            if validator:
                for error in sorted(validator.iter_errors(episode), key=lambda item: list(item.path)):
                    dotted = ".".join(map(str, error.path))
                    errors.append({"location": location, "error": f"schema {dotted}: {error.message}"})
            for error in semantic_errors(episode):
                errors.append({"location": location, "error": error})
            episode_id = episode.get("episode_id")
            if episode_id in seen_episode_ids:
                errors.append({"location": location, "error": f"duplicate episode_id; first seen at {seen_episode_ids[episode_id]}"})
            elif episode_id:
                seen_episode_ids[episode_id] = location

            env = episode.get("env", "<missing>")
            stats = per_env[env]
            stats["episodes"] += 1
            tokens = count_tokens(raw)
            stats["tokens"] += tokens
            total_tokens += tokens
            winners = set(episode.get("outcome", {}).get("winner_seats", []))
            for player in episode.get("players", []):
                disposition = player.get("disposition", "<missing>")
                seat = player.get("seat", "<missing>")
                stats["appearances_by_disposition"][disposition] += 1
                coverage[f"{env}:{seat}"][disposition] += 1
                if "archetype" in player:
                    archetype = player.get("archetype") or "none"
                    archetype_coverage[f"{env}:{seat}"][archetype] += 1
                    disposition_archetype_coverage[f"{env}:{archetype}"][disposition] += 1
                if seat in winners:
                    stats["wins_by_disposition"][disposition] += 1
            for turn in episode.get("turns", []):
                for event in turn.get("events", []):
                    if event.get("type") == "commitment":
                        stats["commitments_made"] += 1
                    elif event.get("type") == "commitment_resolution" and event.get("resolution") == "broken":
                        stats["commitments_broken"] += 1
        if shard_count > max_per_shard:
            errors.append({"location": str(path), "error": f"shard has {shard_count} episodes; maximum is {max_per_shard}"})
        if path.name.endswith(".jsonl") and shard_count >= max_per_shard:
            warnings.append(f"{path} is an uncompressed full shard; production shards should be gzip")

    normalized_env = {}
    for env, stats in sorted(per_env.items()):
        appearances = dict(stats.pop("appearances_by_disposition"))
        wins = dict(stats.pop("wins_by_disposition"))
        stats["appearances_by_disposition"] = appearances
        stats["wins_by_disposition"] = wins
        stats["win_rates_by_disposition"] = {
            disposition: round(wins.get(disposition, 0) / count, 4) if count else 0
            for disposition, count in appearances.items()
        }
        stats["broken_commitment_rate"] = round(stats["commitments_broken"] / stats["commitments_made"], 4) if stats["commitments_made"] else 0
        normalized_env[env] = stats

    matrix = {key: dict(sorted(value.items())) for key, value in sorted(coverage.items())}
    archetype_matrix = {key: dict(sorted(value.items())) for key, value in sorted(archetype_coverage.items())}
    disposition_archetype_matrix = {key: dict(sorted(value.items())) for key, value in sorted(disposition_archetype_coverage.items())}
    missing = [{"env_seat": key, "missing_dispositions": [d for d in ("machiavellian", "coalition") if value.get(d, 0) == 0]} for key, value in sorted(coverage.items())]
    missing = [row for row in missing if row["missing_dispositions"]]
    return {
        "ok": not errors,
        "files": len(files),
        "episodes": total_episodes,
        "tokens": total_tokens,
        "token_counter": token_method,
        "errors": errors,
        "warnings": warnings,
        "per_env": normalized_env,
        "disposition_x_seat_coverage": matrix,
        "archetype_x_seat_coverage": archetype_matrix,
        "disposition_x_archetype_coverage": disposition_archetype_matrix,
        "coverage_gaps": missing,
    }


def main() -> int:
    args = parse_args()
    files = discover(args.paths)
    if not files:
        print("No .jsonl or .jsonl.gz files found.", file=sys.stderr)
        return 2
    report = validate(files, args.max_episodes_per_shard, args.no_token_count)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if args.out:
        output = Path(args.out).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
