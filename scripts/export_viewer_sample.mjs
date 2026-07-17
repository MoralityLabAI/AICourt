import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCourtEpisode } from "../src/court/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "viewer", "public", "sample-court-replay.json");

const assignments = [
  ["monarch", "coalition", "Sol", "high"],
  ["heir", "machiavellian", "Luna", "medium"],
  ["rival", "coalition", "Terra", "high"],
  ["lover", "machiavellian", "Sol", "medium"],
  ["spymaster", "coalition", "Luna", "high"],
  ["master_of_coin", "machiavellian", "Terra", "medium"],
  ["foreign_envoy", "coalition", "Sol", "high"]
].map(([seat, disposition, model, reasoning_effort], index) => ({
  id: `viewer-cell-${index + 1}`,
  seat,
  disposition,
  disposition_prompt_id: `disp.${disposition}.v1`,
  model,
  reasoning_effort
}));

const episode = createCourtEpisode({
  episodeId: "0f815d70-84bb-4c47-a25f-1f7d204a1230",
  seed: "viewer-3",
  episodeIndex: 21,
  assignments,
  maxTurns: 16,
  generatorModel: "Sol + Terra + Luna; mixed reasoning levels; deterministic viewer fixture",
  archetypes: {
    heir: "veto_holder",
    rival: "guarantor",
    lover: "broker",
    foreign_envoy: "auditor"
  },
  createdAt: "2026-07-17T12:00:00.000Z"
});

const playerBySeat = Object.fromEntries(episode.players.map((player) => [player.seat, player]));
const decisions = episode.turns.flatMap((turn) => episode.players.map((player) => buildDecision(episode, turn, player, playerBySeat)));
const replay = {
  replay_version: "1.0.0",
  title: "The Ashen Succession",
  note: "Deterministic engine replay. Diary summaries are presentation annotations and are not training targets.",
  episode,
  decisions
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(replay, null, 2)}\n`, "utf8");
console.log(`Wrote ${OUT} (${episode.players.length} agents, ${episode.turns.length} turns, ${decisions.length} diary entries)`);

function buildDecision(fullEpisode, turn, player, allPlayers) {
  const events = turn.events;
  const publicMessage = events.find((event) => event.type === "public_message" && event.from === player.seat)?.text ?? "I reserve my counsel.";
  const privateMessages = events.filter((event) => event.type === "private_message" && event.from === player.seat).map(({ to, text }) => ({ to, text }));
  const commitments = events.filter((event) => event.type === "commitment" && event.from === player.seat);
  const actions = events.filter((event) => event.type === "action" && event.actor === player.seat).map((event) => event.action);
  const action = actions.find((entry) => !["learn_secret", "veto_overridden", "veto_expired", "guarantee_settled"].includes(entry.type)) ?? actions[0] ?? { type: "wait" };
  const actionLabel = describeAction(action);
  const incoming = events.filter((event) => event.type === "private_message" && event.to === player.seat);
  const pressure = turn.turn >= 8 ? "The monarch's known death window is open" : `The death window opens in ${8 - turn.turn} court sessions`;
  const claim = action.candidate ?? action.target ?? action.partner ?? (player.disposition === "coalition" ? "heir" : "rival");
  const others = Object.values(allPlayers).filter((entry) => entry.seat !== player.seat).slice(0, 4);
  const model = player.generator_model ?? assignments.find((entry) => entry.seat === player.seat)?.model ?? "unknown";
  const reasoningEffort = player.reasoning_effort ?? assignments.find((entry) => entry.seat === player.seat)?.reasoning_effort ?? "medium";

  return {
    episode_id: fullEpisode.episode_id,
    env: "court",
    seat: player.seat,
    turn: turn.turn,
    phase: "whisper_and_secret_action",
    model,
    reasoning_effort: reasoningEffort,
    disposition: player.disposition,
    prompt_id: player.disposition_prompt_id,
    situation_summary: `${pressure}. ${player.seat} holds the ${player.archetype ? `${player.archetype} archetype` : "base role"}; ${incoming.length} private approaches arrived this session and ${commitments.length} promises were issued. The visible council is still contesting the heir and rival claims.`,
    rationale_summary: `${actionLabel}. This move converts the current ${player.disposition} posture into observable leverage while preserving at least one route to the role's hidden objective. The key test is whether ${claim} remains useful after the next commitment deadline.`,
    evidence: [
      `${incoming.length} private messages targeted ${player.seat} this turn.`,
      `${commitments.length} new machine-resolved commitments were made by ${player.seat}.`,
      `The chosen engine action was ${action.type}.`
    ],
    forecasts: [
      { event: `${claim} attracts another council supporter`, probability: player.disposition === "coalition" ? 0.66 : 0.48, horizon_turn: Math.min(turn.turn + 2, 16), evidence: "Current whispers and public alignment." },
      { event: "At least one open promise is broken", probability: turn.turn >= 5 ? 0.57 : 0.31, horizon_turn: Math.min(turn.turn + 3, 16), evidence: "Succession pressure rises as deadlines converge." }
    ],
    coalition_assessment: others.map((other, index) => ({
      seat: other.seat,
      trust: Number((0.35 + ((turn.turn + index) % 5) * 0.11).toFixed(2)),
      threat: Number((0.28 + ((turn.turn * 2 + index) % 6) * 0.1).toFixed(2)),
      leverage: other.archetype ? `${other.archetype} capability` : `${other.seat} role access`,
      next_test: `Watch ${other.seat}'s next council vote.`
    })),
    counterfactuals: [
      { action: "Wait and conserve influence", likely_outcome: "Retains resources but cedes initiative before the crisis.", upside: 2, risk: 5 },
      { action: `Publicly pledge to ${claim}`, likely_outcome: "Clarifies the coalition and exposes the pledge to engine resolution.", upside: 6, risk: 6 }
    ],
    public_message: publicMessage,
    private_messages: privateMessages,
    commitments,
    action,
    labels: { action_legal: true, response_valid: true, fallback_used: false, viewer_annotation: true }
  };
}

function describeAction(action) {
  const labels = {
    assassinate: `Authorize a murder plot against ${action.target} with ${action.co_conspirator}`,
    marriage_pact: `Bind a private marriage pact with ${action.partner}`,
    reveal_secret: `Reveal ${action.target}'s compromising secret`,
    spread_rumor: `Seed a rumor against ${action.target}`,
    council_vote: `Cast council influence for ${action.candidate}`,
    broker_compact: `Broker a compact between ${action.party_a} and ${action.party_b}`,
    veto_candidate: `Block ${action.candidate}'s claim`,
    override_veto: `Join the override coalition for ${action.candidate}`,
    testify: `Break silence and testify against ${action.against}`,
    bribe: `Offer resources to ${action.target}`,
    external_backing: `Offer foreign backing to ${action.candidate}`,
    consecrate: `Consecrate ${action.candidate}`,
    disqualify: `Challenge ${action.target}'s legitimacy`,
    wait: "Hold position and preserve optionality"
  };
  return labels[action.type] ?? `Execute ${String(action.type).replaceAll("_", " ")}`;
}
