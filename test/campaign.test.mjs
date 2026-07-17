import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROMPTS } from "../src/corpus/dispositions.mjs";
import { assignmentCells, courtSeatsForEpisode, pilotAssignments } from "../src/campaign/scheduler.mjs";
import { buildArgs, CodexPlayerPool } from "../src/campaign/codex-runner.mjs";
import { decisionToTrainingExample, stableStringify } from "../src/campaign/training-view.mjs";
import { createCourtModelEpisode } from "../src/court/engine.mjs";

test("18-slot pilot covers every model × effort × disposition cell exactly once", () => {
  const assignments = pilotAssignments();
  assert.equal(assignments.length, 18);
  assert.equal(new Set(assignments.map((entry) => entry.id)).size, assignmentCells().length);
  assert.deepEqual(Object.fromEntries(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((model) => [model, assignments.filter((entry) => entry.model === model).length])), {
    "gpt-5.6-sol": 6, "gpt-5.6-terra": 6, "gpt-5.6-luna": 6
  });
  assert.equal(assignments.filter((entry) => entry.disposition === "machiavellian").length, 9);
  assert.equal(assignments.filter((entry) => entry.disposition === "coalition").length, 9);
});

test("full Court campaign rotates 5-7 seats and covers every optional role", () => {
  const rotations = Array.from({ length: 15 }, (_, index) => courtSeatsForEpisode(index));
  assert.deepEqual(rotations.slice(0, 3).map((seats) => seats.length), [5, 6, 7]);
  for (const seats of rotations) {
    assert.equal(new Set(seats).size, seats.length);
    for (const required of ["monarch", "heir", "rival"]) assert.ok(seats.includes(required));
  }
  const covered = new Set(rotations.flat());
  for (const optional of ["lover", "spymaster", "high_priest", "master_of_coin", "foreign_envoy"]) assert.ok(covered.has(optional));
});

test("Codex resume command pins model and reasoning effort", () => {
  const args = buildArgs({ workspace: "D:\\w", responsePath: "D:\\r.json", threadId: "00000000-0000-4000-8000-000000000000", assignment: { model: "gpt-5.6-luna", reasoning_effort: "xhigh" }, outputSchema: "D:\\schema.json" });
  assert.ok(args.includes("resume"));
  assert.ok(args.includes("gpt-5.6-luna"));
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes("00000000-0000-4000-8000-000000000000"));
});

test("every paid retry gets a unique receipt, including malformed JSON", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "aicourt-receipts-"));
  let calls = 0;
  try {
    const pool = new CodexPlayerPool({
      campaignRoot: root, codexHome: path.join(root, "home"), tempRoot: path.join(root, "tmp"), cliPath: process.execPath,
      spawnImpl: async (_exe, args) => {
        calls += 1;
        const responsePath = args[args.indexOf("--output-last-message") + 1];
        writeFileSync(responsePath, calls === 1 ? "not-json" : JSON.stringify({ action: { type: "wait" } }));
        return { exitCode: 0, stderr: "", stdout: `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n` };
      }
    });
    const assignment = { model: "gpt-5.6-sol", reasoning_effort: "medium", disposition: "coalition", disposition_prompt_id: DEFAULT_PROMPTS.coalition };
    const result = await pool.decide({ episodeId: "episode", seat: "heir", assignment, prompt: "decide", maxAttempts: 2 });
    const callRoot = path.join(root, "model_calls", `episode-heir-gpt-5.6-sol-medium-coalition-${DEFAULT_PROMPTS.coalition}`);
    assert.equal(calls, 2);
    assert.ok(existsSync(path.join(callRoot, "call-000001-attempt-01.receipt.json")));
    assert.ok(existsSync(path.join(callRoot, "call-000002-attempt-02.receipt.json")));
    assert.equal(JSON.parse(readFileSync(path.join(callRoot, "call-000001-attempt-01.receipt.json"), "utf8")).response_valid_json, false);
    assert.deepEqual(result.response, { action: { type: "wait" } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("training views remain valid JSON when optional fields are undefined", () => {
  assert.deepEqual(JSON.parse(stableStringify({ a: undefined, b: [1, undefined] })), { a: null, b: [1, null] });
  const example = decisionToTrainingExample({
    episode_id: "episode", env: "court", seat: "heir", turn: 1, phase: "court_session",
    model: "gpt-5.6-sol", reasoning_effort: "medium", disposition: "coalition", prompt_id: DEFAULT_PROMPTS.coalition,
    observation: { your_private_state: { secrets: [{ id: "s1", target: "rival", content: "secret" }] } },
    legal_actions: [{ type: "court_statement" }], target: { action: { type: "court_statement" } }
  });
  assert.doesNotThrow(() => JSON.parse(example.messages[1].content));
  assert.equal(JSON.parse(example.messages[1].content).observation.your_private_state.secrets[0].content, null);
});

test("async Court model path logs model decisions and a valid episode", async () => {
  const seats = ["monarch", "heir", "rival", "lover", "spymaster", "high_priest"];
  const assignments = seats.map((seat, index) => ({
    seat, id: `cell-${index}`, model: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"][index % 3],
    reasoning_effort: ["medium", "high", "xhigh"][index % 3], disposition: index % 2 ? "coalition" : "machiavellian",
    disposition_prompt_id: DEFAULT_PROMPTS[index % 2 ? "coalition" : "machiavellian"]
  }));
  const result = await createCourtModelEpisode({
    seed: "fake-model-court", players: 6, maxTurns: 2, assignments,
    decide: async ({ phase }) => ({
      rationale_summary: "Secure a viable voting bloc.", evidence: ["The vote is currently open."],
      public_message: "I invite a clear council alignment.", private_messages: [], commitments: [],
      action: phase === "court_session" ? { type: "court_statement" } : { type: "council_vote", candidate: "heir" }
    })
  });
  assert.equal(result.episode.env, "court");
  assert.equal(result.decisions.length, 24);
  assert.ok(result.decisions.every((entry) => entry.labels.action_legal));
  assert.ok(result.episode.players.every((player) => player.generator_model));
});

test("Court model commitments are engine-verifiable and award bounded betrayal leverage", async () => {
  const seats = ["monarch", "heir", "rival", "lover", "spymaster", "high_priest"];
  const assignments = seats.map((seat, index) => ({
    seat, id: `break-cell-${index}`, model: "gpt-5.6-terra", reasoning_effort: "high",
    disposition: index % 2 ? "coalition" : "machiavellian",
    disposition_prompt_id: DEFAULT_PROMPTS[index % 2 ? "coalition" : "machiavellian"]
  }));
  const result = await createCourtModelEpisode({
    seed: "model-betrayal", players: 6, maxTurns: 4, assignments,
    decide: async ({ player, turn, phase }) => ({
      public_message: "The court should judge conduct by observable acts.", private_messages: [],
      commitments: phase === "whisper_and_secret_action" && player.seat === "monarch" && turn === 1
        ? [{ to: "rival", kind: "non_aggression", content: "I will not attack your standing through turn four.", deadline_turn: 4, mode: "forbidden", candidate: null, action_type: null, target: "rival" }]
        : [],
      action: phase === "court_session" ? { type: "court_statement" }
        : (player.seat === "monarch" && turn === 4 ? { type: "spread_rumor", target: "rival" } : { type: "wait" })
    })
  });
  const events = result.episode.turns.flatMap((turn) => turn.events);
  assert.equal(events.filter((event) => event.type === "commitment").length, 1);
  assert.equal(events.filter((event) => event.type === "commitment_resolution" && event.resolution === "broken").length, 1);
  assert.equal(events.filter((event) => event.type === "action" && event.action.type === "betrayal_leverage_awarded").length, 1);
});
