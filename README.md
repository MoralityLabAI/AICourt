# AICourt strategy corpus

AICourt provides a shared episode format and multi-agent game harnesses for
studying prompted strategic dispositions. It includes:

- an engine-owned commitment ledger and gzip JSONL shard writer;
- adapters for AIpha CentaurAI and They Sing traces;
- Court, a deterministic 5–7 player intrigue environment;
- a Sol/Terra/Luna model-agent campaign harness;
- schema, coverage, token, and balance validation; and
- a browser-based Court replay desk with an agent diary and event animation.

## Quick start

Requirements: Node.js 20+ for the corpus tools, Node.js 22+ for the replay desk,
and Python 3 with `tiktoken` for exact token reports.

```powershell
npm test
node scripts/generate_court.mjs --episodes 500 --out datasets/court
python validate_corpus.py datasets/court --out results/court-corpus-validation.json
npm run balance:court
```

Launch the replay desk:

```powershell
npm run viewer:sample
npm run viewer:dev -- -p 4173
```

The viewer accepts an episode JSON/JSONL record or a replay bundle containing
`{ episode, decisions }`. Structured decisions unlock the per-agent reasoning
diary; plain episodes still provide the stage, chronicle, private-channel
controls, and engine-resolved commitment ledger.

## Evidence boundaries

[`BALANCE_REPORT.md`](BALANCE_REPORT.md) reports seeded deterministic-policy simulations. Those runs
exercise mechanics reproducibly but do not measure model-agent strategic
quality. [`MODEL_AGENT_PILOT.md`](MODEL_AGENT_PILOT.md) separately inventories the available
Sol/Terra/Luna Court evidence and states where the sample is too small or
predates current mechanics.

Role outcomes are not disposition rewards. The primary SFT export is unweighted
behavioral cloning. Any future outcome-weighted training must stratify or
residualize rewards by role, seat count, and archetype; raw victory weighting
will learn role priors.

See [CORPUS.md](CORPUS.md) for the data contract, [CAMPAIGN.md](CAMPAIGN.md) for
the configurable model-agent campaign, and [BALANCE_REPORT.md](BALANCE_REPORT.md)
for current deterministic balance evidence.

## License and citation

Code and repository-authored documentation are licensed under Apache-2.0; see
[LICENSE](LICENSE). Released transcript corpora must include their own data card
and preserve any applicable model-provider or upstream-environment terms. Use
[CITATION.cff](CITATION.cff) when citing the software.
