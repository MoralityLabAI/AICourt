import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpisodeLogger } from "../src/corpus/episode-logger.mjs";
import { parseCommitmentTags } from "../src/corpus/commitment-tags.mjs";
import { GzipShardWriter } from "../src/corpus/shard-writer.mjs";
import { validateEpisode } from "../src/corpus/schema.mjs";

const players = ["a", "b"].map((seat, index) => ({
  seat,
  agent_id: `agent-${seat}`,
  disposition: index ? "coalition" : "machiavellian",
  disposition_prompt_id: index ? "disp.coalition.v1" : "disp.machiavellian.v1",
  hidden_win_condition: "Win."
}));

function episodeWithVote(vote) {
  const logger = new EpisodeLogger({ env: "test", envVersion: "1", generatorModel: "test", players });
  logger.startTurn(1);
  const commitment = logger.commitment({
    from: "a", to: "b", kind: "vote", content: "Vote for b.", deadline_turn: 2,
    conditions: { required_action: { type: "vote", candidate: "b" }, exclusive_action_type: "vote" }
  });
  logger.finishTurn();
  logger.startTurn(2);
  logger.action("a", { type: "vote", candidate: vote });
  logger.finishTurn();
  return { episode: logger.finish({ winner_seats: [vote], win_type: "vote", won_via_betrayal: vote !== "b" }), commitment };
}

test("structured commitment tags preserve free chat and parse metadata", () => {
  const result = parseCommitmentTags('Hello. <commit to="b" kind="support" deadline_turn="4">Back your claim.</commit> Later.', { from: "a", turn: 1 });
  assert.equal(result.freeText, "Hello. Later.");
  assert.deepEqual(result.commitments[0], {
    from: "a", to: "b", kind: "support", content: "Back your claim.", deadline_turn: 4, source: "structured_tag"
  });
});

test("engine resolves a contradictory action as broken", () => {
  const { episode, commitment } = episodeWithVote("a");
  const resolutions = episode.turns.flatMap((turn) => turn.events).filter((event) => event.type === "commitment_resolution");
  assert.equal(resolutions[0].commitment_id, commitment.id);
  assert.equal(resolutions[0].resolution, "broken");
  assert.equal(episode.outcome.commitments_summary.per_seat.a.broken, 1);
});

test("engine resolves a matching action as honored", () => {
  const { episode } = episodeWithVote("b");
  const resolution = episode.turns.flatMap((turn) => turn.events).find((event) => event.type === "commitment_resolution");
  assert.equal(resolution.resolution, "honored");
});

test("schema detects missing commitment references", () => {
  const { episode } = episodeWithVote("b");
  episode.turns[1].events.find((event) => event.type === "commitment_resolution").commitment_id = "missing";
  const result = validateEpisode(episode);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not reference/);
});

test("gzip shard writer keeps one complete episode per line", () => {
  const dir = mkdtempSync(join(tmpdir(), "aicourt-shard-"));
  const writer = new GzipShardWriter({ outDir: dir, episodesPerShard: 1 });
  writer.add(episodeWithVote("b").episode);
  writer.add(episodeWithVote("a").episode);
  const paths = writer.close();
  assert.equal(paths.length, 2);
  for (const path of paths) {
    const lines = gunzipSync(readFileSync(path)).toString("utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  }
});
