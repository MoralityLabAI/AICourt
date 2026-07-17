#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COURT_VERSION, createCourtEpisode } from "../src/court/engine.mjs";

const args = parseArgs(process.argv.slice(2));
const count = Number(args.episodes ?? 200);
const episodes = [];
for (let index = 0; index < count; index += 1) {
  episodes.push(createCourtEpisode({ seed: `${args.seed ?? "court-balance-v2"}:${index}`, episodeIndex: index, players: 5 + (index % 3) }));
}
const report = summarize(episodes, exactTokenCounts(episodes));
const out = resolve(args.out ?? "results/court-balance-200.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));

function summarize(episodes, tokenCounts) {
  const byDisposition = {};
  const byRole = {};
  const byArchetype = {};
  const archetypeRoleCoverage = {};
  const dispositionArchetypeCoverage = {};
  const archetypeActionEvents = {};
  const coverage = {};
  let made = 0;
  let broken = 0;
  let turns = 0;
  for (const [index, episode] of episodes.entries()) {
    const winners = new Set(episode.outcome.winner_seats);
    turns += episode.turns.length;
    for (const player of episode.players) {
      const disposition = byDisposition[player.disposition] ??= { appearances: 0, winning_seats: 0, normalized_victory_credit: 0 };
      disposition.appearances += 1;
      if (winners.has(player.seat)) {
        disposition.winning_seats += 1;
        disposition.normalized_victory_credit += 1 / Math.max(1, winners.size);
      }
      const role = byRole[player.seat] ??= { appearances: 0, wins: 0 };
      role.appearances += 1;
      if (winners.has(player.seat)) role.wins += 1;
      const coverageRow = coverage[player.seat] ??= { machiavellian: 0, coalition: 0, neutral: 0 };
      coverageRow[player.disposition] += 1;
      if (player.archetype) {
        const archetype = byArchetype[player.archetype] ??= { appearances: 0, objective_successes: 0, role_wins: 0 };
        archetype.appearances += 1;
        if (episode.outcome.archetype_results?.[player.seat]?.succeeded) archetype.objective_successes += 1;
        if (winners.has(player.seat)) archetype.role_wins += 1;
        const row = archetypeRoleCoverage[player.seat] ??= {};
        row[player.archetype] = (row[player.archetype] ?? 0) + 1;
        const dispositionRow = dispositionArchetypeCoverage[player.archetype] ??= { machiavellian: 0, coalition: 0, neutral: 0 };
        dispositionRow[player.disposition] += 1;
      }
    }
    for (const turn of episode.turns) for (const event of turn.events) {
      if (event.type === "action" && /compact|rumor|veto|guarantee/.test(event.action?.type ?? "")) {
        archetypeActionEvents[event.action.type] = (archetypeActionEvents[event.action.type] ?? 0) + 1;
      }
    }
    for (const row of Object.values(episode.outcome.commitments_summary.per_seat)) {
      made += row.made;
      broken += row.broken;
    }
  }
  const totalCredits = Object.values(byDisposition).reduce((sum, row) => sum + row.normalized_victory_credit, 0);
  for (const row of Object.values(byDisposition)) {
    row.seat_win_rate = round(row.winning_seats / row.appearances);
    row.share_of_victory_credit = round(row.normalized_victory_credit / totalCredits);
    row.normalized_victory_credit = round(row.normalized_victory_credit);
  }
  for (const row of Object.values(byRole)) row.win_rate = round(row.wins / row.appearances);
  for (const row of Object.values(byArchetype)) {
    row.objective_success_rate = round(row.objective_successes / row.appearances);
    row.role_win_rate = round(row.role_wins / row.appearances);
  }
  return {
    schema: "court.balance.v1",
    policy_population: "seeded deterministic heuristic policy",
    evidence_scope: "mechanics balance; not model-agent strategic quality",
    env_version: COURT_VERSION,
    generated_at: new Date().toISOString(),
    seed: args.seed ?? "court-balance-v2",
    episodes: episodes.length,
    disposition_assignment: "cyclic 50/50 by seat; archetypes use a four-episode Latin schedule for exact disposition balance across rotating 5/6/7 seat counts",
    win_rate_by_disposition: byDisposition,
    win_rate_by_role: byRole,
    archetype_results: byArchetype,
    archetype_x_role_coverage: archetypeRoleCoverage,
    disposition_x_archetype_coverage: dispositionArchetypeCoverage,
    archetype_action_events: archetypeActionEvents,
    disposition_x_role_coverage: coverage,
    commitments: {
      made_total: made,
      broken_total: broken,
      made_per_episode: round(made / episodes.length),
      broken_per_episode: round(broken / episodes.length),
      broken_rate: round(broken / Math.max(1, made)),
      target_band: [0.15, 0.40]
    },
    mean_episode_turn_records: round(turns / episodes.length),
    mean_episode_length_tokens: round(tokenCounts.reduce((sum, value) => sum + value, 0) / tokenCounts.length),
    token_counter: "tiktoken cl100k_base over each serialized one-line episode",
    balance_target_passed: Object.values(byDisposition).every((row) => row.share_of_victory_credit <= 0.65) && broken / Math.max(1, made) >= 0.15 && broken / Math.max(1, made) <= 0.40
  };
}

function exactTokenCounts(episodes) {
  const script = "import json,sys,tiktoken; e=tiktoken.get_encoding('cl100k_base'); print(json.dumps([len(e.encode(x)) for x in sys.stdin.read().splitlines() if x]))";
  const result = spawnSync("python", ["-c", script], { input: episodes.map(JSON.stringify).join("\n"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Token count failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function round(value) { return Number(value.toFixed(4)); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}
