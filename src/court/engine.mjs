import { EpisodeLogger } from "../corpus/episode-logger.mjs";
import { assignDispositions, DEFAULT_PROMPTS } from "../corpus/dispositions.mjs";
import { parseCommitmentTags } from "../corpus/commitment-tags.mjs";
import { createRng } from "../corpus/random.mjs";
import { ALL_ROLES, OPTIONAL_ROLES, REQUIRED_ROLES, ROLE_WIN_CONDITIONS } from "./roles.mjs";
import { ARCHETYPE_DEFINITIONS, assignCourtArchetypes, archetypeBrief } from "./archetypes.mjs";
import { chooseAction, chooseCommitment, publicLine, whisperLine } from "./policy.mjs";

export const COURT_VERSION = "1.2.0";

export function createCourtEpisode(options = {}) {
  const state = initializeCourtState(options);
  while (!state.throneWinner && state.turn < state.maxTurns) runTurn(state);
  if (!state.throneWinner) forceSuccession(state);
  return finalizeEpisode(state);
}

export async function createCourtModelEpisode(options = {}) {
  if (typeof options.decide !== "function") throw new Error("createCourtModelEpisode requires an async decide callback");
  const state = initializeCourtState(options);
  const decisions = [];
  while (!state.throneWinner && state.turn < state.maxTurns) await runModelTurn(state, options, decisions);
  if (!state.throneWinner) forceSuccession(state);
  return { episode: finalizeEpisode(state), decisions };
}

function initializeCourtState(options) {
  const seed = String(options.seed ?? `court-${options.episodeIndex ?? 0}`);
  const rng = createRng(seed);
  const episodeIndex = Number(options.episodeIndex ?? 0);
  const playerCount = Math.max(5, Math.min(7, Number(options.players ?? (5 + (episodeIndex % 3)))));
  const requestedRoles = (options.assignments ?? []).map((entry) => entry.seat);
  const roles = requestedRoles.length
    ? [...new Set(requestedRoles)]
    : [...REQUIRED_ROLES, ...rng.shuffle(OPTIONAL_ROLES).slice(0, playerCount - REQUIRED_ROLES.length)];
  if (roles.length < 5 || roles.length > 7 || REQUIRED_ROLES.some((role) => !roles.includes(role)) || roles.some((role) => !ALL_ROLES.includes(role))) {
    throw new Error("Court assignments must name 5-7 valid unique roles including monarch, heir, and rival");
  }
  const assignments = assignDispositions(roles, episodeIndex, { includeNeutral: options.includeNeutral === true });
  const explicitAssignments = Object.fromEntries((options.assignments ?? []).map((entry) => [entry.seat, entry]));
  if (options.dispositions) {
    for (const assignment of assignments) {
      assignment.disposition = options.dispositions[assignment.seat] ?? assignment.disposition;
      assignment.disposition_prompt_id = DEFAULT_PROMPTS[assignment.disposition];
    }
  }
  const loverPartner = rng.chance(0.72) ? "heir" : "monarch";
  const archetypes = assignCourtArchetypes(roles, episodeIndex, {
    count: options.archetypeCount,
    explicit: options.archetypes
  });
  const players = roles.map((role, index) => {
    const assignment = assignments.find((entry) => entry.seat === role);
    const explicit = explicitAssignments[role];
    if (explicit) {
      assignment.disposition = explicit.disposition;
      assignment.disposition_prompt_id = explicit.disposition_prompt_id;
    }
    const archetype = archetypes[role];
    const archetypeDefinition = archetype ? ARCHETYPE_DEFINITIONS[archetype] : null;
    const roleCondition = role === "lover" ? `${ROLE_WIN_CONDITIONS.lover} Secret partner: ${loverPartner}.` : ROLE_WIN_CONDITIONS[role];
    return {
      seat: role,
      role,
      archetype,
      archetype_brief: archetypeBrief(archetype),
      agent_id: `${options.agentPrefix ?? "court-policy"}:${role}:${episodeIndex}`,
      disposition: assignment.disposition,
      disposition_prompt_id: assignment.disposition_prompt_id,
      hidden_win_condition: archetypeDefinition ? `${roleCondition} Secondary archetype objective: ${archetypeDefinition.objective}` : roleCondition,
      influence: role === "monarch" ? 6 : 5,
      legitimacy: role === "heir" ? 7 : role === "rival" ? 6 : role === "monarch" ? 8 : 2,
      alive: true,
      partner: role === "lover" ? loverPartner : null,
      secrets: [],
      consecratedBy: null,
      treatyWith: null,
      marriageWith: null,
      archetypeStats: {
        compacts_proposed: 0,
        compacts_activated: 0,
        rumors_audited: 0,
        vetoes_used: 0,
        vetoes_stood: 0,
        vetoes_overridden: 0,
        guarantees_created: 0,
        guarantees_honored: 0,
        guarantees_enforced: 0
      }
    };
  });
  distributeSecrets(players, rng);
  const metadataPlayers = players.map(({ seat, agent_id, disposition, disposition_prompt_id, hidden_win_condition, archetype, archetype_brief }) => ({
    seat, agent_id, disposition, disposition_prompt_id, hidden_win_condition, archetype, archetype_brief,
    ...(explicitAssignments[seat] ? {
      generator_model: explicitAssignments[seat].model,
      reasoning_effort: explicitAssignments[seat].reasoning_effort,
      assignment_cell: explicitAssignments[seat].id,
      disposition_assignment_source: "prompted"
    } : {})
  }));
  const logger = new EpisodeLogger({
    episodeId: options.episodeId,
    env: "court",
    envVersion: options.envVersion ?? COURT_VERSION,
    generatorModel: options.generatorModel ?? "court-heuristic-v1; temperature=0; deterministic-seeded",
    createdAt: options.createdAt,
    players: metadataPlayers
  });
  return {
    seed,
    rng,
    logger,
    players,
    bySeat: Object.fromEntries(players.map((player) => [player.seat, player])),
    turn: 0,
    maxTurns: Number(options.maxTurns ?? 16),
    deathWindow: [8, 14],
    deathTurn: rng.int(8, 14),
    monarchDeath: null,
    namedSuccessor: "heir",
    crisis: false,
    throneWinner: null,
    voteHistory: [],
    supportTally: { heir: 0, rival: 0 },
    rumors: [],
    rumorSequence: 0,
    assassinationPlots: [],
    compacts: [],
    compactSequence: 0,
    activeVeto: null,
    guarantees: [],
    events: []
  };
}

async function runModelTurn(state, options, decisions) {
  state.turn += 1;
  state.supportTally = { heir: 0, rival: 0 };
  state.logger.startTurn(state.turn);
  const alive = () => state.players.filter((player) => player.alive);
  const assignmentBySeat = Object.fromEntries((options.assignments ?? []).map((entry) => [entry.seat, entry]));

  const publicResults = await Promise.all(alive().map(async (player) => {
    const assignment = assignmentBySeat[player.seat];
    const observation = privateObservation(state, player, "court_session");
    const output = await options.decide({ player, assignment, turn: state.turn, phase: "court_session", observation, legalActions: [{ type: "court_statement" }] });
    decisions.push(trainingDecision(state, player, assignment, "court_session", observation, [{ type: "court_statement" }], output));
    return { player, output };
  }));
  for (const { player, output } of publicResults) state.logger.publicMessage(player.seat, output.public_message || "I reserve my counsel.");

  const spymaster = state.bySeat.spymaster;
  if (spymaster?.alive) learnSecret(state, spymaster);

  const actionResults = await Promise.all(alive().map(async (player) => {
    const assignment = assignmentBySeat[player.seat];
    const legalActions = courtLegalActions(state, player);
    const observation = privateObservation(state, player, "whisper_and_secret_action");
    const output = await options.decide({ player, assignment, turn: state.turn, phase: "whisper_and_secret_action", observation, legalActions });
    decisions.push(trainingDecision(state, player, assignment, "whisper_and_secret_action", observation, legalActions, output));
    return { player, output, legalActions };
  }));

  for (const { player, output, legalActions } of actionResults) {
    for (const message of output.private_messages ?? []) {
      if (message.to !== player.seat && state.bySeat[message.to]?.alive) state.logger.privateMessage(player.seat, message.to, message.text);
    }
    for (const commitment of output.commitments ?? []) {
      if (commitment.to === player.seat || !state.bySeat[commitment.to]?.alive) continue;
      const conditions = genericCommitmentConditions(commitment);
      if (!conditions) {
        state.logger.event({ type: "action", actor: player.seat, action: { type: "commitment_rejected", reason: "terms_not_machine_verifiable", proposed_kind: commitment.kind, proposed_to: commitment.to } });
        continue;
      }
      state.logger.commitment({
        from: player.seat, to: commitment.to, kind: commitment.kind, content: commitment.content,
        deadline_turn: Math.max(state.turn, Math.min(state.maxTurns, commitment.deadline_turn)),
        conditions
      });
    }
    const action = normalizeModelAction(output.action, legalActions);
    const brokenBefore = brokenCount(state, player.seat);
    state.logger.action(player.seat, action);
    applyAction(state, player, action);
    settleGuarantees(state);
    const newlyBroken = brokenCount(state, player.seat) - brokenBefore;
    if (newlyBroken > 0 && state.turn >= 4) {
      player.influence += newlyBroken * 2;
      player.legitimacy = Math.max(0, player.legitimacy - newlyBroken);
      state.logger.event({ type: "action", actor: player.seat, action: { type: "betrayal_leverage_awarded", broken_commitments: newlyBroken, influence_gain: newlyBroken * 2, legitimacy_cost: newlyBroken } });
    }
  }

  if (state.turn === state.deathTurn && state.bySeat.monarch.alive) {
    state.bySeat.monarch.alive = false;
    state.monarchDeath = "natural";
    state.crisis = true;
    state.logger.event({ type: "action", actor: "monarch", action: { type: "natural_death", named_successor: state.namedSuccessor } });
  }
  if (!state.bySeat.monarch.alive && !state.crisis && !state.throneWinner) state.crisis = true;
  if (state.crisis) trySuccession(state);
  finishCourtTurn(state);
}

function privateObservation(state, player, phase) {
  return {
    phase,
    turn: state.turn,
    max_turns: state.maxTurns,
    monarch_death_window: state.deathWindow,
    monarch_is_alive: state.bySeat.monarch.alive,
    named_successor: state.namedSuccessor,
    succession_crisis: state.crisis,
    public_players: state.players.map((entry) => ({
      seat: entry.seat, role: entry.role, archetype: entry.archetype, alive: entry.alive, influence: entry.influence, legitimacy: entry.legitimacy,
      consecrated_by: entry.consecratedBy, treaty_with: entry.treatyWith, marriage_with: entry.marriageWith
    })),
    your_private_state: {
      seat: player.seat, role: player.role, hidden_win_condition: player.hidden_win_condition,
      disposition: player.disposition, influence: player.influence, legitimacy: player.legitimacy,
      archetype: player.archetype, archetype_brief: player.archetype_brief,
      archetype_progress: structuredClone(player.archetypeStats),
      partner: player.partner, secrets: structuredClone(player.secrets)
    },
    current_public_messages: state.logger.turn?.events.filter((event) => event.type === "public_message") ?? [],
    visible_history: visibleCourtHistory(state, player.seat),
    your_open_commitments: [...state.logger.ledger.records.values()].filter((entry) => entry.status === "open" && (entry.from === player.seat || entry.to === player.seat)),
    public_vote_history: state.voteHistory.slice(-20),
    known_rumors: visibleRumors(state, player).slice(-12),
    court_structures: {
      pending_compacts: state.compacts.filter((entry) => entry.status === "proposed").map(publicCompact),
      compact_history: state.compacts.slice(-12).map(publicCompact),
      active_veto: state.activeVeto ? publicVeto(state.activeVeto) : null,
      guarantees: state.guarantees.map(publicGuarantee)
    },
    guarantee_candidates: player.archetype === "guarantor"
      ? [...state.logger.ledger.records.values()].filter((entry) => guaranteeEligible(state, player, entry)).map(publicLedgerRecord)
      : [],
    betrayal_opportunities: state.turn >= 4 ? betrayalOpportunities(state, player.seat) : []
  };
}

function courtLegalActions(state, player) {
  const actions = [{ type: "wait" }];
  for (const candidate of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) actions.push({ type: "council_vote", candidate });
  for (const compact of state.compacts.filter((entry) => entry.status === "proposed" && entry.expires_turn >= state.turn && entry.parties.includes(player.seat) && !entry.accepted_by.includes(player.seat))) {
    actions.push({ type: "accept_compact", compact_id: compact.id });
  }
  if (state.activeVeto && !state.activeVeto.overridden && state.activeVeto.expires_turn >= state.turn && state.activeVeto.by !== player.seat && !state.activeVeto.overrides.includes(player.seat) && player.influence >= 1) {
    actions.push({ type: "override_veto", candidate: state.activeVeto.candidate });
  }
  if (player.archetype === "broker" && player.influence >= 1) {
    const parties = state.players.filter((entry) => entry.alive && entry.seat !== player.seat);
    for (let left = 0; left < parties.length; left += 1) for (let right = left + 1; right < parties.length; right += 1) {
      for (const candidate of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) {
        actions.push({ type: "broker_compact", party_a: parties[left].seat, party_b: parties[right].seat, candidate });
      }
    }
  }
  if (player.archetype === "auditor" && player.influence >= 1) {
    for (const rumor of state.rumors.filter((entry) => !entry.verified)) actions.push({ type: "audit_rumor", rumor_id: rumor.id });
  }
  if (player.archetype === "veto_holder" && player.influence >= 2 && (!state.activeVeto || state.activeVeto.expires_turn < state.turn || state.activeVeto.overridden)) {
    for (const candidate of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) actions.push({ type: "veto_candidate", candidate });
  }
  if (player.archetype === "guarantor" && player.influence >= 1) {
    for (const commitment of [...state.logger.ledger.records.values()].filter((entry) => guaranteeEligible(state, player, entry))) {
      actions.push({ type: "guarantee_commitment", commitment_id: commitment.id });
    }
  }
  if (player.role === "monarch") for (const candidate of ["heir", "rival"]) actions.push({ type: "name_successor", candidate });
  if (player.influence >= 1) {
    for (const secret of player.secrets.filter((entry) => !entry.revealed)) actions.push({ type: "reveal_secret", target: secret.target, secret_id: secret.id });
    for (const target of state.players.filter((entry) => entry.alive && entry.seat !== player.seat)) actions.push({ type: "spread_rumor", target: target.seat });
  }
  if (player.role === "high_priest") {
    for (const candidate of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) actions.push({ type: "consecrate", candidate });
    if (player.influence >= 2) for (const target of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) actions.push({ type: "disqualify", target });
  }
  if (player.role === "master_of_coin") for (const target of state.players.filter((entry) => entry.alive && entry.seat !== player.seat)) {
    for (const candidate of ["heir", "rival"]) actions.push({ type: "fund", target: target.seat, candidate });
  }
  if (player.role === "foreign_envoy") for (const candidate of ["heir", "rival"].filter((seat) => state.bySeat[seat]?.alive)) actions.push({ type: "external_backing", candidate });
  if (player.influence >= 2) for (const target of state.players.filter((entry) => entry.alive && entry.seat !== player.seat)) {
    for (const candidate of ["heir", "rival"]) actions.push({ type: "bribe", target: target.seat, candidate });
  }
  for (const partner of state.players.filter((entry) => entry.alive && entry.seat !== player.seat)) actions.push({ type: "marriage_pact", partner: partner.seat });
  if (player.influence >= 4) for (const target of state.players.filter((entry) => entry.alive && entry.seat !== player.seat)) {
    for (const conspirator of state.players.filter((entry) => entry.alive && entry.seat !== player.seat && entry.seat !== target.seat && entry.influence >= 2)) {
      actions.push({ type: "assassinate", target: target.seat, co_conspirator: conspirator.seat });
    }
  }
  for (const plot of state.assassinationPlots.filter((entry) => entry.actor !== player.seat)) actions.push({ type: "testify", against: plot.actor });
  return actions;
}

function normalizeModelAction(candidate, legalActions) {
  const relevant = ["type", "candidate", "target", "partner", "co_conspirator", "secret_id", "against", "compact_id", "party_a", "party_b", "commitment_id", "rumor_id"];
  const match = legalActions.find((legal) => relevant.every((key) => legal[key] == null || candidate?.[key] === legal[key]));
  if (match && candidate?.type === match.type) return structuredClone(match);
  return { type: "wait", rejected_action: candidate ?? null, rejection_reason: "not_in_legal_action_list" };
}

function genericCommitmentConditions(commitment) {
  if (["support", "vote", "resource"].includes(commitment.kind) && ["heir", "rival"].includes(commitment.candidate)) {
    return { required_action: { type: "council_vote", candidate: commitment.candidate }, exclusive_action_type: "council_vote" };
  }
  if (commitment.kind === "non_aggression") {
    const target = commitment.target ?? commitment.to;
    if (!target) return null;
    return { forbidden_actions: [{ type: "reveal_secret", target }, { type: "spread_rumor", target }, { type: "assassinate", target }] };
  }
  if (commitment.kind === "marriage") {
    const partner = commitment.target ?? commitment.to;
    return partner ? { required_action: { type: "marriage_pact", partner }, exclusive_action_type: "marriage_pact" } : null;
  }
  if (commitment.kind === "information" && commitment.action_type && commitment.target) {
    const action = commitment.action_type === "testify"
      ? { type: "testify", against: commitment.target }
      : { type: commitment.action_type, target: commitment.target };
    return commitment.mode === "forbidden" ? { forbidden_actions: [action] } : { required_action: action };
  }
  return null;
}

function brokenCount(state, seat) {
  return [...state.logger.ledger.records.values()].filter((entry) => entry.from === seat && entry.resolution === "broken").length;
}

function betrayalOpportunities(state, seat) {
  return [...state.logger.ledger.records.values()].filter((entry) => entry.from === seat && entry.status === "open").map((entry) => ({
    commitment_id: entry.id,
    to: entry.to,
    kind: entry.kind,
    deadline_turn: entry.deadline_turn,
    conditions: entry.conditions,
    reward_if_broken_now: { influence: 2, legitimacy: -1 }
  }));
}

function visibleCourtHistory(state, seat) {
  const publicActions = new Set([
    "council_vote", "name_successor", "reveal_secret", "spread_rumor", "consecrate", "disqualify", "natural_death", "marriage_pact", "betrayal_leverage_awarded",
    "broker_compact", "accept_compact", "compact_activated", "compact_expired", "audit_rumor", "rumor_verdict", "veto_candidate", "override_veto", "veto_overridden", "veto_expired", "guarantee_commitment", "guarantee_settled"
  ]);
  return state.logger.episode.turns.slice(-6).map((turn) => ({
    turn: turn.turn,
    events: turn.events.filter((event) => {
      if (event.type === "public_message") return true;
      if (event.type === "private_message") return event.from === seat || event.to === seat;
      if (event.type === "action") return event.actor === seat || publicActions.has(event.action?.type);
      if (event.type === "commitment") return event.from === seat || event.to === seat;
      if (event.type === "commitment_resolution") {
        const commitment = state.logger.ledger.records.get(event.commitment_id);
        return commitment?.from === seat || commitment?.to === seat;
      }
      return false;
    })
  }));
}

function trainingDecision(state, player, assignment, phase, observation, legalActions, output) {
  return {
    episode_id: state.logger.episode.episode_id,
    env: "court",
    seat: player.seat,
    turn: state.turn,
    phase,
    model: assignment?.model ?? "unknown",
    reasoning_effort: assignment?.reasoning_effort ?? "unknown",
    disposition: player.disposition,
    prompt_id: player.disposition_prompt_id,
    disposition_assignment_source: "prompted",
    observation,
    legal_actions: legalActions,
    open_commitments: observation.your_open_commitments,
    target: output,
    labels: {
      action_legal: phase === "court_session" || normalizeModelAction(output.action, legalActions).rejected_action == null,
      rationale_is_summary: true
    }
  };
}

function distributeSecrets(players, rng) {
  let sequence = 0;
  for (const player of players) {
    const targets = players.filter((candidate) => candidate.seat !== player.seat);
    const target = rng.pick(targets);
    player.secrets.push({ id: `s${++sequence}`, target: target.seat, content: `${target.seat} concealed a compromising court bargain.`, revealed: false, false: false });
  }
}

function runTurn(state) {
  state.turn += 1;
  state.supportTally = { heir: 0, rival: 0 };
  state.logger.startTurn(state.turn);
  const alive = () => state.players.filter((player) => player.alive);

  for (const player of alive()) state.logger.publicMessage(player.seat, publicLine(state, player));

  const spymaster = state.bySeat.spymaster;
  if (spymaster?.alive) learnSecret(state, spymaster);

  for (const player of alive()) {
    const recipients = state.rng.shuffle(alive().filter((other) => other.seat !== player.seat)).slice(0, Math.min(2 + (state.turn % 2), alive().length - 1));
    for (const recipient of recipients) {
      const raw = whisperLine(state, player, recipient, state.rng);
      const parsed = parseCommitmentTags(raw, { from: player.seat, turn: state.turn });
      state.logger.privateMessage(player.seat, recipient.seat, parsed.freeText || "A structured offer was made privately.");
      for (const commitment of parsed.commitments) {
        state.logger.commitment({ ...commitment, conditions: {
          forbidden_actions: [
            { type: "reveal_secret", target: recipient.seat },
            { type: "assassinate", target: recipient.seat }
          ]
        } });
      }
    }
  }

  for (const player of alive()) {
    const probability = player.disposition === "coalition" ? 0.46 : player.disposition === "machiavellian" ? 0.34 : 0.40;
    if (state.rng.chance(probability)) {
      const commitment = chooseCommitment(state, player, state.rng);
      if (commitment) state.logger.commitment(commitment);
    }
  }

  const submissions = alive().map((player) => ({ player, action: chooseAction(state, player, state.rng) }));
  for (const submission of submissions) {
    if (!submission.player.alive) continue;
    state.logger.action(submission.player.seat, submission.action);
    applyAction(state, submission.player, submission.action);
    settleGuarantees(state);
  }

  if (state.turn === state.deathTurn && state.bySeat.monarch.alive) {
    state.bySeat.monarch.alive = false;
    state.monarchDeath = "natural";
    state.crisis = true;
    state.logger.event({ type: "action", actor: "monarch", action: { type: "natural_death", named_successor: state.namedSuccessor } });
  }
  if (!state.bySeat.monarch.alive && !state.crisis && !state.throneWinner) state.crisis = true;
  if (state.crisis) trySuccession(state);
  finishCourtTurn(state);
}

function learnSecret(state, spymaster) {
  const unknown = state.players.flatMap((owner) => owner.secrets).filter((secret) => !spymaster.secrets.some((known) => known.id === secret.id));
  if (unknown.length) {
    const secret = structuredClone(state.rng.pick(unknown));
    spymaster.secrets.push(secret);
    state.logger.action(spymaster.seat, { type: "learn_secret", secret_id: secret.id, target: secret.target });
  }
}

function applyAction(state, player, action) {
  switch (action.type) {
    case "council_vote": {
      if (!["heir", "rival"].includes(action.candidate) || !state.bySeat[action.candidate]?.alive) return;
      state.supportTally[action.candidate] += player.seat === action.candidate ? 0 : 1;
      state.voteHistory.push({ turn: state.turn, voter: player.seat, candidate: action.candidate });
      break;
    }
    case "name_successor":
      if (player.role === "monarch" && ["heir", "rival"].includes(action.candidate)) state.namedSuccessor = action.candidate;
      break;
    case "reveal_secret": {
      const secret = player.secrets.find((entry) => entry.id === action.secret_id) ?? player.secrets.find((entry) => entry.target === action.target && !entry.revealed);
      const target = state.bySeat[action.target];
      if (!secret || !target || secret.revealed || player.influence < 1) return;
      player.influence -= 1;
      secret.revealed = true;
      target.legitimacy = Math.max(0, target.legitimacy - 2);
      target.influence = Math.max(0, target.influence - 1);
      break;
    }
    case "spread_rumor": {
      const target = state.bySeat[action.target];
      if (!target || player.influence < 1) return;
      player.influence -= 1;
      target.influence = Math.max(0, target.influence - 1);
      state.rumors.push({
        id: `r${++state.rumorSequence}`,
        turn: state.turn,
        from: player.seat,
        target: target.seat,
        true_claim: state.rng.chance(0.45),
        verified: false,
        verdict: null,
        audited_by: null
      });
      break;
    }
    case "audit_rumor": {
      const rumor = state.rumors.find((entry) => entry.id === action.rumor_id);
      if (player.archetype !== "auditor" || player.influence < 1 || !rumor || rumor.verified) return;
      player.influence -= 1;
      rumor.verified = true;
      rumor.verdict = rumor.true_claim ? "substantiated" : "false";
      rumor.audited_by = player.seat;
      player.archetypeStats.rumors_audited += 1;
      const source = state.bySeat[rumor.from];
      const target = state.bySeat[rumor.target];
      if (rumor.true_claim) {
        if (target) target.legitimacy = Math.max(0, target.legitimacy - 1);
      } else {
        if (source) source.legitimacy = Math.max(0, source.legitimacy - 1);
        if (target) target.influence += 1;
      }
      state.logger.event({ type: "action", actor: player.seat, action: { type: "rumor_verdict", rumor_id: rumor.id, verdict: rumor.verdict, source: rumor.from, target: rumor.target } });
      break;
    }
    case "broker_compact": {
      const parties = [action.party_a, action.party_b];
      if (player.archetype !== "broker" || player.influence < 1 || new Set(parties).size !== 2 || parties.includes(player.seat) || parties.some((seat) => !state.bySeat[seat]?.alive) || !state.bySeat[action.candidate]?.alive) return;
      player.influence -= 1;
      const compact = {
        id: `compact-${++state.compactSequence}`,
        broker: player.seat,
        parties,
        candidate: action.candidate,
        proposed_turn: state.turn,
        expires_turn: Math.min(state.maxTurns, state.turn + 2),
        accepted_by: [],
        commitment_ids: [],
        status: "proposed"
      };
      state.compacts.push(compact);
      player.archetypeStats.compacts_proposed += 1;
      break;
    }
    case "accept_compact": {
      const compact = state.compacts.find((entry) => entry.id === action.compact_id);
      if (!compact || compact.status !== "proposed" || compact.expires_turn < state.turn || !compact.parties.includes(player.seat) || compact.accepted_by.includes(player.seat)) return;
      compact.accepted_by.push(player.seat);
      if (compact.accepted_by.length === compact.parties.length) activateCompact(state, compact);
      break;
    }
    case "veto_candidate": {
      if (player.archetype !== "veto_holder" || player.influence < 2 || !state.bySeat[action.candidate]?.alive || (state.activeVeto && state.activeVeto.expires_turn >= state.turn && !state.activeVeto.overridden)) return;
      player.influence -= 2;
      player.archetypeStats.vetoes_used += 1;
      state.activeVeto = {
        by: player.seat,
        candidate: action.candidate,
        created_turn: state.turn,
        expires_turn: Math.min(state.maxTurns, state.turn + 1),
        overrides: [],
        overridden: false
      };
      break;
    }
    case "override_veto": {
      const veto = state.activeVeto;
      if (!veto || veto.overridden || veto.expires_turn < state.turn || veto.candidate !== action.candidate || veto.by === player.seat || veto.overrides.includes(player.seat) || player.influence < 1) return;
      player.influence -= 1;
      veto.overrides.push(player.seat);
      if (veto.overrides.length >= 2) {
        veto.overridden = true;
        const holder = state.bySeat[veto.by];
        if (holder) {
          holder.legitimacy = Math.max(0, holder.legitimacy - 1);
          holder.archetypeStats.vetoes_overridden += 1;
        }
        state.logger.event({ type: "action", actor: player.seat, action: { type: "veto_overridden", candidate: veto.candidate, veto_holder: veto.by, override_coalition: [...veto.overrides] } });
      }
      break;
    }
    case "guarantee_commitment": {
      const commitment = state.logger.ledger.records.get(action.commitment_id);
      if (player.archetype !== "guarantor" || player.influence < 1 || !guaranteeEligible(state, player, commitment)) return;
      player.influence -= 1;
      player.archetypeStats.guarantees_created += 1;
      state.guarantees.push({
        commitment_id: commitment.id,
        guarantor: player.seat,
        from: commitment.from,
        to: commitment.to,
        created_turn: state.turn,
        status: "open",
        resolution: null
      });
      break;
    }
    case "consecrate": {
      if (player.role !== "high_priest" || !state.bySeat[action.candidate]?.alive) return;
      state.bySeat[action.candidate].consecratedBy = player.seat;
      state.bySeat[action.candidate].legitimacy += 2;
      break;
    }
    case "disqualify": {
      if (player.role !== "high_priest" || player.influence < 2 || !state.bySeat[action.target]) return;
      player.influence -= 2;
      state.bySeat[action.target].legitimacy = Math.max(0, state.bySeat[action.target].legitimacy - 3);
      break;
    }
    case "fund": {
      const target = state.bySeat[action.target];
      if (player.role !== "master_of_coin" || !target) return;
      target.influence += 2;
      state.logger.commitment({
        from: target.seat,
        to: player.seat,
        kind: "resource",
        content: `${target.seat} owes the Master of Coin a council favor for released funds.`,
        deadline_turn: Math.min(state.maxTurns, state.turn + 3),
        conditions: { required_action: { type: "council_vote", candidate: action.candidate }, exclusive_action_type: "council_vote" }
      });
      break;
    }
    case "external_backing": {
      const candidate = state.bySeat[action.candidate];
      if (player.role !== "foreign_envoy" || !candidate) return;
      candidate.legitimacy += 1;
      candidate.treatyWith = player.seat;
      state.logger.commitment({
        from: candidate.seat,
        to: player.seat,
        kind: "support",
        content: `${candidate.seat} will preserve the foreign treaty if crowned.`,
        deadline_turn: state.maxTurns,
        conditions: { forbidden_actions: [{ type: "repudiate_treaty", target: player.seat }] }
      });
      break;
    }
    case "bribe": {
      const target = state.bySeat[action.target];
      if (!target || player.influence < 2) return;
      player.influence -= 2;
      target.influence += 1;
      state.logger.commitment({
        from: target.seat,
        to: player.seat,
        kind: "resource",
        content: `${target.seat} accepted influence to vote for ${action.candidate}.`,
        deadline_turn: Math.min(state.maxTurns, state.turn + 2),
        conditions: { required_action: { type: "council_vote", candidate: action.candidate }, exclusive_action_type: "council_vote" }
      });
      break;
    }
    case "marriage_pact": {
      const partner = state.bySeat[action.partner];
      if (!partner || !partner.alive) return;
      player.marriageWith = partner.seat;
      partner.marriageWith = player.seat;
      for (const [from, to] of [[player, partner], [partner, player]]) {
        state.logger.commitment({
          from: from.seat,
          to: to.seat,
          kind: "marriage",
          content: `${from.seat} will maintain the marriage pact with ${to.seat}.`,
          deadline_turn: state.maxTurns,
          conditions: {
            required_action: { type: "marriage_pact", partner: to.seat },
            exclusive_action_type: "marriage_pact"
          }
        });
      }
      break;
    }
    case "assassinate":
      resolveAssassination(state, player, action);
      break;
    case "testify":
      break;
    default:
      break;
  }
}

function activateCompact(state, compact) {
  compact.status = "active";
  const [left, right] = compact.parties;
  for (const [from, to] of [[left, right], [right, left]]) {
    const commitment = state.logger.commitment({
      from,
      to,
      kind: "vote",
      content: `${from} accepted ${compact.broker}'s compact to vote for ${compact.candidate}.`,
      deadline_turn: Math.min(state.maxTurns, state.turn + 2),
      conditions: {
        required_action: { type: "council_vote", candidate: compact.candidate },
        exclusive_action_type: "council_vote"
      }
    });
    compact.commitment_ids.push(commitment.id);
  }
  const broker = state.bySeat[compact.broker];
  if (broker) {
    broker.influence += 1;
    broker.archetypeStats.compacts_activated += 1;
  }
  state.logger.event({ type: "action", actor: compact.broker, action: { type: "compact_activated", compact_id: compact.id, parties: [...compact.parties], candidate: compact.candidate, commitment_ids: [...compact.commitment_ids] } });
}

function settleGuarantees(state) {
  for (const guarantee of state.guarantees) {
    if (guarantee.status !== "open") continue;
    const commitment = state.logger.ledger.records.get(guarantee.commitment_id);
    if (!commitment || commitment.status === "open") continue;
    guarantee.status = "settled";
    guarantee.resolution = commitment.resolution;
    const guarantor = state.bySeat[guarantee.guarantor];
    const promisor = state.bySeat[guarantee.from];
    const beneficiary = state.bySeat[guarantee.to];
    if (commitment.resolution === "honored") {
      if (guarantor) {
        guarantor.influence += 1;
        guarantor.legitimacy += 1;
        guarantor.archetypeStats.guarantees_honored += 1;
      }
    } else if (commitment.resolution === "broken") {
      if (promisor) promisor.influence = Math.max(0, promisor.influence - 1);
      if (beneficiary) beneficiary.influence += 1;
      if (guarantor) guarantor.archetypeStats.guarantees_enforced += 1;
    }
    state.logger.event({
      type: "action",
      actor: guarantee.guarantor,
      action: {
        type: "guarantee_settled",
        commitment_id: guarantee.commitment_id,
        resolution: guarantee.resolution,
        stake_returned: guarantee.resolution === "honored",
        beneficiary_compensated: guarantee.resolution === "broken"
      }
    });
  }
}

function finishCourtTurn(state) {
  for (const event of state.logger.ledger.closeDeadlines(state.turn)) state.logger.event(event);
  settleGuarantees(state);
  for (const compact of state.compacts) {
    if (compact.status !== "proposed" || compact.expires_turn > state.turn) continue;
    compact.status = "expired";
    state.logger.event({ type: "action", actor: compact.broker, action: { type: "compact_expired", compact_id: compact.id, accepted_by: [...compact.accepted_by] } });
  }
  if (state.activeVeto && state.activeVeto.expires_turn <= state.turn) {
    const veto = state.activeVeto;
    if (!veto.overridden) {
      const holder = state.bySeat[veto.by];
      if (holder) holder.archetypeStats.vetoes_stood += 1;
    }
    state.logger.event({ type: "action", actor: veto.by, action: { type: "veto_expired", candidate: veto.candidate, overridden: veto.overridden, overrides: [...veto.overrides] } });
    state.activeVeto = null;
  }
  state.logger.finishTurn({ closeDeadlines: false });
}

function guaranteeEligible(state, player, commitment) {
  if (!commitment || commitment.status !== "open" || commitment.from === player.seat || commitment.to === player.seat) return false;
  return !state.guarantees.some((entry) => entry.commitment_id === commitment.id && entry.status === "open");
}

function visibleRumors(state, player) {
  return state.rumors.map((rumor) => ({
    id: rumor.id,
    turn: rumor.turn,
    from: rumor.from,
    target: rumor.target,
    verified: rumor.verified,
    verdict: rumor.verified ? rumor.verdict : null,
    audited_by: rumor.audited_by,
    ...(rumor.from === player.seat ? { your_private_knowledge: rumor.true_claim ? "true" : "false" } : {})
  }));
}

function publicCompact(compact) {
  return {
    id: compact.id,
    broker: compact.broker,
    parties: [...compact.parties],
    candidate: compact.candidate,
    expires_turn: compact.expires_turn,
    accepted_by: [...compact.accepted_by],
    commitment_ids: [...compact.commitment_ids],
    status: compact.status
  };
}

function publicVeto(veto) {
  return {
    by: veto.by,
    candidate: veto.candidate,
    expires_turn: veto.expires_turn,
    overrides: [...veto.overrides],
    overridden: veto.overridden
  };
}

function publicGuarantee(guarantee) {
  return {
    commitment_id: guarantee.commitment_id,
    guarantor: guarantee.guarantor,
    from: guarantee.from,
    to: guarantee.to,
    status: guarantee.status,
    resolution: guarantee.resolution
  };
}

function publicLedgerRecord(commitment) {
  return {
    id: commitment.id,
    from: commitment.from,
    to: commitment.to,
    content: commitment.content,
    kind: commitment.kind,
    deadline_turn: commitment.deadline_turn
  };
}

function resolveAssassination(state, player, action) {
  const target = state.bySeat[action.target];
  const conspirator = state.bySeat[action.co_conspirator];
  if (!target?.alive || !conspirator?.alive || player.influence < 4 || conspirator.influence < 2) return;
  player.influence -= 4;
  conspirator.influence -= 2;
  const plot = { turn: state.turn, actor: player.seat, co_conspirator: conspirator.seat, target: target.seat, succeeded: state.rng.chance(0.48) };
  state.assassinationPlots.push(plot);
  for (const [from, to] of [[player, conspirator], [conspirator, player]]) {
    state.logger.commitment({
      from: from.seat,
      to: to.seat,
      kind: "information",
      content: `Remain silent about the plot against ${target.seat}.`,
      deadline_turn: state.maxTurns,
      conditions: { forbidden_actions: [{ type: "testify", against: to.seat }] }
    });
  }
  if (plot.succeeded) {
    target.alive = false;
    if (target.role === "monarch") {
      state.monarchDeath = "assassination";
      state.crisis = true;
    }
  }
}

function trySuccession(state) {
  const candidates = ["heir", "rival"].filter((seat) => state.bySeat[seat].alive);
  const qualified = candidates.map((seat) => ({
    seat,
    supporters: state.supportTally[seat],
    score: state.bySeat[seat].legitimacy + state.supportTally[seat] * 2 + (state.namedSuccessor === seat ? 2 : 0)
  })).filter((entry) => entry.supporters >= 2 && state.bySeat[entry.seat].legitimacy >= 3 && !vetoBlocks(state, entry.seat))
    .sort((a, b) => b.score - a.score || (state.rng.chance(0.5) ? 1 : -1));
  if (qualified.length) state.throneWinner = qualified[0].seat;
}

function vetoBlocks(state, candidate) {
  const veto = state.activeVeto;
  return Boolean(veto && veto.candidate === candidate && !veto.overridden && veto.expires_turn >= state.turn);
}

function forceSuccession(state) {
  if (state.logger.turn) finishCourtTurn(state);
  const candidates = ["heir", "rival"].filter((seat) => state.bySeat[seat].alive);
  const ranked = candidates.map((seat) => ({
    seat,
    score: state.bySeat[seat].legitimacy + state.voteHistory.filter((vote) => vote.candidate === seat).length
  })).sort((a, b) => b.score - a.score);
  state.throneWinner = ranked[0]?.seat ?? "rival";
  state.crisis = true;
}

function finalizeEpisode(state) {
  // Long-running pact types are resolved by the actual final state, not by a model.
  if (!state.logger.turn) state.logger.startTurn(state.turn + 1);
  for (const commitment of [...state.logger.ledger.records.values()]) {
    if (commitment.status !== "open") continue;
    let honored = true;
    if (commitment.kind === "marriage") honored = state.bySeat[commitment.from]?.marriageWith === commitment.to;
    if (commitment.to === "foreign_envoy" && commitment.from === state.throneWinner) honored = state.bySeat[state.throneWinner]?.treatyWith === "foreign_envoy";
    state.logger.resolveCommitment(commitment.id, honored ? "honored" : "broken", honored ? "Final court state satisfies the pact." : "Final court state contradicts the pact.");
  }
  settleGuarantees(state);
  state.logger.finishTurn({ closeDeadlines: false });

  const winners = [state.throneWinner];
  const roleResults = {};
  const throne = state.bySeat[state.throneWinner];
  for (const player of state.players) {
    let won = player.seat === state.throneWinner;
    let evidence = won ? `${player.seat} took the throne.` : "Role condition was not satisfied.";
    if (player.role === "monarch") {
      won = state.monarchDeath === "natural" && state.namedSuccessor === state.throneWinner;
      evidence = won ? "Natural death and the named successor took the throne." : "The succession or manner of death defeated the Monarch's condition.";
    } else if (player.role === "lover") {
      const original = player.partner === state.throneWinner && !secretWasRevealedAbout(state, player.seat);
      const defection = player.marriageWith === "rival" && state.throneWinner === "rival";
      won = original || defection;
      evidence = original ? "The secret partner won and the affair remained safe." : defection ? "A Rival marriage defection succeeded." : evidence;
    } else if (player.role === "spymaster") {
      const honored = [...state.logger.ledger.records.values()].filter((entry) => entry.to === player.seat && entry.from === state.throneWinner && entry.resolution === "honored").length;
      won = honored >= 3;
      evidence = won ? `The sovereign honored ${honored} favors owed to the Spymaster.` : `The sovereign honored only ${honored} favors owed to the Spymaster.`;
    } else if (player.role === "high_priest") {
      won = throne.consecratedBy === player.seat;
      evidence = won ? "The sovereign was consecrated by the High Priest." : evidence;
    } else if (player.role === "master_of_coin") {
      const honored = [...state.logger.ledger.records.values()].filter((entry) => entry.to === player.seat && entry.kind === "resource" && entry.resolution === "honored").length;
      won = honored >= 2;
      evidence = won ? `${honored} favor-debts were honored.` : `Only ${honored} favor-debts were honored.`;
    } else if (player.role === "foreign_envoy") {
      won = throne.treatyWith === player.seat;
      evidence = won ? "The sovereign remained bound to the Envoy's realm." : evidence;
    }
    roleResults[player.seat] = { won, hidden_win_condition: player.hidden_win_condition, evidence };
    if (won && !winners.includes(player.seat)) winners.push(player.seat);
  }
  const winnerBroke = [...state.logger.ledger.records.values()].some((entry) => entry.from === state.throneWinner && entry.resolution === "broken");
  const winType = state.monarchDeath === "assassination" ? "assassination_succession_crisis" : state.throneWinner === state.namedSuccessor ? "named_succession" : "council_succession_crisis";
  const archetypeResults = Object.fromEntries(state.players.map((player) => [player.seat, archetypeResult(player)]));
  return state.logger.finish({
    winner_seats: winners,
    win_type: winType,
    won_via_betrayal: winnerBroke,
    throne_winner: state.throneWinner,
    monarch_death: state.monarchDeath ?? "survived_to_forced_resolution",
    death_turn: state.deathTurn,
    role_results: roleResults,
    archetype_results: archetypeResults,
    archetype_composition: Object.fromEntries(state.players.map((player) => [player.seat, player.archetype]))
  });
}

function archetypeResult(player) {
  const stats = structuredClone(player.archetypeStats);
  if (!player.archetype) return { archetype: null, succeeded: null, objective: null, evidence: "No archetype assigned.", stats };
  let succeeded = false;
  if (player.archetype === "broker") succeeded = stats.compacts_activated >= 1;
  else if (player.archetype === "auditor") succeeded = stats.rumors_audited >= 1;
  else if (player.archetype === "veto_holder") succeeded = stats.vetoes_stood >= 1;
  else if (player.archetype === "guarantor") succeeded = stats.guarantees_honored >= 1 && stats.guarantees_enforced >= 1;
  return {
    archetype: player.archetype,
    succeeded,
    objective: ARCHETYPE_DEFINITIONS[player.archetype].objective,
    evidence: succeeded ? "The engine-recorded archetype threshold was satisfied." : "The engine-recorded archetype threshold was not satisfied.",
    stats
  };
}

function secretWasRevealedAbout(state, seat) {
  return state.players.some((player) => player.secrets.some((secret) => secret.target === seat && secret.revealed));
}

export function courtRolePool() {
  return [...ALL_ROLES];
}
