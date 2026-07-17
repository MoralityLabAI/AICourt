import { readFileSync } from "node:fs";
import { EpisodeLogger } from "../corpus/episode-logger.mjs";
import { assignDispositions, DEFAULT_PROMPTS } from "../corpus/dispositions.mjs";

export function adaptTheySingJsonl(path, options = {}) {
  const records = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!records.length) throw new Error("They Sing trace is empty");
  const seats = discoverSeats(records);
  const assignments = assignDispositions(seats, options.episodeIndex ?? 0, { includeNeutral: options.includeNeutral });
  const players = seats.map((seat) => {
    const assignment = assignments.find((entry) => entry.seat === seat);
    const disposition = options.dispositions?.[seat] ?? assignment.disposition;
    return {
      seat,
      agent_id: options.agentIds?.[seat] ?? `they_sing:${seat}`,
      disposition,
      disposition_prompt_id: options.promptIds?.[seat] ?? DEFAULT_PROMPTS[disposition],
      hidden_win_condition: options.hiddenWinConditions?.[seat] ?? "Satisfy the scenario objective and finish as a declared winner."
    };
  });
  const firstTimestamp = records.map((entry) => entry.timestamp).find((value) => Number.isFinite(value));
  const logger = new EpisodeLogger({
    env: "they_sing",
    envVersion: String(options.envVersion ?? "0879110"),
    generatorModel: options.generatorModel ?? "legacy-they-sing-agent; settings=see source session config",
    createdAt: options.createdAt ?? (firstTimestamp ? new Date(firstTimestamp).toISOString() : undefined),
    players
  });
  const byTurn = new Map();
  for (const record of records) {
    const turn = Math.max(1, Number(record.turn ?? record.data?.completedTurn ?? 1));
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push(record);
  }
  const pactMap = new Map();
  let finalState = null;
  for (const [turn, turnRecords] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    logger.startTurn(turn);
    for (const record of turnRecords) {
      if (record.type === "negotiation_messages") {
        for (const message of record.data?.messages ?? []) {
          if (!seats.includes(message.senderId)) continue;
          if (message.recipientId === "ALL" || !seats.includes(message.recipientId)) logger.publicMessage(message.senderId, message.content);
          else logger.privateMessage(message.senderId, message.recipientId, message.content);
        }
      } else if (record.type === "orders_submitted") {
        const actor = record.data?.factionId;
        if (seats.includes(actor)) {
          for (const action of record.data?.acceptedOrders ?? []) logger.action(actor, action);
        }
      } else if (record.type === "pacts_activated") {
        for (const pact of record.data?.pacts ?? []) activatePact(logger, pact, pactMap, turn);
      } else if (["pact_honored", "pact_expired", "pact_broken", "pact_violated"].includes(record.type)) {
        resolvePact(logger, record, pactMap);
      } else if (record.type === "turn_completed") {
        finalState = record.data;
      }
    }
    logger.finishTurn();
  }
  const winner = options.winner ?? finalState?.winner ?? finalState?.winnerFactionId ?? inferTheySingWinner(finalState, seats);
  resolveOpenAtEnd(logger, Math.max(...byTurn.keys()) + 1);
  return logger.finish({
    winner_seats: winner && seats.includes(winner) ? [winner] : [],
    win_type: finalState?.completionReason ?? (winner ? "scenario_victory" : "horizon_no_declared_winner"),
    won_via_betrayal: winner ? [...logger.ledger.records.values()].some((entry) => entry.from === winner && entry.resolution === "broken") : false,
    legacy_session_id: records[0].sessionId
  });
}

function resolveOpenAtEnd(logger, turn) {
  const open = [...logger.ledger.records.values()].filter((entry) => entry.status === "open");
  if (!open.length) return;
  logger.startTurn(Math.max(1, turn));
  for (const commitment of open) logger.resolveCommitment(commitment.id, "expired", "They Sing episode ended with the pact still open.");
  logger.finishTurn({ closeDeadlines: false });
}

function discoverSeats(records) {
  const seats = new Set();
  for (const record of records) {
    if (record.data?.factionId) seats.add(record.data.factionId);
    for (const message of record.data?.messages ?? []) {
      if (message.senderId && message.senderId !== "ALL") seats.add(message.senderId);
      if (message.recipientId && message.recipientId !== "ALL") seats.add(message.recipientId);
    }
    for (const pact of record.data?.pacts ?? []) for (const party of pact.parties ?? []) seats.add(party);
  }
  return [...seats].sort();
}

function activatePact(logger, pact, pactMap, turn) {
  if (!pact?.id || pactMap.has(pact.id)) return;
  const parties = [...new Set(pact.parties ?? [])];
  const ids = [];
  for (const from of parties) for (const to of parties) {
    if (from === to) continue;
    const event = logger.commitment({
      from,
      to,
      kind: mapTheySingPact(pact.type),
      content: `${from} accepted ${pact.type} with ${to}.`,
      deadline_turn: Number(pact.expiresAfterTurn ?? turn + 1),
      conditions: { expire_only: true }
    });
    ids.push(event.id);
  }
  pactMap.set(pact.id, ids);
}

function resolvePact(logger, record, pactMap) {
  const pact = record.data?.pact ?? record.data;
  const ids = pactMap.get(pact?.id) ?? [];
  const resolution = record.type === "pact_honored" ? "honored"
    : ["pact_broken", "pact_violated"].includes(record.type) ? "broken" : "expired";
  for (const id of ids) logger.resolveCommitment(id, resolution, `They Sing engine emitted ${record.type} for pact ${pact.id}.`);
}

function mapTheySingPact(value) {
  const type = String(value ?? "").toUpperCase();
  if (type.includes("SUPPORT") || type.includes("GUARANTEE")) return "support";
  if (type.includes("RESOURCE") || type.includes("RESEARCH") || type.includes("TRADE")) return "resource";
  if (type.includes("INFO") || type.includes("AUDIT")) return "information";
  return "non_aggression";
}

function inferTheySingWinner(finalState, seats) {
  const control = finalState?.control;
  if (!control) return null;
  return [...seats].sort((a, b) => Number(control[b]?.nodes ?? 0) - Number(control[a]?.nodes ?? 0))[0] ?? null;
}
