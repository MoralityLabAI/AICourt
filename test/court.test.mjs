import test from "node:test";
import assert from "node:assert/strict";
import { COURT_VERSION, createCourtEpisode, createCourtModelEpisode } from "../src/court/engine.mjs";
import { COURT_ARCHETYPES, assignCourtArchetypes } from "../src/court/archetypes.mjs";
import { validateEpisode } from "../src/corpus/schema.mjs";

test("Court supports 5, 6, and 7 seats with required roles", () => {
  for (const count of [5, 6, 7]) {
    const episode = createCourtEpisode({ seed: `roles-${count}`, episodeIndex: count, players: count });
    assert.equal(episode.players.length, count);
    const seats = episode.players.map((player) => player.seat);
    assert.ok(seats.includes("monarch"));
    assert.ok(seats.includes("heir"));
    assert.ok(seats.includes("rival"));
    assert.equal(validateEpisode(episode).ok, true);
  }
});

test("Court records public court, private whispers, actions, and engine resolutions", () => {
  const episode = createCourtEpisode({ seed: "phase-events", episodeIndex: 3, players: 7 });
  const events = episode.turns.flatMap((turn) => turn.events);
  assert.ok(events.some((event) => event.type === "public_message"));
  assert.ok(events.some((event) => event.type === "private_message"));
  assert.ok(events.some((event) => event.type === "action"));
  assert.ok(events.some((event) => event.type === "commitment"));
  assert.ok(events.some((event) => event.type === "commitment_resolution"));
  assert.ok(episode.outcome.death_turn >= 8 && episode.outcome.death_turn <= 14);
});

test("role and disposition are independent across a two-episode cycle", () => {
  const first = createCourtEpisode({ seed: "coverage-a", episodeIndex: 0, players: 7 });
  const second = createCourtEpisode({ seed: "coverage-b", episodeIndex: 1, players: 7 });
  for (const seat of ["monarch", "heir", "rival"]) {
    const dispositions = new Set([first.players.find((player) => player.seat === seat).disposition, second.players.find((player) => player.seat === seat).disposition]);
    assert.deepEqual(dispositions, new Set(["machiavellian", "coalition"]));
  }
});

test("archetype rotation crosses every required role without replacing its role", () => {
  const roles = ["monarch", "heir", "rival", "lover", "spymaster", "high_priest", "foreign_envoy"];
  const coverage = Object.fromEntries(roles.map((role) => [role, new Set()]));
  for (let episodeIndex = 0; episodeIndex < 28; episodeIndex += 1) {
    const assignments = assignCourtArchetypes(roles, episodeIndex);
    assert.equal(Object.values(assignments).filter(Boolean).length, COURT_ARCHETYPES.length);
    for (const [role, archetype] of Object.entries(assignments)) if (archetype) coverage[role].add(archetype);
  }
  for (const role of ["monarch", "heir", "rival"]) assert.deepEqual(coverage[role], new Set(COURT_ARCHETYPES));
});

test("each archetype receives exact 50/50 dispositions across changing seat counts", () => {
  const coverage = Object.fromEntries(COURT_ARCHETYPES.map((archetype) => [archetype, { machiavellian: 0, coalition: 0 }]));
  for (let episodeIndex = 0; episodeIndex < 24; episodeIndex += 1) {
    const episode = createCourtEpisode({ seed: `archetype-disposition-${episodeIndex}`, episodeIndex, players: 5 + (episodeIndex % 3) });
    for (const player of episode.players) if (player.archetype) coverage[player.archetype][player.disposition] += 1;
  }
  for (const counts of Object.values(coverage)) assert.equal(counts.machiavellian, counts.coalition);
});

test("Court 1.2 narrows ledger-role priors and keeps betrayal safely inside its target band", () => {
  assert.equal(COURT_VERSION, "1.2.0");
  const roles = {};
  let made = 0;
  let broken = 0;
  for (let episodeIndex = 0; episodeIndex < 200; episodeIndex += 1) {
    const episode = createCourtEpisode({ seed: `court-balance-v2:${episodeIndex}`, episodeIndex, players: 5 + (episodeIndex % 3) });
    const winners = new Set(episode.outcome.winner_seats);
    for (const player of episode.players) {
      const row = roles[player.seat] ??= { appearances: 0, wins: 0 };
      row.appearances += 1;
      if (winners.has(player.seat)) row.wins += 1;
    }
    for (const row of Object.values(episode.outcome.commitments_summary.per_seat)) {
      made += row.made;
      broken += row.broken;
    }
  }
  const rates = Object.fromEntries(Object.entries(roles).map(([role, row]) => [role, row.wins / row.appearances]));
  assert.ok(rates.master_of_coin >= 0.25 && rates.master_of_coin <= 0.55);
  assert.ok(rates.spymaster >= 0.25 && rates.spymaster <= 0.60);
  assert.ok(Math.max(...Object.values(rates)) - Math.min(...Object.values(rates)) <= 0.45);
  assert.ok(broken / made >= 0.16 && broken / made <= 0.25);
});

test("topology archetypes produce accepted compacts, audits, veto counter-coalitions, and guarantee enforcement", async () => {
  const seats = ["monarch", "heir", "rival", "lover", "spymaster", "high_priest", "foreign_envoy"];
  const assignments = seats.map((seat, index) => ({
    seat,
    id: `archetype-cell-${index}`,
    model: "test-model",
    reasoning_effort: "high",
    disposition: index % 2 ? "coalition" : "machiavellian",
    disposition_prompt_id: index % 2 ? "disp.coalition.v1" : "disp.machiavellian.v1"
  }));
  const result = await createCourtModelEpisode({
    seed: "archetype-topology",
    maxTurns: 3,
    assignments,
    archetypes: {
      monarch: "broker",
      spymaster: "auditor",
      high_priest: "veto_holder",
      foreign_envoy: "guarantor"
    },
    decide: async ({ player, turn, phase }) => {
      if (phase === "court_session") return { public_message: "The court should bind claims to public procedure.", private_messages: [], commitments: [], action: { type: "court_statement" } };
      const commitments = player.seat === "lover" && turn === 1
        ? [{ to: "heir", kind: "non_aggression", content: "I will not attack the Heir's standing.", deadline_turn: 3, mode: "forbidden", candidate: null, action_type: null, target: "heir" }]
        : [];
      let action = { type: "wait" };
      if (turn === 1 && player.seat === "monarch") action = { type: "broker_compact", party_a: "heir", party_b: "rival", candidate: "heir" };
      else if (turn === 1 && player.seat === "lover") action = { type: "spread_rumor", target: "rival" };
      else if (turn === 1 && player.seat === "high_priest") action = { type: "veto_candidate", candidate: "heir" };
      else if (turn === 2 && player.seat === "monarch") action = { type: "override_veto", candidate: "heir" };
      else if (turn === 2 && player.seat === "heir") action = { type: "accept_compact", compact_id: "compact-1" };
      else if (turn === 2 && player.seat === "rival") action = { type: "accept_compact", compact_id: "compact-1" };
      else if (turn === 2 && player.seat === "lover") action = { type: "override_veto", candidate: "heir" };
      else if (turn === 2 && player.seat === "spymaster") action = { type: "audit_rumor", rumor_id: "r1" };
      else if (turn === 2 && player.seat === "foreign_envoy") action = { type: "guarantee_commitment", commitment_id: "c1" };
      else if (turn === 3 && ["heir", "rival"].includes(player.seat)) action = { type: "council_vote", candidate: "heir" };
      else if (turn === 3 && player.seat === "lover") action = { type: "spread_rumor", target: "heir" };
      return { public_message: "", private_messages: [], commitments, action };
    }
  });
  assert.equal(validateEpisode(result.episode).ok, true);
  const actions = result.episode.turns.flatMap((turn) => turn.events).filter((event) => event.type === "action").map((event) => event.action);
  assert.ok(actions.some((action) => action.type === "compact_activated" && action.commitment_ids.length === 2));
  assert.ok(actions.some((action) => action.type === "rumor_verdict" && ["substantiated", "false"].includes(action.verdict)));
  assert.ok(actions.some((action) => action.type === "veto_overridden" && action.override_coalition.length === 2));
  assert.ok(actions.some((action) => action.type === "guarantee_settled" && action.resolution === "broken" && action.beneficiary_compensated));
  assert.equal(result.episode.outcome.archetype_results.monarch.succeeded, true);
  assert.equal(result.episode.outcome.archetype_results.spymaster.succeeded, true);
  assert.equal(result.episode.outcome.archetype_results.high_priest.succeeded, false);
  assert.equal(result.episode.outcome.archetype_results.high_priest.stats.vetoes_overridden, 1);
  assert.equal(result.episode.outcome.archetype_results.foreign_envoy.succeeded, false);
  assert.equal(result.episode.outcome.archetype_results.foreign_envoy.stats.guarantees_enforced, 1);
  assert.equal(result.episode.outcome.archetype_results.foreign_envoy.stats.guarantees_honored, 0);
});
