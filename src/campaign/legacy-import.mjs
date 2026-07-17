import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EpisodeLogger } from "../corpus/episode-logger.mjs";
import { TRAINING_VIEW_SCHEMA } from "./training-view.mjs";

const COMMON_SYSTEM = "You are a strategic game agent. Use only the supplied observation, respect private-information boundaries, return the required response, and never expose hidden chain-of-thought.";
const LEGACY_PROMPT_ID = "legacy.neutral.unprompted.v1";

export async function importLegacyTheySing(campaignDir) {
  const reportPath = path.join(campaignDir, "session_token_report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const corpusPath = path.resolve(report.corpusPath ?? path.join(campaignDir, "corpus", "player_sessions.jsonl"));
  const bytes = await readFile(corpusPath);
  const actualSha = sha256(bytes);
  if (actualSha !== report.corpusSha256) throw new Error(`They Sing corpus SHA mismatch: ${corpusPath}`);
  if (report.targetStatus !== "accepted" || report.quality?.completeFactionCoverage !== true) {
    throw new Error(`They Sing legacy source is not an accepted complete-faction corpus: ${campaignDir}`);
  }
  const rows = parseJsonl(bytes.toString("utf8"));
  const episodeId = uuidFrom(`legacy-they-sing:${campaignDir}`);
  const examples = rows.map((row) => legacyExample({
    episodeId,
    env: "they_sing",
    seat: String(row.factionId).toLowerCase(),
    turn: Number(row.gameTurn),
    phase: "full_turn_plan",
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    prompt: row.prompt,
    response: row.response,
    source: corpusPath,
    sourceSha256: actualSha
  }));
  const episode = buildTheySingEpisode(rows, episodeId, campaignDir, report);
  return { episode, examples, receipt: sourceReceipt("they_sing", campaignDir, corpusPath, actualSha, rows.length, report.contentTokens) };
}

export async function importBestLegacySol(campaignDir) {
  const state = JSON.parse(await readFile(path.join(campaignDir, "campaign.state.json"), "utf8"));
  if (!Array.isArray(state.accepted) || !state.accepted.length) throw new Error(`Sol campaign has no accepted shards: ${campaignDir}`);
  const candidates = state.accepted.filter((entry) => entry.split === "discovery").sort((a, b) => qualityScore(b) - qualityScore(a) || a.tokens - b.tokens || a.shard_id.localeCompare(b.shard_id));
  const selected = candidates[0];
  if (!selected) throw new Error("Sol campaign has no accepted discovery shard");
  const corpusPath = path.resolve(campaignDir, selected.dataset);
  const bytes = await readFile(corpusPath);
  const actualSha = sha256(bytes);
  if (actualSha !== selected.sha256) throw new Error(`Sol shard SHA mismatch: ${corpusPath}`);
  const rows = parseJsonl(bytes.toString("utf8"));
  const reset = rows.find((row) => row.event === "reset");
  const terminal = rows.find((row) => row.event === "terminal");
  const episodeId = uuidFrom(`legacy-sol:${selected.shard_id}:${actualSha}`);
  const decisions = [];
  for (const row of rows.filter((entry) => entry.event === "step")) {
    for (const phase of row.payload?.phases ?? []) for (const decision of phase.decisions ?? []) {
      if (decision.fallback_used || !decision.response) continue;
      decisions.push({ turn: Number(row.payload.turn), phase: phase.phase, ...decision });
    }
  }
  const examples = decisions.map((decision) => legacyExample({
    episodeId,
    env: "centauri",
    seat: decision.actor_id,
    turn: decision.turn,
    phase: decision.phase,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    prompt: JSON.stringify(decision.request),
    response: JSON.stringify(decision.response),
    source: corpusPath,
    sourceSha256: actualSha,
    labels: { response_valid: decision.validation?.valid !== false, fallback_used: false }
  }));
  const episode = buildSolEpisode({ rows, reset, terminal, decisions, episodeId, selected });
  return { episode, examples, selected, receipt: sourceReceipt("centauri", campaignDir, corpusPath, actualSha, decisions.length, selected.tokens) };
}

export async function inspectLegacyInventory({ sol, theySing = [] }) {
  const solImport = await importBestLegacySol(sol);
  const theySingImports = [];
  for (const campaignDir of theySing) theySingImports.push(await importLegacyTheySing(campaignDir));
  return {
    schema: "aicourt.legacy-inventory.v1",
    accepted: true,
    neutral_policy: "unprompted legacy traces remain neutral",
    sources: [solImport.receipt, ...theySingImports.map((entry) => entry.receipt)],
    selected_sol_shard: solImport.selected.shard_id,
    examples: solImport.examples.length + theySingImports.reduce((sum, entry) => sum + entry.examples.length, 0)
  };
}

function legacyExample({ episodeId, env, seat, turn, phase, model, reasoningEffort, prompt, response, source, sourceSha256, labels = {} }) {
  const identity = `${episodeId}:${seat}:${turn}:${phase}`;
  return {
    schema: TRAINING_VIEW_SCHEMA,
    example_id: sha256(identity).slice(0, 24),
    episode_id: episodeId,
    env,
    seat,
    turn,
    phase,
    split: "neutral_calibration",
    model,
    reasoning_effort: reasoningEffort,
    disposition: "neutral",
    disposition_prompt_id: LEGACY_PROMPT_ID,
    disposition_assignment_source: "legacy_unprompted",
    messages: [
      { role: "system", content: COMMON_SYSTEM },
      { role: "user", content: String(prompt) },
      { role: "assistant", content: String(response) }
    ],
    labels: { ...labels, legacy_source: source, legacy_source_sha256: sourceSha256 }
  };
}

function buildTheySingEpisode(rows, episodeId, campaignDir, report) {
  const seats = [...new Set(rows.map((row) => String(row.factionId).toLowerCase()))];
  const firstBySeat = Object.fromEntries(seats.map((seat) => [seat, rows.find((row) => String(row.factionId).toLowerCase() === seat)]));
  const logger = new EpisodeLogger({
    episodeId,
    env: "they_sing",
    envVersion: "legacy-player-session-v1",
    generatorModel: "mixed legacy Terra/Luna; see per-player metadata",
    createdAt: new Date(0).toISOString(),
    players: seats.map((seat) => ({
      seat,
      agent_id: `legacy:${seat}`,
      disposition: "neutral",
      disposition_prompt_id: LEGACY_PROMPT_ID,
      hidden_win_condition: "Legacy role objective embedded in the source prompt.",
      generator_model: firstBySeat[seat].model,
      reasoning_effort: firstBySeat[seat].reasoningEffort,
      disposition_assignment_source: "legacy_unprompted"
    }))
  });
  for (const turn of [...new Set(rows.map((row) => Number(row.gameTurn)))].sort((a, b) => a - b)) {
    logger.startTurn(turn);
    for (const row of rows.filter((entry) => Number(entry.gameTurn) === turn)) {
      logger.action(String(row.factionId).toLowerCase(), { type: "legacy_turn_plan", plan: safeJson(row.response), source_id: row.id });
    }
    logger.finishTurn();
  }
  return logger.finish({
    winner_seats: [],
    win_type: "legacy_truncated_running",
    won_via_betrayal: false,
    legacy_source: campaignDir,
    legacy_order_acceptance_rate: report.gameQuality?.orderAcceptanceRate ?? null
  });
}

function buildSolEpisode({ rows, reset, terminal, decisions, episodeId, selected }) {
  const seats = [...new Set(decisions.map((decision) => decision.actor_id))];
  const logger = new EpisodeLogger({
    episodeId,
    env: "centauri",
    envVersion: reset?.payload?.engine_version ?? "legacy-research-v2",
    generatorModel: "gpt-5.6-sol; reasoning_effort=high",
    createdAt: new Date(0).toISOString(),
    players: seats.map((seat) => ({
      seat,
      agent_id: `legacy:${seat}`,
      disposition: "neutral",
      disposition_prompt_id: LEGACY_PROMPT_ID,
      hidden_win_condition: "Maximize faction score under the research-v2 scenario.",
      generator_model: "gpt-5.6-sol",
      reasoning_effort: "high",
      disposition_assignment_source: "legacy_unprompted"
    }))
  });
  for (const row of rows.filter((entry) => entry.event === "step")) {
    logger.startTurn(Number(row.payload.turn));
    for (const phase of row.payload.phases ?? []) for (const decision of phase.decisions ?? []) {
      if (!decision.response) continue;
      logger.action(decision.actor_id, { type: "legacy_phase_decision", phase: phase.phase, response: decision.response, fallback_used: Boolean(decision.fallback_used) });
    }
    logger.finishTurn();
  }
  const leader = terminal?.payload?.eventual_leader;
  return logger.finish({
    winner_seats: leader ? [leader] : [],
    win_type: terminal?.payload?.termination_reason ?? "legacy_completion",
    won_via_betrayal: false,
    scenario: selected.scenario,
    legacy_quality: selected.quality
  });
}

function sourceReceipt(env, campaignDir, corpusPath, corpusSha256, records, reportedTokens) {
  return { env, campaign_dir: campaignDir, corpus_path: corpusPath, corpus_sha256: corpusSha256, records, reported_o200k_tokens: reportedTokens, disposition: "neutral" };
}

function qualityScore(entry) {
  const q = entry.quality ?? {};
  return Number(q.coalition_episodes ?? 0) * 20 + Number(q.technology_trades ?? 0) * 8 + Number(q.research_pacts ?? 0) * 5 + Number(q.pValue_keyrings ?? 0);
}

function parseJsonl(text) { return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function safeJson(value) { try { return JSON.parse(value); } catch { return { raw: String(value) }; } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function uuidFrom(value) {
  const hex = sha256(value).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
