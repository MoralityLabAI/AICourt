#!/usr/bin/env node
import { createCourtEpisode } from "../src/court/engine.mjs";
import { GzipShardWriter } from "../src/corpus/shard-writer.mjs";

const args = parseArgs(process.argv.slice(2));
const episodes = Number(args.episodes ?? 500);
const outDir = args.out ?? "datasets/court";
const writer = new GzipShardWriter({ outDir, prefix: "court", episodesPerShard: Number(args.shardSize ?? 500) });
for (let index = 0; index < episodes; index += 1) {
  writer.add(createCourtEpisode({
    seed: `${args.seed ?? "court-corpus"}:${index}`,
    episodeIndex: index,
    players: args.players ? Number(args.players) : undefined,
    generatorModel: args.generatorModel
  }));
}
console.log(JSON.stringify({ episodes, shards: writer.close() }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    const key = argv[index].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}
