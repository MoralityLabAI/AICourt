#!/usr/bin/env python3
"""Count exact o200k tokens in SFT message content, with input/target split."""
import argparse, gzip, json
from pathlib import Path
import tiktoken

parser = argparse.ArgumentParser()
parser.add_argument("paths", nargs="+")
parser.add_argument("--encoding", default="o200k_base")
args = parser.parse_args()
enc = tiktoken.get_encoding(args.encoding)
totals = {"examples": 0, "input_tokens": 0, "assistant_tokens": 0, "total_tokens": 0, "by_cell": {}, "by_env": {}, "by_disposition": {}, "by_model": {}, "by_effort": {}}

def add(bucket, key, count): bucket[key] = bucket.get(key, 0) + count
def files(raw):
    p=Path(raw)
    if p.is_dir(): yield from sorted(x for x in p.rglob("*") if x.name.endswith((".jsonl", ".jsonl.gz")))
    elif p.is_file(): yield p

for raw in args.paths:
    for path in files(raw):
        opener = gzip.open if path.name.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip(): continue
                row=json.loads(line)
                messages=row.get("messages", [])
                input_text="\n".join(str(m.get("content", "")) for m in messages if m.get("role") != "assistant")
                target_text="\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "assistant")
                inp=len(enc.encode(input_text)); out=len(enc.encode(target_text)); total=inp+out
                totals["examples"] += 1; totals["input_tokens"] += inp; totals["assistant_tokens"] += out; totals["total_tokens"] += total
                add(totals["by_cell"], f'{row.get("model")}:{row.get("reasoning_effort")}:{row.get("disposition")}', total)
                add(totals["by_env"], row.get("env", "<missing>"), total)
                add(totals["by_disposition"], row.get("disposition", "<missing>"), total)
                add(totals["by_model"], row.get("model", "<missing>"), total)
                add(totals["by_effort"], row.get("reasoning_effort", "<missing>"), total)
print(json.dumps(totals, sort_keys=True))
