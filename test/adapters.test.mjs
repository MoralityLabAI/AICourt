import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptCentauriJsonl } from "../src/adapters/centauri.mjs";
import { adaptTheySingJsonl } from "../src/adapters/they-sing.mjs";

test("Centauri reset/step rows become one unified episode", () => {
  const path = join(mkdtempSync(join(tmpdir(), "centauri-")), "trace.jsonl");
  const rows = [
    { schema: "aipha.synthetic.v1", event: "reset", episode_id: "legacy", payload: { engine_version: "0.3.0", config: { agent: "sampled", skill_by_faction: { alpha: "x", beta: "y" } }, initial_state: { factions: [{ id: "alpha" }, { id: "beta" }] } } },
    { event: "step", episode_id: "legacy", payload: { turn: 1, actions: { alpha: [{ type: "wait" }], beta: [{ type: "wait" }] }, decisions: [], messages: [], outcome: { eventual_leader: "alpha" } } }
  ];
  writeFileSync(path, rows.map(JSON.stringify).join("\n"));
  const [episode] = adaptCentauriJsonl(path);
  assert.equal(episode.env, "centauri");
  assert.deepEqual(episode.outcome.winner_seats, ["alpha"]);
  assert.equal(episode.turns[0].events.filter((event) => event.type === "action").length, 2);
});

test("They Sing engine pact events become first-class commitments and resolutions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "they-sing-")), "trace.jsonl");
  const records = [
    { sessionId: "s", type: "negotiation_messages", turn: 1, timestamp: Date.now(), data: { factionId: "A", messages: [{ senderId: "A", recipientId: "B", content: "Quiet border." }] } },
    { sessionId: "s", type: "pacts_activated", turn: 1, data: { pacts: [{ id: "p1", type: "NON_AGGRESSION", parties: ["A", "B"], expiresAfterTurn: 2 }] } },
    { sessionId: "s", type: "pact_honored", turn: 1, data: { pact: { id: "p1" } } },
    { sessionId: "s", type: "turn_completed", turn: 1, data: { winner: "A", completionReason: "test" } }
  ];
  writeFileSync(path, records.map(JSON.stringify).join("\n"));
  const episode = adaptTheySingJsonl(path, { envVersion: "test" });
  const events = episode.turns.flatMap((turn) => turn.events);
  assert.equal(events.filter((event) => event.type === "commitment").length, 2);
  assert.equal(events.filter((event) => event.type === "commitment_resolution" && event.resolution === "honored").length, 2);
  assert.ok(events.some((event) => event.type === "private_message"));
});
