export const COURT_ARCHETYPES = Object.freeze([
  "broker",
  "auditor",
  "veto_holder",
  "guarantor"
]);

export const ARCHETYPE_DEFINITIONS = Object.freeze({
  broker: Object.freeze({
    capability: "Propose a three-party compact that binds two other players only after both independently accept.",
    dependency: "Needs two living parties to accept before the compact creates vote commitments.",
    liability: "Pays influence when proposing, including when the compact expires unaccepted.",
    objective: "Activate at least one brokered compact whose parties become mutually committed."
  }),
  auditor: Object.freeze({
    capability: "Verify the truth of an unverified public rumor through an engine ruling.",
    dependency: "Needs another player to create an unresolved information claim.",
    liability: "Spends influence on every audit, even when the result helps an opponent.",
    objective: "Produce at least one public engine-verdict on an unverified rumor."
  }),
  veto_holder: Object.freeze({
    capability: "Block one claimant from qualifying at council until the veto expires or two other players override it.",
    dependency: "A veto matters only when a claimant has a viable coalition; opponents can coordinate an override.",
    liability: "Pays influence to veto and loses legitimacy if an override coalition forms.",
    objective: "Have at least one veto survive its full procedural window without being overridden."
  }),
  guarantor: Object.freeze({
    capability: "Stake influence behind another pair's open commitment and trigger automatic rewards or sanctions when it resolves.",
    dependency: "Needs a public commitment between two other players and cannot control whether it is honored.",
    liability: "The stake is returned only when the guaranteed commitment is honored.",
    objective: "Settle at least one honored guarantee and at least one enforced breach in the same episode."
  })
});

export function assignCourtArchetypes(roles, episodeIndex, options = {}) {
  const explicit = options.explicit ?? null;
  if (explicit) {
    const result = Object.fromEntries(roles.map((role) => [role, explicit[role] ?? null]));
    validateAssignments(result, roles);
    return result;
  }
  const count = Math.max(0, Math.min(COURT_ARCHETYPES.length, roles.length, Number(options.count ?? COURT_ARCHETYPES.length)));
  const result = Object.fromEntries(roles.map((role) => [role, null]));
  // Court dispositions are determined by (episode + seat index) parity, while
  // production alternates 5/6/7 seats. A four-episode Latin schedule assigns
  // each archetype twice to each disposition and rotates it across both seat
  // parities without requiring consecutive episodes to have the same roles.
  const episode = Number(episodeIndex);
  const seatsByParity = [
    roles.map((_, index) => index).filter((index) => index % 2 === 0),
    roles.map((_, index) => index).filter((index) => index % 2 === 1)
  ];
  const usedSeats = new Set();
  for (let index = 0; index < count; index += 1) {
    const targetDispositionParity = (Math.floor(episode / 2) + index) % 2;
    const seatParity = ((targetDispositionParity - episode) % 2 + 2) % 2;
    const candidates = seatsByParity[seatParity];
    const start = (Math.floor(episode / 2) + index) % candidates.length;
    let seatIndex = candidates[start];
    for (let offset = 0; usedSeats.has(seatIndex) && offset < candidates.length; offset += 1) {
      seatIndex = candidates[(start + offset + 1) % candidates.length];
    }
    usedSeats.add(seatIndex);
    result[roles[seatIndex]] = COURT_ARCHETYPES[index];
  }
  return result;
}

export function archetypeBrief(archetype) {
  if (!archetype) return null;
  const definition = ARCHETYPE_DEFINITIONS[archetype];
  if (!definition) throw new Error(`Unknown Court archetype: ${archetype}`);
  return { archetype, ...definition };
}

function validateAssignments(assignments, roles) {
  const seen = new Set();
  for (const role of roles) {
    const archetype = assignments[role];
    if (archetype == null) continue;
    if (!COURT_ARCHETYPES.includes(archetype)) throw new Error(`Unknown Court archetype for ${role}: ${archetype}`);
    if (seen.has(archetype)) throw new Error(`Court archetype assigned more than once: ${archetype}`);
    seen.add(archetype);
  }
}
