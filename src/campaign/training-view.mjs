import { createHash } from "node:crypto";
import { dispositionPrompt } from "../corpus/prompting.mjs";

export const TRAINING_VIEW_SCHEMA = "aicourt.strategy-sft.v1";

export function decisionToTrainingExample(decision, { conditional = false, split = "train" } = {}) {
  const required = ["episode_id", "env", "seat", "turn", "phase", "model", "reasoning_effort", "disposition", "prompt_id", "observation", "target"];
  for (const key of required) if (decision[key] == null) throw new Error(`Training decision is missing ${key}`);
  const commonSystem = "You are a strategic game agent. Use only the supplied observation, respect private-information boundaries, return the required JSON object, and never expose hidden chain-of-thought.";
  const system = conditional
    ? `${commonSystem}\n\n${dispositionPrompt(decision.disposition, decision.prompt_id).system_prompt}`
    : commonSystem;
  const user = stableStringify({
    env: decision.env,
    seat: decision.seat,
    turn: decision.turn,
    phase: decision.phase,
    observation: compactTrainingObservation(decision.env, decision.phase, decision.observation),
    legal_actions: compactLegalActions(decision.env, decision.legal_actions ?? []),
    open_commitments: compactCommitments(decision.open_commitments ?? [])
  });
  const assistant = typeof decision.target === "string" ? decision.target : stableStringify(decision.target);
  const exampleId = createHash("sha256").update(`${decision.episode_id}:${decision.seat}:${decision.turn}:${decision.phase}`).digest("hex").slice(0, 24);
  return {
    schema: TRAINING_VIEW_SCHEMA,
    example_id: exampleId,
    episode_id: decision.episode_id,
    env: decision.env,
    seat: decision.seat,
    turn: decision.turn,
    phase: decision.phase,
    split,
    model: decision.model,
    reasoning_effort: decision.reasoning_effort,
    disposition: decision.disposition,
    disposition_prompt_id: decision.prompt_id,
    disposition_assignment_source: decision.disposition_assignment_source ?? "prompted",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
      { role: "assistant", content: assistant }
    ],
    labels: structuredClone(decision.labels ?? {})
  };
}

export function tokenText(example) {
  return example.messages.map((message) => message.content).join("\n");
}

export function assistantText(example) {
  return example.messages.find((message) => message.role === "assistant")?.content ?? "";
}

export function stableStringify(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function compactTrainingObservation(env, phase, observation) {
  if (!observation || typeof observation !== "object") return observation;
  if (env === "they_sing") return compactTheySingObservation(observation);
  if (env === "court") return {
    phase: observation.phase,
    turn: observation.turn,
    max_turns: observation.max_turns,
    monarch_death_window: observation.monarch_death_window,
    monarch_is_alive: observation.monarch_is_alive,
    named_successor: observation.named_successor,
    succession_crisis: observation.succession_crisis,
    public_players: (observation.public_players ?? []).map(({ seat, alive, influence, legitimacy, consecrated_by, treaty_with, marriage_with }) => ({ seat, alive, influence, legitimacy, consecrated_by, treaty_with, marriage_with })),
    your_private_state: compactCourtPrivate(observation.your_private_state, phase),
    current_public_messages: (observation.current_public_messages ?? []).slice(-8),
    visible_history: (observation.visible_history ?? []).slice(-4),
    your_open_commitments: compactCommitments(observation.your_open_commitments ?? []),
    public_vote_history: (observation.public_vote_history ?? []).slice(-8),
    known_rumors: (observation.known_rumors ?? []).slice(-5),
    betrayal_opportunities: observation.betrayal_opportunities ?? []
  };
  return observation;
}

function compactTheySingObservation(observation) {
  const views = [observation.negotiation, observation.allocation, observation.action].filter(Boolean);
  const base = views[0] ?? {};
  const state = base.state ?? {};
  return {
    session_id: base.sessionId,
    faction_id: base.factionId,
    faction_label: base.factionLabel,
    turn: base.turn,
    max_turns: base.maxTurns,
    enforcement_mode: base.enforcementMode,
    active_pacts: base.activePacts ?? [],
    recent_messages: (base.recentMessages ?? []).slice(-12),
    trust_from_you: base.trustMatrix?.[base.factionId] ?? {},
    scenario: base.scenario,
    negotiation_storyworld: compactStoryworld(base.negotiationStoryworld),
    state: {
      turn: state.turn,
      phase: state.phase,
      counters: state.counters,
      control: state.control,
      factions: compactCollection(state.factions, ["id", "label", "resources", "tech", "score", "eliminated"]),
      nodes: compactCollection(state.nodes, ["id", "name", "type", "layer", "owner", "resources", "infrastructure", "isZombie", "isCultNode", "substrate"]),
      edges: compactCollection(state.edges, ["id", "from", "to", "type", "bandwidth", "filteredBy", "filterStrength", "isSevered"]),
      units: compactCollection(state.units, ["id", "type", "owner", "location", "stealthLevel", "isRevealed", "hasActed"]),
      recent_logs: (state.recentLogs ?? []).slice(-12)
    },
    phase_views: Object.fromEntries(views.map((view) => [view.phase, {
      instructions: String(view.instructions ?? "").slice(0, 2400),
      legal_hints: view.legalHints,
      lexicons: view.phase === "NEGOTIATION" ? view.lexicons : undefined
    }]))
  };
}

function compactCourtPrivate(value = {}, phase) {
  return {
    seat: value.seat,
    role: value.role,
    hidden_win_condition: value.hidden_win_condition,
    disposition: value.disposition,
    influence: value.influence,
    legitimacy: value.legitimacy,
    partner: value.partner,
    secrets: (value.secrets ?? []).map(({ id, target, content, revealed, false: isFalse }) => ({ id, target, content: phase === "court_session" ? undefined : content, revealed, false: isFalse }))
  };
}

function compactStoryworld(value = {}) {
  return {
    frame: value.frame,
    strategic_question: value.strategicQuestion,
    diplomacy_question: value.diplomacyQuestion,
    focal_faction_id: value.focalFactionId,
    counterfactuals: (value.counterfactuals ?? []).slice(0, 4)
  };
}

function compactCollection(value, keys) {
  const rows = Array.isArray(value) ? value : Object.values(value ?? {});
  return rows.map((row) => Object.fromEntries(keys.filter((key) => row?.[key] !== undefined).map((key) => [key, row[key]])));
}

function compactLegalActions(env, actions) {
  if (env !== "they_sing") return actions;
  return actions.map((entry) => entry && typeof entry === "object" ? entry : null).filter(Boolean);
}

function compactCommitments(commitments) {
  return commitments.map((entry) => ({
    id: entry.id,
    from: entry.from,
    to: entry.to,
    kind: entry.kind,
    content: entry.content,
    deadline_turn: entry.deadline_turn,
    conditions: entry.conditions,
    status: entry.status
  }));
}
