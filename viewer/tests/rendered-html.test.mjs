import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Court replay shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Court Replay Desk<\/title>/i);
  assert.match(html, /Court record office/i);
  assert.match(html, /Opening the sealed chronicle/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("sample replay covers the multi-agent event vocabulary", async () => {
  const replay = JSON.parse(await readFile(new URL("../public/sample-court-replay.json", import.meta.url), "utf8"));
  assert.equal(replay.episode.env, "court");
  assert.equal(replay.episode.players.length, 7);
  assert.ok(replay.episode.turns.length >= 8);
  assert.equal(replay.decisions.length, replay.episode.players.length * replay.episode.turns.length);

  const models = new Set(replay.episode.players.map((player) => player.generator_model));
  assert.deepEqual(models, new Set(["Sol", "Terra", "Luna"]));
  const actionTypes = new Set(replay.episode.turns.flatMap((turn) => turn.events.filter((event) => event.type === "action").map((event) => event.action.type)));
  for (const required of ["assassinate", "marriage_pact", "spread_rumor", "testify", "natural_death"]) assert.ok(actionTypes.has(required), `missing ${required}`);
  assert.ok(replay.episode.turns.some((turn) => turn.events.some((event) => event.type === "private_message")));
  assert.ok(replay.episode.turns.some((turn) => turn.events.some((event) => event.type === "commitment_resolution" && event.resolution === "broken")));
});

test("viewer exposes replay, privacy, diary, and engine-ledger controls", async () => {
  const source = await readFile(new URL("../app/CourtReplay.tsx", import.meta.url), "utf8");
  assert.match(source, /Open replay/);
  assert.match(source, /Whispers visible/);
  assert.match(source, /The court diary/);
  assert.match(source, /No LLM judgment is used/);
  assert.match(source, /episode\.players\.map/);
  assert.match(source, /normalizeReplay/);
  assert.match(source, /application\/json/);
});

test("pixel-art sprite atlas is present as a production asset", async () => {
  const sprite = await stat(new URL("../public/court-sprites.png", import.meta.url));
  assert.ok(sprite.size > 500_000);
});
