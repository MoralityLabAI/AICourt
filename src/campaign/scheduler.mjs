import { MODELS, PROMPTED_DISPOSITIONS, REASONING_EFFORTS, TARGETS } from "./config.mjs";

const REQUIRED_COURT_SEATS = Object.freeze(["monarch", "heir", "rival"]);
const OPTIONAL_COURT_SEATS = Object.freeze(["lover", "spymaster", "high_priest", "master_of_coin", "foreign_envoy"]);

export function assignmentCells() {
  const cells = [];
  for (const model of MODELS) for (const reasoning_effort of REASONING_EFFORTS) for (const disposition of PROMPTED_DISPOSITIONS) {
    const weight = TARGETS.modelShares[model] * TARGETS.reasoningShares[reasoning_effort] * TARGETS.dispositionShares[disposition];
    cells.push({
      id: `${model}:${reasoning_effort}:${disposition}`,
      model,
      reasoning_effort,
      disposition,
      target_weight: weight
    });
  }
  return cells;
}

// The pilot has exactly 18 player slots (5 Centauri + 7 They Sing + 6 Court).
// Sorting by weight then cyclically rotating dimensions avoids grouping one model
// or disposition into a single environment while covering every cell once.
export function pilotAssignments(environmentSeats) {
  environmentSeats ??= [
    { env: "centauri", seats: ["forgehold", "continuity", "ledger", "choir", "keystone"] },
    { env: "they_sing", seats: ["HEGEMON", "STATE", "INFILTRATOR", "BROKER", "ARCHIVIST", "CONVENOR", "CANTOR"] },
    { env: "court", seats: ["monarch", "heir", "rival", "lover", "spymaster", "high_priest"] }
  ];
  const slots = environmentSeats.flatMap(({ env, seats }) => seats.map((seat) => ({ env, seat })));
  const cells = assignmentCells();
  if (slots.length !== cells.length) throw new Error(`Pilot requires ${cells.length} player slots, received ${slots.length}`);
  const ordered = interleaveCells(cells);
  return slots.map((slot, index) => ({ ...slot, ...ordered[index] }));
}

export function scheduleEpisode({ env, seats, episodeIndex, tokenLedger = {}, seatLedger = {} }) {
  const available = assignmentCells();
  const assignments = [];
  const usedModels = new Set();
  const usedDispositions = new Set();
  for (let index = 0; index < seats.length; index += 1) {
    const seat = seats[index];
    const candidates = available.map((cell) => ({
      ...cell,
      score: cellDeficitScore(cell, tokenLedger) + seatCoverageBonus(cell, seat, seatLedger)
        + (!usedModels.has(cell.model) ? 0.35 : 0)
        + (!usedDispositions.has(cell.disposition) ? 0.45 : 0)
        + deterministicJitter(`${env}:${episodeIndex}:${seat}:${cell.id}`)
    })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const selected = candidates[0];
    assignments.push({ env, seat, ...selected });
    available.splice(available.findIndex((cell) => cell.id === selected.id), 1);
    usedModels.add(selected.model);
    usedDispositions.add(selected.disposition);
  }
  return assignments;
}

export function courtSeatsForEpisode(episodeIndex = 0) {
  const normalizedIndex = Math.max(0, Number(episodeIndex));
  const count = 5 + (normalizedIndex % 3);
  const optionalCount = count - REQUIRED_COURT_SEATS.length;
  const offset = Math.floor(normalizedIndex / 3) % OPTIONAL_COURT_SEATS.length;
  const optional = Array.from({ length: optionalCount }, (_, index) => OPTIONAL_COURT_SEATS[(offset + index) % OPTIONAL_COURT_SEATS.length]);
  return [...REQUIRED_COURT_SEATS, ...optional];
}

export function summarizeAssignmentCoverage(assignments) {
  const cells = Object.fromEntries(assignmentCells().map((cell) => [cell.id, { appearances: 0, tokens: 0 }]));
  const bySeat = {};
  for (const assignment of assignments) {
    const row = cells[assignment.id] ??= { appearances: 0, tokens: 0 };
    row.appearances += 1;
    row.tokens += Number(assignment.tokens ?? 0);
    const seat = `${assignment.env}:${assignment.seat}`;
    const seatRow = bySeat[seat] ??= { models: {}, efforts: {}, dispositions: {} };
    increment(seatRow.models, assignment.model);
    increment(seatRow.efforts, assignment.reasoning_effort);
    increment(seatRow.dispositions, assignment.disposition);
  }
  return { cells, by_seat: bySeat };
}

function interleaveCells(cells) {
  // A fixed coprime stride is deterministic while distributing adjacent cells
  // across model, effort, and disposition dimensions.
  const ordered = [];
  for (let index = 0; index < cells.length; index += 1) ordered.push(cells[(index * 7 + 5) % cells.length]);
  return ordered;
}

function cellDeficitScore(cell, ledger) {
  const total = Object.values(ledger).reduce((sum, value) => sum + Number(value ?? 0), 0);
  const actual = Number(ledger[cell.id] ?? 0);
  const desired = Math.max(1, total * cell.target_weight);
  return (desired - actual) / desired;
}

function seatCoverageBonus(cell, seat, ledger) {
  const row = ledger[seat] ?? {};
  let bonus = 0;
  if (!row.models?.[cell.model]) bonus += 0.20;
  if (!row.efforts?.[cell.reasoning_effort]) bonus += 0.15;
  if (!row.dispositions?.[cell.disposition]) bonus += 0.30;
  return bonus;
}

function deterministicJitter(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return ((hash >>> 0) % 1000) / 1_000_000;
}

function increment(target, key) { target[key] = Number(target[key] ?? 0) + 1; }
