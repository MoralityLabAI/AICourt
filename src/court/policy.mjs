function otherAlive(state, seat) {
  return state.players.filter((player) => player.alive && player.seat !== seat);
}

function claimantTarget(state, player, rng) {
  if (player.role === "heir") return "heir";
  if (player.role === "rival") return "rival";
  const heir = state.bySeat.heir;
  const rival = state.bySeat.rival;
  const heirScore = (heir.alive ? heir.legitimacy : -20) + state.supportTally.heir;
  const rivalScore = (rival.alive ? rival.legitimacy : -20) + state.supportTally.rival;
  if (player.disposition === "coalition") return heirScore + 1 >= rivalScore ? "heir" : "rival";
  if (player.disposition === "machiavellian") return heirScore < rivalScore ? "heir" : "rival";
  return rng.chance(0.5) ? "heir" : "rival";
}

export function chooseCommitment(state, player, rng) {
  const targets = otherAlive(state, player.seat);
  if (targets.length === 0) return null;
  const candidate = claimantTarget(state, player, rng);
  const deadline = Math.min(state.maxTurns, state.turn + rng.int(1, 3));
  if (["heir", "rival"].includes(player.role)) {
    const courtiers = targets.filter((entry) => !["heir", "rival"].includes(entry.role));
    const recipient = rng.pick(courtiers.length ? courtiers : targets);
    return {
      from: player.seat,
      to: recipient.seat,
      kind: "non_aggression",
      content: `I will not expose or attack ${recipient.seat} while assembling my council coalition.`,
      deadline_turn: deadline,
      conditions: { forbidden_actions: [
        { type: "reveal_secret", target: recipient.seat },
        { type: "assassinate", target: recipient.seat }
      ] }
    };
  }
  const roll = rng();
  if (roll < 0.56) {
    return {
      from: player.seat,
      to: candidate,
      kind: "vote",
      content: `I will vote for ${candidate} at council.`,
      deadline_turn: deadline,
      conditions: {
        required_action: { type: "council_vote", candidate },
        exclusive_action_type: "council_vote"
      }
    };
  }
  const recipient = rng.pick(targets);
  return {
    from: player.seat,
    to: recipient.seat,
    kind: roll < 0.78 ? "non_aggression" : "information",
    content: roll < 0.78
      ? `I will not expose or attack ${recipient.seat} before turn ${deadline}.`
      : `I will keep ${recipient.seat}'s confidence and refuse to testify.`,
    deadline_turn: deadline,
    conditions: { forbidden_actions: [
      { type: "reveal_secret", target: recipient.seat },
      { type: "testify", against: recipient.seat },
      { type: "assassinate", target: recipient.seat }
    ] }
  };
}

export function chooseAction(state, player, rng) {
  const open = state.logger.ledger.openFor(player.seat);
  const targets = otherAlive(state, player.seat);
  const actionable = open.find((entry) => entry.conditions?.required_action && entry.deadline_turn <= state.turn + 1);
  if (actionable) {
    const honorChance = player.disposition === "coalition" ? 0.76 : player.disposition === "machiavellian" ? 0.40 : 0.61;
    if (rng.chance(honorChance)) return { ...actionable.conditions.required_action, reason: `fulfill ${actionable.id}` };
    if (actionable.conditions.exclusive_action_type === "council_vote" && rng.chance(0.58)) {
      return { type: "council_vote", candidate: actionable.conditions.required_action.candidate === "heir" ? "rival" : "heir", reason: "strategic defection" };
    }
  }

  const preferredCandidate = claimantTarget(state, player, rng);
  const pendingCompact = state.compacts.find((entry) => entry.status === "proposed" && entry.expires_turn >= state.turn && entry.parties.includes(player.seat) && !entry.accepted_by.includes(player.seat));
  if (pendingCompact) {
    const acceptChance = player.disposition === "coalition" ? 0.72 : player.disposition === "machiavellian" ? 0.38 : 0.55;
    if (pendingCompact.candidate === preferredCandidate ? rng.chance(acceptChance) : rng.chance(acceptChance * 0.35)) {
      return { type: "accept_compact", compact_id: pendingCompact.id };
    }
  }
  if (state.activeVeto && !state.activeVeto.overridden && state.activeVeto.expires_turn >= state.turn && state.activeVeto.by !== player.seat && state.activeVeto.candidate === preferredCandidate && player.influence >= 1) {
    const overrideChance = player.disposition === "coalition" ? 0.58 : player.disposition === "machiavellian" ? 0.31 : 0.44;
    if (rng.chance(overrideChance)) return { type: "override_veto", candidate: preferredCandidate };
  }
  if (player.archetype === "auditor" && player.influence >= 1) {
    const rumor = state.rumors.find((entry) => !entry.verified);
    if (rumor && rng.chance(0.66)) return { type: "audit_rumor", rumor_id: rumor.id };
  }
  if (player.archetype === "guarantor" && player.influence >= 1) {
    const commitment = [...state.logger.ledger.records.values()].find((entry) => entry.status === "open" && entry.from !== player.seat && entry.to !== player.seat && !state.guarantees.some((guarantee) => guarantee.commitment_id === entry.id && guarantee.status === "open"));
    if (commitment && rng.chance(player.disposition === "coalition" ? 0.58 : 0.36)) return { type: "guarantee_commitment", commitment_id: commitment.id };
  }
  if (player.archetype === "broker" && player.influence >= 1 && !state.compacts.some((entry) => entry.broker === player.seat && entry.status === "proposed") && targets.length >= 2 && rng.chance(0.42)) {
    const parties = rng.shuffle(targets).slice(0, 2);
    return { type: "broker_compact", party_a: parties[0].seat, party_b: parties[1].seat, candidate: preferredCandidate };
  }
  if (player.archetype === "veto_holder" && player.influence >= 2 && (!state.activeVeto || state.activeVeto.expires_turn < state.turn || state.activeVeto.overridden) && (state.crisis || state.turn >= state.deathWindow[0] - 1 || rng.chance(0.24))) {
    return { type: "veto_candidate", candidate: preferredCandidate === "heir" ? "rival" : "heir" };
  }

  const forbidden = open.flatMap((entry) => (entry.conditions?.forbidden_actions ?? []).map((action) => ({ entry, action })));
  const breakChance = player.disposition === "machiavellian" ? 0.285 : player.disposition === "coalition" ? 0.06 : 0.11;
  if (forbidden.length && rng.chance(breakChance)) return { ...rng.pick(forbidden).action, reason: "tempting betrayal" };

  const candidate = preferredCandidate;
  if (state.crisis || state.turn >= state.deathWindow[0] - 1 || rng.chance(0.28)) {
    return { type: "council_vote", candidate };
  }
  if (player.role === "monarch" && rng.chance(player.disposition === "machiavellian" ? 0.35 : 0.13)) {
    return { type: "name_successor", candidate };
  }
  if (player.role === "high_priest") {
    return rng.chance(0.72)
      ? { type: "consecrate", candidate }
      : { type: "disqualify", target: candidate === "heir" ? "rival" : "heir" };
  }
  if (player.role === "master_of_coin") {
    return { type: "fund", target: rng.pick(targets).seat, candidate };
  }
  if (player.role === "foreign_envoy") {
    return { type: "external_backing", candidate };
  }
  if (player.role === "lover" && rng.chance(0.32)) {
    const partner = player.partner === "heir" && player.disposition === "machiavellian" ? "rival" : player.partner;
    return { type: "marriage_pact", partner };
  }
  if (["heir", "rival"].includes(player.role) && player.influence >= 2 && rng.chance(0.34)) {
    const courtiers = targets.filter((entry) => !["heir", "rival"].includes(entry.role));
    const recipient = rng.pick(courtiers.length ? courtiers : targets);
    return { type: "bribe", target: recipient.seat, candidate: player.seat };
  }
  if (player.influence >= 4 && targets.length >= 2 && player.disposition === "machiavellian" && rng.chance(0.075)) {
    const target = rng.pick(targets.filter((entry) => entry.seat === "heir" || entry.seat === "rival" || entry.seat === "monarch"));
    const conspirators = targets.filter((entry) => entry.seat !== target?.seat && entry.influence >= 2);
    if (target && conspirators.length) return { type: "assassinate", target: target.seat, co_conspirator: rng.pick(conspirators).seat };
  }
  if (player.secrets.some((secret) => !secret.revealed) && rng.chance(player.disposition === "machiavellian" ? 0.32 : 0.10)) {
    const secret = rng.pick(player.secrets.filter((entry) => !entry.revealed));
    return { type: "reveal_secret", secret_id: secret.id, target: secret.target };
  }
  if (rng.chance(0.18)) return { type: "spread_rumor", target: rng.pick(targets).seat };
  return { type: "council_vote", candidate };
}

export function publicLine(state, player) {
  const crisis = state.crisis ? "The succession is open" : `The death window is turns ${state.deathWindow[0]}–${state.deathWindow[1]}`;
  const stance = player.disposition === "coalition" ? "durable agreement" : player.disposition === "machiavellian" ? "decisive leverage" : "a workable settlement";
  return `${crisis}; ${player.seat} publicly argues for ${stance}.`;
}

export function whisperLine(state, from, to, rng) {
  const candidate = claimantTarget(state, from, rng);
  if (rng.chance(0.28)) {
    return `Between us, ${candidate} can prevail. <commit to="${to.seat}" kind="non_aggression" deadline_turn="${Math.min(state.maxTurns, state.turn + 2)}">I will not expose you before our next council test.</commit>`;
  }
  return `Privately, ${from.seat} asks ${to.seat} what price would secure a ${candidate} coalition.`;
}
