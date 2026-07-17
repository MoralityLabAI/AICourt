#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decisionToTrainingExample } from "../src/campaign/training-view.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => value.startsWith("--") ? [...rows, [value.slice(2), all[index + 1]]] : rows, []));
if (!args.input || !args.output) throw new Error("Usage: node scripts/rebuild_training_view.mjs --input <jsonl.gz> --output <jsonl.gz> [--conditional true]");
const bytes = readFileSync(path.resolve(args.input));
const text = args.input.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
const source = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const rebuilt = source.map((row) => {
  const user = parseHistoricalStableJson(row.messages.find((entry) => entry.role === "user")?.content ?? "{}");
  const assistantText = row.messages.find((entry) => entry.role === "assistant")?.content ?? "";
  let target; try { target = JSON.parse(assistantText); } catch { target = assistantText; }
  return decisionToTrainingExample({
    episode_id: row.episode_id, env: row.env, seat: row.seat, turn: row.turn, phase: row.phase,
    model: row.model, reasoning_effort: row.reasoning_effort, disposition: row.disposition,
    prompt_id: row.disposition_prompt_id, disposition_assignment_source: row.disposition_assignment_source,
    observation: user.observation, legal_actions: user.legal_actions, open_commitments: user.open_commitments,
    target, labels: row.labels
  }, { conditional: String(args.conditional ?? "false").toLowerCase() === "true", split: row.split });
});
const target = path.resolve(args.output);
mkdirSync(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
writeFileSync(temporary, gzipSync(`${rebuilt.map((row) => JSON.stringify(row)).join("\n")}\n`, { level: 9 }));
renameSync(temporary, target);
console.log(JSON.stringify({ input: path.resolve(args.input), output: target, examples: rebuilt.length }));

function parseHistoricalStableJson(value) {
  return JSON.parse(String(value).replace(/:undefined(?=[,}])/g, ":null"));
}
