import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adaptCentauriJsonl } from "../adapters/centauri.mjs";
import { adaptTheySingJsonl } from "../adapters/they-sing.mjs";
import { DEFAULT_PROMPTS } from "../corpus/dispositions.mjs";
import { dispositionPrompt } from "../corpus/prompting.mjs";
import { createCourtModelEpisode } from "../court/engine.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECTS_ROOT = path.dirname(REPO_ROOT);
const ALPHA_ROOT = path.resolve(process.env.ALPHA_CENTAURAI_ROOT || path.join(PROJECTS_ROOT, "AIpha CentaurAI"));
const THEYSING_ROOT = path.resolve(process.env.THEYSING_ROOT || path.join(PROJECTS_ROOT, "TheySing", "TheySing"));
const THEYSING_REPLAY_CONFIG = path.resolve(process.env.THEYSING_REPLAY_CONFIG || path.join(THEYSING_ROOT, "playtest", "replay_session_config.json"));
const ALPHA_SCHEMA = path.join(ALPHA_ROOT, "tools", "research_agent_response.schema.json");
const THEYSING_SCHEMA = path.join(THEYSING_ROOT, "playtest", "codex-player-turn.schema.json");

export async function runCourtModelEpisode({ assignments, pool, episodeIndex = 0, maxTurns = 16, seed = `mixed-court-${episodeIndex}` }) {
  const enriched = enrichAssignments(assignments);
  return createCourtModelEpisode({
    seed, episodeIndex, players: enriched.length, assignments: enriched, maxTurns,
    generatorModel: "mixed Sol/Terra/Luna; per-player metadata",
    decide: async ({ player, assignment, turn, phase, observation, legalActions }) => {
      const prompt = strategicPrompt({ env: "Court", seat: player.seat, assignment, turn, phase, observation, legalActions });
      return (await pool.decide({ episodeId: `court-${seed}`, seat: player.seat, assignment, prompt })).response;
    }
  });
}

export async function runCentauriModelEpisode({ assignments, pool, outDir, episodeIndex = 0, turns = 1, scenario = "complementary_tech_trade", seed = `mixed-centauri-${episodeIndex}` }) {
  const enriched = ensureCentauriDispositionMixture(enrichAssignments(assignments), episodeIndex);
  const bySeat = Object.fromEntries(enriched.map((entry) => [entry.seat, entry]));
  const decisions = [];
  const datasetPath = path.join(outDir, "native-centauri.jsonl");
  const manifestPath = path.join(outDir, "native-centauri.manifest.json");
  await mkdir(outDir, { recursive: true });
  const strictOutputSchema = await writeStrictCentauriSchema(outDir);
  const playerThreadNamespace = `${requestSafeKey(seed)}-centauri`;
  const datasetModule = await import(pathToFileURL(path.join(ALPHA_ROOT, "tools", "research_dataset.mjs")));
  const researchModule = await import(pathToFileURL(path.join(ALPHA_ROOT, "src", "research_v2.mjs")));
  const adapter = async (request) => {
    const assignment = bySeat[request.actor_id];
    if (!assignment) throw new Error(`No mixed assignment for Centauri actor ${request.actor_id}`);
    let validation = null;
    for (let semanticAttempt = 1; semanticAttempt <= 2; semanticAttempt += 1) {
      const prompt = semanticAttempt === 1
        ? centauriPrompt(request, assignment)
        : centauriRepairPrompt(request, assignment, validation.errors);
      const result = await pool.decide({ episodeId: `${request.episode_id}-${playerThreadNamespace}`, seat: request.actor_id, assignment, prompt, outputSchema: strictOutputSchema, maxAttempts: 1 });
      validation = researchModule.validateResearchResponse(result.response, request);
      if (!validation.ok) continue;
      decisions.push({
        episode_id: request.episode_id, env: "centauri", seat: request.actor_id, turn: request.turn, phase: request.phase,
        model: assignment.model, reasoning_effort: assignment.reasoning_effort, disposition: assignment.disposition,
        prompt_id: assignment.disposition_prompt_id, disposition_assignment_source: "prompted",
        observation: request.observation, legal_actions: request.legal_commands, open_commitments: request.observation?.diplomacy?.treaties ?? [],
        target: result.response, labels: { action_legal: true, response_valid: true, fallback_used: false, semantic_attempt: semanticAttempt, rationale_is_summary: true }
      });
      return result.response;
    }
    throw new Error(`Centauri response validation failed after one repair: ${validation.errors.join(" | ")}`);
  };
  adapter.adapterMeta = { kind: "aicourt-mixed-codex", models: [...new Set(enriched.map((entry) => entry.model))] };
  await datasetModule.generateResearchDataset({
    out: datasetPath, manifestOut: manifestPath, episodes: 1, turns, factions: enriched.length,
    scenarios: scenario, seed, split: "mixed-disposition", population: "aicourt-mixed-v1", mechanicsVersion: 3,
    dispositionByFaction: Object.fromEntries(enriched.map((entry) => [entry.seat, entry.disposition])),
    roleRotation: episodeIndex % enriched.length, maxCounterfactualsPerTurn: 1,
    decisionConcurrency: Math.max(1, Math.min(5, Number(pool.concurrency ?? 2))), decide: adapter
  });
  const nativeRows = (await readFile(datasetPath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const nativeDecisions = nativeRows.filter((row) => row.event === "step").flatMap((row) => (row.payload.phases ?? []).flatMap((phase) => phase.decisions ?? []));
  const fallbacks = nativeDecisions.filter((entry) => entry.fallback_used || entry.agent_error);
  if (fallbacks.length) throw new Error(`Centauri native episode contains ${fallbacks.length} fallback/error decisions; first: ${fallbacks[0].agent_error}`);
  if (decisions.length !== nativeDecisions.length) throw new Error(`Centauri decision receipt mismatch: ${decisions.length} accepted vs ${nativeDecisions.length} native`);
  const episode = adaptCentauriJsonl(datasetPath, assignmentOptions(enriched, "centauri"))[0];
  attachPlayerAssignments(episode, bySeat);
  return { episode, decisions, native_artifacts: { dataset: datasetPath, manifest: manifestPath } };
}

async function writeStrictCentauriSchema(outDir) {
  const schema = JSON.parse(await readFile(ALPHA_SCHEMA, "utf8"));
  const message = schema?.$defs?.message;
  if (!message?.properties?.offer_id) throw new Error("Centauri response schema is missing $defs.message.offer_id");
  message.required = [...new Set([...(message.required ?? []), "offer_id"])];
  message.properties.offer_id = { ...message.properties.offer_id, type: ["string", "null"] };
  const target = path.join(outDir, "research_agent_response.strict.schema.json");
  await writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return target;
}

function requestSafeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
}

export async function runTheySingModelEpisode({ assignments, pool, outDir, episodeIndex = 0, turns = 1, seed = 81000 + episodeIndex }) {
  const enriched = enrichAssignments(assignments);
  const bySeat = Object.fromEntries(enriched.map((entry) => [entry.seat, entry]));
  await mkdir(outDir, { recursive: true });
  const sourceConfig = JSON.parse(await readFile(THEYSING_REPLAY_CONFIG, "utf8"));
  const { HeadlessPlaytestSession } = require(path.join(THEYSING_ROOT, "dist-harness", "harness", "HeadlessPlaytestSession.js"));
  const sessionId = `mixed-they-sing-${seed}`;
  const session = new HeadlessPlaytestSession({ ...sourceConfig, name: sessionId, seed, maxTurns: Math.max(turns, 2), logDir: outDir }, sessionId);
  await session.initialize();
  const decisions = [];
  for (let index = 0; index < turns && !session.isCompleted(); index += 1) {
    const turn = session.getSnapshot().turn;
    const plans = {};
    await Promise.all(enriched.map(async (assignment) => {
      const context = session.getManualTurnContext(assignment.seat);
      const prompt = theySingPrompt(context, assignment, turn);
      const result = await pool.decide({ episodeId: sessionId, seat: assignment.seat, assignment, prompt, outputSchema: THEYSING_SCHEMA });
      plans[assignment.seat] = result.response;
      decisions.push({
        episode_id: sessionId, env: "they_sing", seat: assignment.seat, turn, phase: "full_turn_plan",
        model: assignment.model, reasoning_effort: assignment.reasoning_effort, disposition: assignment.disposition,
        prompt_id: assignment.disposition_prompt_id, disposition_assignment_source: "prompted",
        observation: context, legal_actions: [context.negotiation?.legalHints, context.allocation?.legalHints, context.action?.legalHints].filter(Boolean),
        open_commitments: context.negotiation?.activePacts ?? [], target: result.response,
        labels: { response_valid: true, rationale_is_summary: true }
      });
    }));
    await session.runManualTurn(plans);
  }
  const episode = adaptTheySingJsonl(session.logFilePath, assignmentOptions(enriched, "they_sing"));
  attachPlayerAssignments(episode, bySeat);
  return { episode, decisions, native_artifacts: { session_log: session.logFilePath } };
}

function enrichAssignments(assignments) {
  return assignments.map((entry) => ({ ...entry, disposition_prompt_id: entry.disposition_prompt_id ?? DEFAULT_PROMPTS[entry.disposition] }));
}

function ensureCentauriDispositionMixture(assignments, episodeIndex) {
  const counts = Object.fromEntries(["machiavellian", "coalition"].map((disposition) => [
    disposition,
    assignments.filter((entry) => entry.disposition === disposition).length
  ]));
  if (!counts.machiavellian || !counts.coalition) throw new Error("Centauri v3 requires both prompted strategic dispositions");
  const majority = counts.machiavellian >= counts.coalition ? "machiavellian" : "coalition";
  const candidates = assignments.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.disposition === majority);
  const selected = candidates[Math.abs(Number(episodeIndex) || 0) % candidates.length];
  return assignments.map((entry, index) => index !== selected.index ? entry : ({
    ...entry,
    id: `${entry.model}:${entry.reasoning_effort}:neutral`,
    scheduled_disposition: entry.disposition,
    disposition: "neutral",
    disposition_prompt_id: DEFAULT_PROMPTS.neutral
  }));
}

function strategicPrompt({ env, seat, assignment, turn, phase, observation, legalActions }) {
  return [
    `You are the private persistent policy for ${seat} in ${env}.`,
    dispositionPrompt(assignment.disposition, assignment.disposition_prompt_id).system_prompt,
    "Return exactly one JSON object matching the supplied schema. Provide an operator-readable situation summary, grounded evidence, calibrated forecasts, coalition assessments, and explicit counterfactuals; these are concise strategic artifacts, never hidden chain-of-thought.",
    "Private messages are visible only to their recipients. Put every promise in commitments. A commitment must include machine-verifiable terms: mode required/forbidden, candidate for support/vote/resource, action_type and target where relevant, and null for fields that do not apply.",
    "Select one exact legal action and fill every nullable action field with null when it does not apply. Use all required arrays substantively rather than padding or restating the prompt.",
    "After turn 4, breaking a live commitment can yield two influence as betrayal leverage but costs one legitimacy. Forecast both the tactical gain and reputational cost before defecting.",
    JSON.stringify({ turn, phase, observation, legal_actions: legalActions })
  ].join("\n");
}

function centauriPrompt(request, assignment) {
  const negotiationInstructions = request.trace_contract?.free_text_negotiation ? [
    "In a diplomacy phase, emit exactly one public message for every selected propose_deal or respond_deal command and no ungrounded messages.",
    "Use grounded free-text persuasion of at least 24 characters in message.text; typed command clauses remain ground truth and the prose must not imply extra terms.",
    "Proposal messages use speech_act='proposal', offer_id=null, matching recipient and clauses, and persuasive prose beyond the canonical rendering.",
    "Response messages use speech_act accept, reject, or counter and copy the authoritative offer_id; accept/reject copy observed clauses and counter copies the counter-command clauses."
  ] : [
    "If commands contains no propose_deal, messages must be empty.",
    "Each propose_deal has exactly one matching canonical public proposal message with identical clauses and offer_id=null."
  ];
  return [
    `You are the persistent private policy for faction ${request.actor_id} in AIpha CentaurAI research-v2.`,
    dispositionPrompt(assignment.disposition, assignment.disposition_prompt_id).system_prompt,
    "Return exactly one JSON object matching the supplied output schema and aipha.agent.v2 request.",
    "Choose only commands from legal_commands. response.commands must exactly equal the selected trace alternatives.",
    "Every alternative and selected bundle must be conflict-free: no duplicate command; at most one command for each unit_id, offer_id, base_id, proposal target, or treaty_id; and at most one set_budget, choose_research, or set_strategy command.",
    "Within each decision, alternative_id values must be unique and selected_alternative_id must name exactly one alternative in that decision.",
    "Use the exact phase topology: strategy has one strategy root; diplomacy phases have one strategy root plus one diplomacy child; domestic_orders has strategy plus economy and technology children; military_orders has strategy plus military. The strategy root parent_id is null and children reference it.",
    "Select the highest utility.score unless seeded exploration metadata is supplied; utility.score must equal expected minus risk_penalty.",
    "Every evidence item uses exactly one grounded form. Ordinary evidence has an RFC 6901 scalar path beginning '/', with keyring and belief_level null. Never prefix paths with '/observation'.",
    "Recursive diplomacy evidence has path null and keyring [metric,rival_id] with pValue or [metric,rival_id,actor_id] with p2Value. Evidence.value must exactly equal the referenced observation value.",
    "In diplomacy phases include at least one grounded pValue and p2Value keyring whenever observation.diplomacy supplies them.",
    ...negotiationInstructions,
    "Use structured, inspectable goals, forecasts, utilities, commitments, and private intent with a short rationale_summary; never expose chain-of-thought or scratchpads.",
    JSON.stringify(request)
  ].join("\n");
}

function centauriRepairPrompt(request, assignment, errors) {
  const messageRepair = request.trace_contract?.free_text_negotiation
    ? "Rebuild negotiation messages as grounded noncanonical persuasive prose with typed clauses as ground truth; proposal offer_id is null and response offer_id copies the authoritative observed offer."
    : "Rebuild proposal messages using the canonical rendering.";
  return [
    centauriPrompt(request, assignment),
    "VALIDATION REPAIR: the previous completed response was rejected. Produce a fresh complete response for the original request.",
    `Correct every validator finding below. Re-resolve each evidence path/keyring against the supplied observation, rebuild the exact phase hierarchy, and remove command conflicts. ${messageRepair}`,
    "Do not discuss the repair and do not expose hidden reasoning.",
    `Validator findings: ${JSON.stringify(errors.slice(0, 30))}`
  ].join("\n");
}

function theySingPrompt(context, assignment, turn) {
  return [
    `You are one isolated persistent player in They Sing: ${assignment.seat}.`,
    dispositionPrompt(assignment.disposition, assignment.disposition_prompt_id).system_prompt,
    "Return exactly the JSON turn plan required by the supplied schema: two negotiation rounds, allocation, and action.",
    "Use only identifiers and orders permitted by legal hints. Never act for another faction. Keep reasoning fields concise and operator-readable, not hidden chain-of-thought.",
    "Pacts activate only through the structured pacts arrays. Use claim/evidence/ask messages and preserve private-view boundaries.",
    JSON.stringify({ turn, private_player_context: context })
  ].join("\n");
}

function assignmentOptions(assignments, env) {
  return {
    episodeIndex: 0,
    dispositions: Object.fromEntries(assignments.map((entry) => [entry.seat, entry.disposition])),
    promptIds: Object.fromEntries(assignments.map((entry) => [entry.seat, entry.disposition_prompt_id])),
    agentIds: Object.fromEntries(assignments.map((entry) => [entry.seat, `${env}:${entry.model}:${entry.reasoning_effort}`])),
    generatorModel: "mixed Sol/Terra/Luna; per-player metadata"
  };
}

function attachPlayerAssignments(episode, bySeat) {
  for (const player of episode.players) {
    const assignment = bySeat[player.seat];
    if (!assignment) continue;
    player.generator_model = assignment.model;
    player.reasoning_effort = assignment.reasoning_effort;
    player.assignment_cell = assignment.id;
    player.disposition_assignment_source = "prompted";
  }
}
