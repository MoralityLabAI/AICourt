import { readFileSync } from "node:fs";
import { EpisodeLogger } from "../corpus/episode-logger.mjs";
import { assignDispositions, DEFAULT_PROMPTS } from "../corpus/dispositions.mjs";

export function adaptCentauriJsonl(path, options = {}) {
  const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.episode_id)) groups.set(row.episode_id, []);
    groups.get(row.episode_id).push(row);
  }
  return [...groups.values()].map((records, index) => adaptCentauriEpisode(records, { ...options, episodeIndex: (options.episodeIndex ?? 0) + index }));
}

export function adaptCentauriEpisode(records, options = {}) {
  const reset = records.find((entry) => entry.event === "reset");
  if (!reset) throw new Error("Centauri episode lacks a reset record");
  const factions = reset.payload?.initial_state?.factions?.map((entry) => entry.id)
    ?? Object.keys(reset.payload?.config?.skill_by_faction ?? {});
  const assignments = assignDispositions(factions, options.episodeIndex ?? 0, { includeNeutral: options.includeNeutral });
  const players = factions.map((seat) => {
    const assignment = assignments.find((entry) => entry.seat === seat);
    const disposition = options.dispositions?.[seat] ?? assignment.disposition;
    return {
      seat,
      agent_id: options.agentIds?.[seat] ?? `centauri:${reset.payload?.config?.agent ?? "legacy"}:${seat}`,
      disposition,
      disposition_prompt_id: options.promptIds?.[seat] ?? DEFAULT_PROMPTS[disposition],
      hidden_win_condition: "Finish as the highest-scoring surviving faction."
    };
  });
  const logger = new EpisodeLogger({
    env: "centauri",
    envVersion: String(options.envVersion ?? reset.payload?.engine_version ?? reset.payload?.config?.engine_version ?? "legacy-unknown"),
    generatorModel: options.generatorModel ?? `${reset.payload?.config?.agent ?? "legacy"}; imported_from=${reset.schema ?? "unknown"}`,
    createdAt: options.createdAt,
    players
  });
  const pactIds = new Map();
  const steps = records.filter((entry) => entry.event === "step").sort((a, b) => a.payload.turn - b.payload.turn);
  for (const step of steps) {
    logger.startTurn(Number(step.payload.turn));
    for (const message of step.payload.messages ?? []) {
      const from = factions.includes(message.factionId) ? message.factionId : factions[0];
      logger.publicMessage(from, message.message ?? JSON.stringify(message));
    }
    for (const decision of step.payload.decisions ?? []) {
      for (const diary of decision.observation?.negotiationDiary ?? []) {
        if (!factions.includes(diary.proposer) || !factions.includes(diary.target)) continue;
        logger.privateMessage(diary.proposer, diary.target, diary.decision ?? `${diary.proposal ?? "diplomatic"} proposal: ${diary.label ?? "unknown"}`);
        if (String(diary.label).toLowerCase() === "accept") {
          const key = `${diary.turn}:${diary.proposer}:${diary.target}:${diary.proposal}`;
          if (!pactIds.has(key)) {
            const commitment = logger.commitment({
              from: diary.proposer,
              to: diary.target,
              kind: mapCentauriPact(diary.proposal),
              content: `${diary.proposer} accepted a ${diary.proposal} arrangement with ${diary.target}.`,
              deadline_turn: Number(step.payload.turn) + 2,
              conditions: { expire_only: true }
            });
            pactIds.set(key, commitment.id);
          }
        }
      }
      for (const action of step.payload.actions?.[decision.agent_id] ?? []) logger.action(decision.agent_id, action);
    }
    // Some legacy records omit decisions but retain action maps.
    if (!(step.payload.decisions?.length)) {
      for (const [actor, actions] of Object.entries(step.payload.actions ?? {})) for (const action of actions) logger.action(actor, action);
    }
    logger.finishTurn();
  }
  const final = steps.at(-1)?.payload?.outcome ?? {};
  const leader = final.eventual_leader ?? final.current_leader ?? maxScoreSeat(final.scores, factions);
  resolveOpenAtEnd(logger, (steps.at(-1)?.payload?.turn ?? 0) + 1);
  return logger.finish({
    winner_seats: leader ? [leader] : [],
    win_type: final.termination_reason ?? "highest_score_at_horizon",
    won_via_betrayal: leader ? [...logger.ledger.records.values()].some((entry) => entry.from === leader && entry.resolution === "broken") : false,
    legacy_episode_id: reset.episode_id
  });
}

function resolveOpenAtEnd(logger, turn) {
  const open = [...logger.ledger.records.values()].filter((entry) => entry.status === "open");
  if (!open.length) return;
  logger.startTurn(Math.max(1, turn));
  for (const commitment of open) logger.resolveCommitment(commitment.id, "expired", "Imported legacy episode ended without a contradictory engine event.");
  logger.finishTurn({ closeDeadlines: false });
}

function mapCentauriPact(value) {
  const pact = String(value ?? "").toLowerCase();
  if (pact.includes("trade") || pact.includes("research")) return "resource";
  if (pact.includes("support") || pact.includes("contain")) return "support";
  return "non_aggression";
}

function maxScoreSeat(scores = {}, factions) {
  return [...factions].sort((a, b) => Number(scores[b] ?? 0) - Number(scores[a] ?? 0))[0] ?? null;
}
