#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COURT_VERSION, createCourtEpisode } from "../src/court/engine.mjs";

const args = parseArgs(process.argv.slice(2));
const cohortCount = Number(args.cohorts ?? 10);
const episodesPerCohort = Number(args.episodes ?? 200);
const seedPrefix = String(args.seed ?? "court-balance-v2");
if (!Number.isInteger(cohortCount) || cohortCount < 2) throw new Error("--cohorts must be an integer of at least 2");
if (!Number.isInteger(episodesPerCohort) || episodesPerCohort < 1) throw new Error("--episodes must be a positive integer");

const aggregate = newCounters();
const cohorts = [];
for (let cohortIndex = 0; cohortIndex < cohortCount; cohortIndex += 1) {
  const seed = `${seedPrefix}:cohort-${cohortIndex}`;
  const episodes = [];
  for (let episodeIndex = 0; episodeIndex < episodesPerCohort; episodeIndex += 1) {
    episodes.push(createCourtEpisode({
      seed: `${seed}:${episodeIndex}`,
      episodeIndex,
      players: 5 + (episodeIndex % 3)
    }));
  }
  const tokenCounts = exactTokenCounts(episodes);
  const counters = summarizeInto(episodes, tokenCounts, aggregate);
  cohorts.push(finalizeCounters(counters, { cohort_index: cohortIndex, seed }));
}

const aggregateReport = finalizeCounters(aggregate, { seed: seedPrefix });
const breakRates = cohorts.map((cohort) => cohort.commitments.broken_rate);
const roleRates = Object.values(aggregateReport.win_rate_by_role).map((row) => row.win_rate);
const report = {
  schema: "court.balance.ensemble.v1",
  generated_at: new Date().toISOString(),
  policy_population: "seeded deterministic heuristic policy",
  evidence_scope: "mechanics balance; not model-agent strategic quality",
  env_version: COURT_VERSION,
  seed_prefix: seedPrefix,
  cohorts: cohortCount,
  episodes_per_cohort: episodesPerCohort,
  total_episodes: cohortCount * episodesPerCohort,
  aggregate: {
    ...aggregateReport,
    role_win_rate_range: round(Math.max(...roleRates) - Math.min(...roleRates))
  },
  seed_sensitivity: {
    break_rate: distribution(breakRates),
    cohorts_passing_break_band: cohorts.filter((cohort) => inBreakBand(cohort.commitments.broken_rate)).length,
    cohorts_passing_disposition_gate: cohorts.filter(dispositionPasses).length,
    robust_gate_passed: cohorts.every((cohort) => inBreakBand(cohort.commitments.broken_rate) && dispositionPasses(cohort))
  },
  cohort_results: cohorts
};

const out = resolve(args.out ?? "results/court-balance-ensemble-2000.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ out, total_episodes: report.total_episodes, aggregate: report.aggregate, seed_sensitivity: report.seed_sensitivity }, null, 2));

function newCounters() {
  return { episodes: 0, turns: 0, tokens: 0, made: 0, broken: 0, dispositions: {}, roles: {}, archetypes: {} };
}

function summarizeInto(episodes, tokenCounts, aggregateCounters) {
  const counters = newCounters();
  for (const [index, episode] of episodes.entries()) {
    counters.episodes += 1;
    counters.turns += episode.turns.length;
    counters.tokens += tokenCounts[index];
    const winners = new Set(episode.outcome.winner_seats);
    for (const player of episode.players) {
      const disposition = counters.dispositions[player.disposition] ??= { appearances: 0, winning_seats: 0, normalized_victory_credit: 0 };
      disposition.appearances += 1;
      if (winners.has(player.seat)) {
        disposition.winning_seats += 1;
        disposition.normalized_victory_credit += 1 / Math.max(1, winners.size);
      }
      const role = counters.roles[player.seat] ??= { appearances: 0, wins: 0 };
      role.appearances += 1;
      if (winners.has(player.seat)) role.wins += 1;
      if (player.archetype) {
        const archetype = counters.archetypes[player.archetype] ??= { appearances: 0, objective_successes: 0, role_wins: 0 };
        archetype.appearances += 1;
        if (episode.outcome.archetype_results?.[player.seat]?.succeeded) archetype.objective_successes += 1;
        if (winners.has(player.seat)) archetype.role_wins += 1;
      }
    }
    for (const row of Object.values(episode.outcome.commitments_summary.per_seat)) {
      counters.made += row.made;
      counters.broken += row.broken;
    }
  }
  mergeCounters(aggregateCounters, counters);
  return counters;
}

function mergeCounters(target, source) {
  for (const key of ["episodes", "turns", "tokens", "made", "broken"]) target[key] += source[key];
  for (const key of ["dispositions", "roles", "archetypes"]) {
    for (const [name, row] of Object.entries(source[key])) {
      const merged = target[key][name] ??= Object.fromEntries(Object.keys(row).map((field) => [field, 0]));
      for (const [field, value] of Object.entries(row)) merged[field] += value;
    }
  }
}

function finalizeCounters(counters, metadata) {
  const totalCredit = Object.values(counters.dispositions).reduce((sum, row) => sum + row.normalized_victory_credit, 0);
  const dispositions = Object.fromEntries(Object.entries(counters.dispositions).map(([name, row]) => [name, {
    appearances: row.appearances,
    winning_seats: row.winning_seats,
    seat_win_rate: round(row.winning_seats / row.appearances),
    normalized_victory_credit: round(row.normalized_victory_credit),
    share_of_victory_credit: round(row.normalized_victory_credit / Math.max(1, totalCredit))
  }]));
  const roles = Object.fromEntries(Object.entries(counters.roles).map(([name, row]) => [name, { ...row, win_rate: round(row.wins / row.appearances) }]));
  const archetypes = Object.fromEntries(Object.entries(counters.archetypes).map(([name, row]) => [name, {
    ...row,
    objective_success_rate: round(row.objective_successes / row.appearances),
    role_win_rate: round(row.role_wins / row.appearances)
  }]));
  return {
    ...metadata,
    episodes: counters.episodes,
    win_rate_by_disposition: dispositions,
    win_rate_by_role: roles,
    archetype_results: archetypes,
    commitments: {
      made_total: counters.made,
      broken_total: counters.broken,
      made_per_episode: round(counters.made / counters.episodes),
      broken_per_episode: round(counters.broken / counters.episodes),
      broken_rate: round(counters.broken / Math.max(1, counters.made)),
      target_band: [0.15, 0.40]
    },
    mean_episode_turn_records: round(counters.turns / counters.episodes),
    mean_episode_length_tokens: round(counters.tokens / counters.episodes)
  };
}

function exactTokenCounts(episodes) {
  const script = "import json,sys,tiktoken; e=tiktoken.get_encoding('cl100k_base'); print(json.dumps([len(e.encode(x)) for x in sys.stdin.read().splitlines() if x]))";
  const result = spawnSync("python", ["-c", script], { input: episodes.map(JSON.stringify).join("\n"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Token count failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function distribution(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const sd = Math.sqrt(variance);
  const critical = values.length === 10 ? 2.262 : values.length >= 30 ? 1.96 : 2.0;
  const margin = critical * sd / Math.sqrt(values.length);
  return { mean: round(mean), sample_sd: round(sd), minimum: round(Math.min(...values)), maximum: round(Math.max(...values)), cohort_mean_ci95: [round(mean - margin), round(mean + margin)] };
}

function inBreakBand(value) { return value >= 0.15 && value <= 0.40; }
function dispositionPasses(cohort) { return Object.values(cohort.win_rate_by_disposition).every((row) => row.share_of_victory_credit <= 0.65); }
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
