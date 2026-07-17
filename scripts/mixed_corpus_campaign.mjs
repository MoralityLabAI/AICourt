#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { DEFAULT_PROMPTS } from "../src/corpus/dispositions.mjs";
import { assertEpisode } from "../src/corpus/schema.mjs";
import { CodexPlayerPool } from "../src/campaign/codex-runner.mjs";
import { DEFAULT_CAMPAIGN_ROOT, LEGACY_SOURCES, QUALITY_GATES, TARGETS, stableCampaignConfig } from "../src/campaign/config.mjs";
import { runCentauriModelEpisode, runCourtModelEpisode, runTheySingModelEpisode } from "../src/campaign/env-drivers.mjs";
import { importBestLegacySol, importLegacyTheySing } from "../src/campaign/legacy-import.mjs";
import { courtSeatsForEpisode, pilotAssignments, scheduleEpisode } from "../src/campaign/scheduler.mjs";
import { decisionToTrainingExample } from "../src/campaign/training-view.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "status";
const root = path.resolve(args.root ?? DEFAULT_CAMPAIGN_ROOT);

if (command === "plan") console.log(JSON.stringify(planCampaign(root), null, 2));
else if (command === "import-legacy") console.log(JSON.stringify(await importLegacy(root), null, 2));
else if (command === "pilot") {
  const pilot = await runPilot(root, args);
  const rollout = String(args.autoScale ?? "true").toLowerCase() === "false" ? null : await runCampaign(root, args);
  console.log(JSON.stringify({ pilot, auto_scaled: rollout != null, rollout }, null, 2));
}
else if (command === "run" || command === "resume") console.log(JSON.stringify(await runCampaign(root, args), null, 2));
else if (command === "promote-recovered-pilot") console.log(JSON.stringify(promoteRecoveredPilot(root), null, 2));
else if (command === "quarantine-failed-pilot") console.log(JSON.stringify(quarantineFailedPilot(root), null, 2));
else if (command === "status" || command === "audit") console.log(JSON.stringify(status(root), null, 2));
else throw new Error(`Unknown command ${command}. Use plan, import-legacy, pilot, promote-recovered-pilot, run, resume, status, or audit.`);

function planCampaign(campaignRoot) {
  mkdirSync(campaignRoot, { recursive: true });
  const storage = storageStatus();
  const config = stableCampaignConfig({
    campaign_root: campaignRoot,
    codex_home: path.resolve(process.env.AICOURT_CODEX_HOME || path.join(campaignRoot, "player-home")),
    temp_root: path.join(campaignRoot, "tmp")
  });
  const assignments = pilotAssignments().map(withPromptId);
  const plan = {
    schema: "aicourt.mixed-corpus-plan.v1", created_at: new Date().toISOString(), config,
    pilot: { exact_player_slots: 18, assignments },
    legacy: { policy: "neutral only; maximum 2M exact trainable-view tokens", sources: LEGACY_SOURCES },
    storage, isolated_codex_home_ready: isolatedCodexHomeReady(config.codex_home), paid_calls_eligible: storage.eligible && isolatedCodexHomeReady(config.codex_home)
  };
  atomicJson(path.join(campaignRoot, "campaign.plan.json"), plan);
  if (!existsSync(path.join(campaignRoot, "campaign.state.json"))) atomicJson(path.join(campaignRoot, "campaign.state.json"), initialState(config));
  return plan;
}

async function importLegacy(campaignRoot) {
  ensurePlan(campaignRoot);
  const sources = [
    await importBestLegacySol(LEGACY_SOURCES.sol),
    await importLegacyTheySing(LEGACY_SOURCES.theySingBaseline),
    await importLegacyTheySing(LEGACY_SOURCES.theySingSwap)
  ];
  const episodes = sources.map((entry) => entry.episode);
  const examples = sources.flatMap((entry) => entry.examples);
  const canonicalPath = writeGzipJsonl(path.join(campaignRoot, "canonical", "legacy-neutral-00000.jsonl.gz"), episodes.map(assertEpisode));
  const trainingPath = writeGzipJsonl(path.join(campaignRoot, "training", "neutral_calibration", "legacy-neutral-00000.jsonl.gz"), examples);
  const tokens = countTokens([path.dirname(trainingPath)]);
  if (tokens.total_tokens > TARGETS.neutralTokensMax) throw new Error(`Legacy neutral slice exceeds ${TARGETS.neutralTokensMax} tokens: ${tokens.total_tokens}`);
  const receipt = {
    schema: "aicourt.legacy-import-receipt.v1", completed_at: new Date().toISOString(),
    sources: sources.map((entry) => entry.receipt), canonical_path: canonicalPath, training_path: trainingPath,
    exact_o200k: tokens, accepted: true
  };
  atomicJson(path.join(campaignRoot, "receipts", "legacy-import.json"), receipt);
  updateState(campaignRoot, { legacy_imported: true, neutral_tokens: tokens.total_tokens, updated_at: new Date().toISOString() });
  return receipt;
}

async function runPilot(campaignRoot, options) {
  ensurePlan(campaignRoot);
  const before = storageStatus();
  if (!before.eligible) throw new Error(`Paid pilot blocked by storage gate: ${before.reasons.join("; ")}`);
  const config = readJson(path.join(campaignRoot, "campaign.plan.json")).config;
  requireIsolatedCodexHome(config.codex_home);
  const pool = new CodexPlayerPool({ campaignRoot, codexHome: config.codex_home, tempRoot: config.temp_root, concurrency: campaignConcurrency(options, config), attempts: 2, timeoutMs: 1_200_000 });
  const assignments = pilotAssignments().map(withPromptId);
  const attemptsBefore = attemptReceiptPaths(campaignRoot);
  const pilotKey = `pilot-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const numericSeed = 81_000 + (Date.now() % 900_000);
  const results = [];
  try {
    results.push(await runCentauriModelEpisode({ assignments: assignments.filter((entry) => entry.env === "centauri"), pool, outDir: path.join(campaignRoot, "native", pilotKey, "centauri"), seed: `${pilotKey}-centauri`, turns: Number(options.centauriTurns ?? 1) }));
    results.push(await runTheySingModelEpisode({ assignments: assignments.filter((entry) => entry.env === "they_sing"), pool, outDir: path.join(campaignRoot, "native", pilotKey, "they-sing"), seed: numericSeed, turns: Number(options.theySingTurns ?? 1) }));
    results.push(await runCourtModelEpisode({ assignments: assignments.filter((entry) => entry.env === "court"), pool, seed: `${pilotKey}-court`, maxTurns: Number(options.courtTurns ?? 10) }));
  } catch (error) {
    const paidAttempts = new Set([...attemptReceiptPaths(campaignRoot)].filter((entry) => !attemptsBefore.has(entry))).size;
    const failed = {
      schema: "aicourt.mixed-pilot-gates.v1", completed_at: new Date().toISOString(), accepted: false,
      failures: [`pilot execution failed: ${error.message}`], calls: 0, paid_attempts: paidAttempts,
      valid_responses: 0, fallback_count: 0, artifacts: {}, storage: storageStatus()
    };
    atomicJson(path.join(campaignRoot, "receipts", "pilot.json"), failed);
    const priorState = readJson(path.join(campaignRoot, "campaign.state.json"));
    updateState(campaignRoot, { pilot_status: "failed", paid_attempts: Number(priorState.paid_attempts ?? 0) + paidAttempts, updated_at: new Date().toISOString() });
    throw error;
  }
  const artifacts = persistNewResults(campaignRoot, results, "pilot-00000", { area: path.join("staging", pilotKey) });
  const gates = evaluatePilot(results, artifacts, before);
  gates.completed_at = new Date().toISOString();
  gates.paid_attempts = new Set([...attemptReceiptPaths(campaignRoot)].filter((entry) => !attemptsBefore.has(entry))).size;
  gates.storage_mode = "isolated_campaign_and_player_home";
  gates.staging_key = pilotKey;
  if (gates.accepted) gates.promoted_artifacts = promotePilotArtifacts(campaignRoot, artifacts);
  atomicJson(path.join(campaignRoot, "receipts", "pilot.json"), gates);
  const priorState = readJson(path.join(campaignRoot, "campaign.state.json"));
  updateState(campaignRoot, {
    pilot_status: gates.accepted ? "passed" : "failed",
    accepted_calls: gates.accepted ? Number(priorState.accepted_calls ?? 0) + gates.calls : Number(priorState.accepted_calls ?? 0),
    paid_attempts: Number(priorState.paid_attempts ?? 0) + Number(gates.paid_attempts ?? gates.calls),
    updated_at: new Date().toISOString()
  });
  if (!gates.accepted) throw new Error(`Pilot gates failed: ${gates.failures.join("; ")}`);
  return gates;
}

async function runCampaign(campaignRoot, options) {
  ensurePlan(campaignRoot);
  const state = readJson(path.join(campaignRoot, "campaign.state.json"));
  if (state.pilot_status !== "passed") throw new Error("Full run requires a passed pilot receipt");
  const config = readJson(path.join(campaignRoot, "campaign.plan.json")).config;
  requireIsolatedCodexHome(config.codex_home);
  const pool = new CodexPlayerPool({ campaignRoot, codexHome: config.codex_home, tempRoot: config.temp_root, concurrency: campaignConcurrency(options, config), attempts: 2, timeoutMs: 1_200_000 });
  const maxEpisodes = Number(options.maxEpisodes ?? 1000);
  const batchSize = Math.max(1, Number(options.batchSize ?? 5));
  let completed = 0;
  while (completed < maxEpisodes) {
    const storage = storageStatus();
    if (!storage.eligible) throw new Error(`Campaign paused by storage floor: ${storage.reasons.join("; ")}`);
    const report = countPrimaryTokens(campaignRoot);
    const newReport = countNewTokens(campaignRoot);
    if (report.total_tokens > TARGETS.trainableTokensMax) throw new Error(`Campaign exceeded maximum token target: ${report.total_tokens}`);
    if (report.total_tokens >= TARGETS.trainableTokensMin && evaluateFinalMix(campaignRoot, report).failures.length === 0) break;
    const remainingCalls = TARGETS.maxAcceptedCalls - Number(state.accepted_calls ?? 0);
    if (remainingCalls < 1) throw new Error("Accepted-call budget exhausted before token target");
    const index = Number(state.episodes ?? 0);
    const env = selectEnvironment(report.by_env ?? {}, remainingCalls, index);
    const seats = seatsForEnv(env, index);
    const tokenLedger = cellLedger(newReport.by_cell ?? {});
    const assignments = scheduleEpisode({ env, seats, episodeIndex: index, tokenLedger }).map(withPromptId);
    let result;
    const attemptsBefore = attemptReceiptPaths(campaignRoot);
    try {
      if (env === "centauri") result = await runCentauriModelEpisode({ assignments, pool, outDir: path.join(campaignRoot, "native", `centauri-${pad(index)}`), episodeIndex: index, turns: 1 });
      else if (env === "they_sing") result = await runTheySingModelEpisode({ assignments, pool, outDir: path.join(campaignRoot, "native", `they-sing-${pad(index)}`), episodeIndex: index, turns: 1 });
      else result = await runCourtModelEpisode({ assignments, pool, episodeIndex: index, maxTurns: 16 });
    } catch (error) {
      state.paid_attempts = Number(state.paid_attempts ?? 0) + new Set([...attemptReceiptPaths(campaignRoot)].filter((entry) => !attemptsBefore.has(entry))).size;
      state.updated_at = new Date().toISOString();
      atomicJson(path.join(campaignRoot, "campaign.state.json"), state);
      throw error;
    }
    if (Number(state.accepted_calls ?? 0) + result.decisions.length > TARGETS.maxAcceptedCalls) {
      throw new Error(`Episode would exceed accepted-call budget: ${state.accepted_calls} + ${result.decisions.length} > ${TARGETS.maxAcceptedCalls}`);
    }
    persistNewResults(campaignRoot, [result], `new-${pad(index)}`);
    completed += 1;
    state.episodes = Number(state.episodes ?? 0) + 1;
    state.accepted_calls = Number(state.accepted_calls ?? 0) + result.decisions.length;
    state.paid_attempts = Number(state.paid_attempts ?? 0) + new Set([...attemptReceiptPaths(campaignRoot)].filter((entry) => !attemptsBefore.has(entry))).size;
    state.updated_at = new Date().toISOString();
    atomicJson(path.join(campaignRoot, "campaign.state.json"), state);
    if (completed % batchSize === 0) {
      const audit = countPrimaryTokens(campaignRoot);
      atomicJson(path.join(campaignRoot, "receipts", `token-check-${pad(state.episodes)}.json`), audit);
      if (audit.total_tokens > TARGETS.trainableTokensMax) throw new Error(`Campaign overshot maximum token target: ${audit.total_tokens}`);
    }
  }
  const final = countPrimaryTokens(campaignRoot);
  const mix = evaluateFinalMix(campaignRoot, final);
  const accepted = final.total_tokens >= TARGETS.trainableTokensMin && final.total_tokens <= TARGETS.trainableTokensMax && mix.failures.length === 0;
  updateState(campaignRoot, { status: accepted ? "complete" : "paused", exact_o200k_tokens: final.total_tokens, updated_at: new Date().toISOString() });
  return { accepted, episodes_this_run: completed, tokens: final, mix };
}

function persistNewResults(campaignRoot, results, key, { area = "" } = {}) {
  const artifactRoot = area ? path.join(campaignRoot, area) : campaignRoot;
  const episodes = results.map((entry) => assertEpisode(entry.episode));
  const decisions = results.flatMap((entry) => entry.decisions);
  const primary = decisions.filter((decision) => decision.disposition !== "neutral").map((decision) => decisionToTrainingExample(decision, { conditional: false }));
  const conditional = decisions.map((decision) => decisionToTrainingExample(decision, { conditional: true }));
  const canonicalPath = writeGzipJsonl(path.join(artifactRoot, "canonical", `${key}.jsonl.gz`), episodes);
  const decisionPath = writeGzipJsonl(path.join(artifactRoot, "decisions", `${key}.jsonl.gz`), decisions);
  const primaryPath = writeGzipJsonl(path.join(artifactRoot, "training", "primary", `${key}.jsonl.gz`), primary);
  const conditionalPath = writeGzipJsonl(path.join(artifactRoot, "training", "conditional", `${key}.jsonl.gz`), conditional);
  return { canonical_path: canonicalPath, decision_path: decisionPath, primary_path: primaryPath, conditional_path: conditionalPath, primary_tokens: countTokens([primaryPath]) };
}

function promotePilotArtifacts(campaignRoot, artifacts) {
  return {
    canonical_path: moveArtifact(artifacts.canonical_path, path.join(campaignRoot, "canonical", "pilot-00000.jsonl.gz")),
    decision_path: moveArtifact(artifacts.decision_path, path.join(campaignRoot, "decisions", "pilot-00000.jsonl.gz")),
    primary_path: moveArtifact(artifacts.primary_path, path.join(campaignRoot, "training", "primary", "pilot-00000.jsonl.gz")),
    conditional_path: moveArtifact(artifacts.conditional_path, path.join(campaignRoot, "training", "conditional", "pilot-00000.jsonl.gz"))
  };
}

function promoteRecoveredPilot(campaignRoot) {
  const receiptPath = path.join(campaignRoot, "receipts", "pilot.json");
  const receipt = readJson(receiptPath);
  if (receipt.accepted) return { promoted: false, reason: "pilot already accepted", receipt };
  const failures = receipt.failures ?? [];
  if (!failures.length || failures.some((failure) => !String(failure).startsWith("storage floor breached after pilot:"))) {
    throw new Error(`Pilot has non-storage failures and cannot be recovered: ${failures.join("; ")}`);
  }
  const storage = storageStatus();
  if (!storage.eligible) throw new Error(`Storage has not recovered: ${storage.reasons.join("; ")}`);
  const sourceKeys = ["canonical_path", "decision_path", "primary_path", "conditional_path"];
  for (const key of sourceKeys) if (typeof receipt.artifacts?.[key] !== "string" || !existsSync(receipt.artifacts[key])) {
    throw new Error(`Recovered pilot is missing staged artifact ${key}`);
  }
  const destinations = ["canonical", "decisions", path.join("training", "primary"), path.join("training", "conditional")]
    .map((area) => path.join(campaignRoot, area, "pilot-00000.jsonl.gz"));
  for (const destination of destinations) if (existsSync(destination)) throw new Error(`Refusing recovered promotion because destination exists: ${destination}`);
  const recounted = countTokens([receipt.artifacts.primary_path]);
  if (Number(recounted.total_tokens) !== Number(receipt.tokens?.total_tokens)) {
    throw new Error(`Recovered pilot token mismatch: staged ${recounted.total_tokens}, receipt ${receipt.tokens?.total_tokens}`);
  }
  const promotedArtifacts = promotePilotArtifacts(campaignRoot, receipt.artifacts);
  const recoveredAt = new Date().toISOString();
  const recovered = {
    ...receipt,
    accepted: true,
    failures: [],
    warnings: [...(receipt.warnings ?? []), "Pilot promoted after the transient C: storage floor recovered; staged artifacts and exact token count were revalidated without new model calls."],
    recovered_at: recoveredAt,
    recovery_storage: storage,
    promoted_artifacts: promotedArtifacts
  };
  atomicJson(receiptPath, recovered);
  const state = readJson(path.join(campaignRoot, "campaign.state.json"));
  updateState(campaignRoot, {
    pilot_status: "passed",
    accepted_calls: Number(state.accepted_calls ?? 0) + Number(receipt.calls ?? 0),
    updated_at: recoveredAt
  });
  return { promoted: true, new_model_calls: 0, receipt: recovered };
}

function moveArtifact(source, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) throw new Error(`Refusing to overwrite promoted artifact: ${destination}`);
  renameSync(source, destination);
  return destination;
}

function evaluatePilot(results, artifacts, before) {
  const decisions = results.flatMap((entry) => entry.decisions);
  const episodes = results.map((entry) => entry.episode);
  const calls = decisions.length;
  const legal = decisions.filter((entry) => entry.labels?.action_legal !== false && entry.labels?.response_valid !== false).length;
  const fallbacks = decisions.filter((entry) => entry.labels?.fallback_used === true).length;
  const hashes = decisions.map((entry) => sha256(JSON.stringify(entry.target)));
  const unique = new Set(hashes).size / Math.max(1, hashes.length);
  const commitments = episodes.flatMap((episode) => episode.turns.flatMap((turn) => turn.events)).filter((event) => event.type === "commitment");
  const broken = episodes.flatMap((episode) => episode.turns.flatMap((turn) => turn.events)).filter((event) => event.type === "commitment_resolution" && event.resolution === "broken");
  const brokenRate = commitments.length ? broken.length / commitments.length : 0;
  const after = storageStatus();
  const systemGrowth = Math.max(0, before.system_free_bytes - after.system_free_bytes);
  const tokenReport = artifacts.primary_tokens;
  const failures = [];
  const warnings = [];
  if (legal !== calls) failures.push("valid response rate below 100%");
  if (fallbacks !== 0) failures.push(`fallback count is ${fallbacks}, expected zero`);
  if (legal / Math.max(1, calls) < QUALITY_GATES.legalActionRate) failures.push("legal response rate below 95%");
  if (unique < QUALITY_GATES.behaviorUniqueness) failures.push("behavior uniqueness below 80%");
  if (tokenReport.assistant_tokens / Math.max(1, tokenReport.total_tokens) < QUALITY_GATES.assistantTokenShare) failures.push("assistant token share below 15%");
  if (brokenRate < QUALITY_GATES.brokenCommitmentRateMin || brokenRate > QUALITY_GATES.brokenCommitmentRateMax) failures.push("broken commitment rate outside 15-40%");
  if (!after.eligible) failures.push(`storage floor breached after pilot: ${after.reasons.join("; ")}`);
  if (systemGrowth > QUALITY_GATES.maximumSystemGrowthBytesDuringPilot) warnings.push("Observed system-volume growth exceeded the configured pilot allowance; this is reported separately from campaign-volume use");
  return { schema: "aicourt.mixed-pilot-gates.v1", accepted: failures.length === 0, failures, warnings, calls, paid_attempts: calls, valid_responses: legal, fallback_count: fallbacks, behavior_uniqueness: unique, commitments: commitments.length, broken_commitments: broken.length, broken_commitment_rate: brokenRate, system_growth_bytes: systemGrowth, system_free_bytes_before: before.system_free_bytes, system_free_bytes_after: after.system_free_bytes, tokens: tokenReport, artifacts };
}

function attemptReceiptPaths(campaignRoot) {
  const root = path.join(campaignRoot, "model_calls");
  const found = new Set();
  if (!existsSync(root)) return found;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.endsWith(".receipt.json")) found.add(full);
    }
  };
  visit(root);
  return found;
}

function quarantineFailedPilot(campaignRoot) {
  const receiptPath = path.join(campaignRoot, "receipts", "pilot.json");
  const receipt = readJson(receiptPath);
  if (receipt.accepted) throw new Error("Refusing to quarantine an accepted pilot");
  const quarantineRoot = path.join(campaignRoot, "quarantine", `failed-pilot-${String(receipt.completed_at ?? new Date().toISOString()).replace(/[:.]/g, "-")}`);
  const moved = {};
  for (const [key, source] of Object.entries(receipt.artifacts ?? {})) {
    if (key === "primary_tokens" || typeof source !== "string" || !existsSync(source)) continue;
    const destination = path.join(quarantineRoot, path.basename(path.dirname(source)), path.basename(source));
    mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(source, destination);
    moved[key] = destination;
  }
  receipt.quarantined_at = new Date().toISOString();
  receipt.quarantined_artifacts = moved;
  atomicJson(receiptPath, receipt);
  const state = readJson(path.join(campaignRoot, "campaign.state.json"));
  updateState(campaignRoot, { accepted_calls: 0, paid_attempts: Math.max(Number(state.paid_attempts ?? 0), 133), updated_at: new Date().toISOString() });
  return { quarantined: true, artifacts: moved };
}

function status(campaignRoot) {
  if (!existsSync(path.join(campaignRoot, "campaign.state.json"))) return { exists: false, campaign_root: campaignRoot, storage: storageStatus() };
  return { exists: true, campaign_root: campaignRoot, state: readJson(path.join(campaignRoot, "campaign.state.json")), tokens: countPrimaryTokens(campaignRoot), storage: storageStatus() };
}

function countPrimaryTokens(campaignRoot) {
  const paths = [];
  const primary = path.join(campaignRoot, "training", "primary"); if (existsSync(primary)) paths.push(primary);
  const neutral = path.join(campaignRoot, "training", "neutral_calibration"); if (existsSync(neutral)) paths.push(neutral);
  return paths.length ? countTokens(paths) : emptyTokenReport();
}

function countNewTokens(campaignRoot) {
  const primary = path.join(campaignRoot, "training", "primary");
  return existsSync(primary) ? countTokens([primary]) : emptyTokenReport();
}

function evaluateFinalMix(campaignRoot, overall) {
  const fresh = countNewTokens(campaignRoot);
  const neutral = Number(overall.by_disposition?.neutral ?? 0);
  const failures = [];
  checkShares(overall.by_model, overall.total_tokens, TARGETS.modelShares, TARGETS.modelTolerance, "model", failures);
  checkShares(overall.by_env, overall.total_tokens, TARGETS.environmentShares, TARGETS.environmentTolerance, "environment", failures);
  checkShares(fresh.by_effort, fresh.total_tokens, TARGETS.reasoningShares, TARGETS.reasoningTolerance, "new reasoning", failures);
  checkShares(fresh.by_disposition, fresh.total_tokens, TARGETS.dispositionShares, TARGETS.dispositionTolerance, "new disposition", failures);
  if (neutral > TARGETS.neutralTokensMax || neutral / Math.max(1, overall.total_tokens) > 0.25) failures.push("neutral slice exceeds its 2M/25% cap");
  return { failures, overall_model: shares(overall.by_model, overall.total_tokens), overall_environment: shares(overall.by_env, overall.total_tokens), new_reasoning: shares(fresh.by_effort, fresh.total_tokens), new_disposition: shares(fresh.by_disposition, fresh.total_tokens), neutral_tokens: neutral };
}

function checkShares(actual, total, targets, tolerance, label, failures) {
  for (const [key, target] of Object.entries(targets)) {
    const value = Number(actual?.[key] ?? 0) / Math.max(1, total);
    if (Math.abs(value - target) > tolerance) failures.push(`${label} ${key} share ${value.toFixed(4)} outside ${target} ± ${tolerance}`);
  }
}

function shares(values = {}, total = 0) { return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value) / Math.max(1, total)])); }

function countTokens(paths) {
  const result = spawnSync("python", [path.resolve("scripts", "count_training_tokens.py"), ...paths], { cwd: path.resolve("."), encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Token count failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function storageStatus(campaignRoot = root) {
  const systemVolume = path.parse(path.resolve(process.env.USERPROFILE || process.cwd())).root;
  const campaignVolume = path.parse(path.resolve(campaignRoot)).root;
  const system = freeBytes(systemVolume), campaign = freeBytes(campaignVolume);
  const reasons = [];
  if (system < QUALITY_GATES.minimumFreeSystemBytes) reasons.push(`System volume ${systemVolume} free ${system} < ${QUALITY_GATES.minimumFreeSystemBytes}`);
  if (campaign < QUALITY_GATES.minimumFreeCampaignBytes) reasons.push(`Campaign volume ${campaignVolume} free ${campaign} < ${QUALITY_GATES.minimumFreeCampaignBytes}`);
  return { system_volume: systemVolume, campaign_volume: campaignVolume, system_free_bytes: system, campaign_free_bytes: campaign, eligible: reasons.length === 0, reasons };
}

function requireIsolatedCodexHome(home) {
  if (!existsSync(path.join(home, "auth.json"))) throw new Error(`Isolated Codex home is not authenticated: ${home}`);
}

function campaignConcurrency(options, config) {
  const value = Number(options.concurrency ?? config.decision_concurrency ?? 2);
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error(`Concurrency must be an integer from 1 through 6, received ${value}`);
  return value;
}

function isolatedCodexHomeReady(home) {
  return existsSync(path.join(home, "auth.json"));
}

function selectEnvironment(actual, remainingCalls = Number.POSITIVE_INFINITY, episodeIndex = 0) {
  const total = Object.values(actual).reduce((sum, value) => sum + Number(value), 0) || 1;
  const eligible = Object.entries(TARGETS.environmentShares).filter(([env]) => maximumEpisodeCalls(env, episodeIndex) <= remainingCalls);
  if (!eligible.length) throw new Error(`No environment fits the remaining accepted-call budget of ${remainingCalls}`);
  return eligible.sort((a, b) => (b[1] - Number(actual[b[0]] ?? 0) / total) - (a[1] - Number(actual[a[0]] ?? 0) / total))[0][0];
}

function maximumEpisodeCalls(env, episodeIndex = 0) {
  if (env === "centauri") return 30;
  if (env === "they_sing") return 7;
  return courtSeatsForEpisode(episodeIndex).length * 2 * 16;
}

function seatsForEnv(env, episodeIndex = 0) {
  if (env === "centauri") return ["forgehold", "continuity", "ledger", "choir", "keystone"];
  if (env === "they_sing") return ["HEGEMON", "STATE", "INFILTRATOR", "BROKER", "ARCHIVIST", "CONVENOR", "CANTOR"];
  return courtSeatsForEpisode(episodeIndex);
}

function cellLedger(byCell) { return Object.fromEntries(Object.entries(byCell).map(([key, value]) => [key, Number(value)])); }
function withPromptId(entry) { return { ...entry, disposition_prompt_id: DEFAULT_PROMPTS[entry.disposition] }; }
function ensurePlan(campaignRoot) { if (!existsSync(path.join(campaignRoot, "campaign.plan.json"))) planCampaign(campaignRoot); }
function initialState(config) { return { schema: "aicourt.mixed-corpus-campaign.v1.state", status: "planned", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), config_sha256: sha256(JSON.stringify(config)), legacy_imported: false, pilot_status: "not_run", episodes: 0, accepted_calls: 0, neutral_tokens: 0 }; }
function updateState(campaignRoot, patch) { const target = path.join(campaignRoot, "campaign.state.json"); atomicJson(target, { ...readJson(target), ...patch }); }
function writeGzipJsonl(target, rows) { mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { level: 9 })); renameSync(temp, target); return target; }
function atomicJson(target, value) { mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); renameSync(temp, target); }
function readJson(target) { return JSON.parse(readFileSync(target, "utf8")); }
function freeBytes(rootPath) { const stats = statfsSync(rootPath); return Number(stats.bavail) * Number(stats.bsize); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function pad(value) { return String(value).padStart(5, "0"); }
function emptyTokenReport() { return { examples: 0, input_tokens: 0, assistant_tokens: 0, total_tokens: 0, by_cell: {}, by_env: {}, by_disposition: {}, by_model: {}, by_effort: {} }; }
function parseArgs(values) { const parsed = { _: [] }; for (let i = 0; i < values.length; i += 1) { const value = values[i]; if (!value.startsWith("--")) parsed._.push(value); else { const key = value.slice(2); parsed[key] = values[i + 1] && !values[i + 1].startsWith("--") ? values[++i] : true; } } return parsed; }
