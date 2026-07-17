#!/usr/bin/env node
import { resolve } from "node:path";
import { adaptCentauriJsonl } from "../src/adapters/centauri.mjs";
import { adaptTheySingJsonl } from "../src/adapters/they-sing.mjs";
import { GzipShardWriter } from "../src/corpus/shard-writer.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.env || !args.input || !args.out) usage(1);
const options = {
  envVersion: args.envVersion,
  generatorModel: args.generatorModel,
  dispositions: args.dispositions ? JSON.parse(args.dispositions) : undefined
};
const episodes = args.env === "centauri"
  ? adaptCentauriJsonl(resolve(args.input), options)
  : args.env === "they_sing"
    ? [adaptTheySingJsonl(resolve(args.input), options)]
    : (() => { throw new Error(`Unsupported --env ${args.env}`); })();
const writer = new GzipShardWriter({ outDir: args.out, prefix: args.env, episodesPerShard: Number(args.shardSize ?? 500) });
for (const episode of episodes) writer.add(episode);
const paths = writer.close();
console.log(JSON.stringify({ episodes: episodes.length, shards: paths }, null, 2));

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

function usage(exitCode = 0) {
  console.log("Usage: node scripts/adapt_corpus.mjs --env centauri|they_sing --input trace.jsonl --out corpus-dir [--generator-model text] [--dispositions '{\"seat\":\"coalition\"}']");
  process.exit(exitCode);
}
