# Unified strategy-disposition corpus

## Atomic record contract

One physical JSONL line is one complete episode. An episode must never be continued in another line or shard. Production output uses gzip-compressed shards named `<env>-NNNNN.jsonl.gz`, with 500 episodes per full shard and one smaller final shard. `GzipShardWriter` writes a temporary file and atomically renames it only after the whole compressed shard is ready.

The normative machine schema is `corpus.schema.json`. The required top-level fields are:

- `episode_id`: a UUID generated for the unified record;
- `env`: `court`, `they_sing`, `centauri`, or another registered environment name;
- `env_version`: environment semver or Git SHA;
- `generator_model`: episode-level model/settings summary. Mixed episodes also record
  `generator_model`, `reasoning_effort`, `assignment_cell`, and
  `disposition_assignment_source` on each player;
- `created_at`: ISO-8601 timestamp;
- `players`: per-episode seat, agent, assigned disposition, prompt-template ID, and hidden win condition;
- `turns`: ordered turn records containing public/private communication, actions, commitments, and resolutions;
- `outcome`: winners, environment win type, betrayal flag, and engine-derived commitment counts.

Extra environment-specific fields are allowed. Hidden win conditions are present in player metadata for supervised filtering but must not be included in another agent's observation.

## Disposition assignment

Disposition belongs to the agent instance for one episode, never to a seat or role. `assignDispositions()` uses a cyclic schedule, so every stable seat crosses both `machiavellian` and `coalition` in every two-episode cycle. Optional neutral controls use a three-episode cycle. The system prompt templates are:

- `disp.machiavellian.v1`
- `disp.coalition.v1`
- `disp.neutral.v1`

Their exact text lives in `src/corpus/prompting.mjs`. A generator must apply that system prompt before play and copy both `disposition` and `disposition_prompt_id` into the player record. Assignment occurs after seats are sampled. This prevents role/strategy confounding.

## Outcome labels and role variance

Role outcome is not a disposition label. Court roles have different base rates even
under exact disposition × role coverage, so raw winner flags must not be used as
cross-role rewards. The primary SFT view is unweighted behavioral cloning and does
not select or weight examples by victory.

Any outcome-weighted filtering, preference optimization, or reinforcement learning
must estimate a baseline within at least `role × seat_count × archetype` and train on
a residual such as `won - E[won | role, seat_count, archetype]`. Minibatches should
remain stratified by role and disposition. Reports must publish both the raw role
rates and the adjusted disposition effect. A Latin assignment schedule provides
coverage; it does not make raw victory credit comparable across roles.

## Shared event types

| Type | Required fields | Meaning |
|---|---|---|
| `public_message` | `from`, `text` | Visible to every player. |
| `private_message` | `from`, `to`, `text` | Visible only to sender/recipient during play, but retained in the episode. |
| `action` | `actor`, `action` | Structured, environment-specific engine submission or event. |
| `commitment` | `id`, `from`, `to`, `content`, `kind`, `deadline_turn` | An accepted, machine-readable promise. |
| `commitment_resolution` | `commitment_id`, `resolution`, `evidence` | Engine verdict: `honored`, `broken`, `expired`, or `superseded`. |

Commitment kinds are `support`, `non_aggression`, `information`, `resource`, `marriage`, and `vote`.

Free chat remains free. An environment without tool calls may extract structured offers from:

```text
<commit to="rival" kind="support" deadline_turn="5">back your claim at council</commit>
```

Only accepted promises become `commitment` events. The ledger stores deterministic conditions such as a required action, an exclusive choice, or forbidden actions. `EpisodeLogger.action()` sends every structured action through the ledger before state application. A conflicting action resolves the promise as broken immediately; a missing required action resolves it as broken at its deadline. Protective promises that survive their deadline resolve as honored (or expired when explicitly configured as a legacy observation-only pact). No LLM classifies resolution.

## Environment event mappings

### Court

Each turn contains a public court session, 2-3 logged private whispers per living player, then simultaneous secret submissions. Court actions are:

- `council_vote`, `name_successor`, `consecrate`, `disqualify`;
- `reveal_secret`, `spread_rumor`, `learn_secret`;
- `bribe`, `fund`, `external_backing`, `marriage_pact`;
- `assassinate` (requires `co_conspirator`) and `testify`;
- `broker_compact` and `accept_compact` for independently accepted three-party vote compacts;
- `audit_rumor` for an engine-verdict on a previously unverified claim;
- `veto_candidate` and `override_veto` (two distinct override seats are required);
- `guarantee_commitment` for a staked third-party guarantee of an existing ledger commitment;
- engine event `natural_death`.

`bribe`, `fund`, `external_backing`, and `marriage_pact` create commitments. An assassination plot creates reciprocal `information` commitments to remain silent. The exact death turn is hidden engine state sampled uniformly from turns 8–14; the public observation exposes only that window. Succession requires at least two supporters other than the claimant.

Court 1.2 includes a role-independent archetype layer. Four unique archetypes rotate across four distinct seats per episode so role, disposition, and archetype remain separable corpus dimensions:

- `broker`: pays to propose a compact; neither party is bound until both accept, after which the engine creates two reciprocal vote commitments;
- `auditor`: pays to verify a rumor; the engine reveals `substantiated` or `false` and applies legitimacy/influence consequences;
- `veto_holder`: temporarily blocks one claimant, while any two other seats can spend influence to override it;
- `guarantor`: stakes influence behind another pair's open commitment; honor returns the stake and grants legitimacy, while breach compensates the beneficiary and sanctions the promisor. Its high-end objective requires settling both an honored guarantee and an enforced breach in one episode.

Player metadata logs `archetype` plus its capability/dependency/liability/objective brief. `outcome.archetype_results` records an engine-derived secondary-objective result and counters without changing the player's underlying role victory. Corpus validation reports archetype × seat and disposition × archetype coverage.

Version 1.2 also narrows the ledger-role base-rate gap: Master of Coin succeeds at
two honored resource debts, while Spymaster requires three honored favors from the
eventual sovereign. These thresholds are engine-versioned and must not be compared
across corpus slices without conditioning on `env_version`.

### They Sing

`adaptTheySingJsonl()` consumes one native session trace:

- `negotiation_messages` with recipient `ALL` becomes `public_message`;
- a faction recipient becomes `private_message`;
- each accepted order in `orders_submitted` becomes `action`;
- each direction of an engine `pacts_activated` pact becomes a commitment;
- `pact_honored`, `pact_expired`, `pact_broken`, and `pact_violated` become deterministic resolutions;
- the final `turn_completed` supplies the winner/reason when available.

Example:

```powershell
node scripts/adapt_corpus.mjs --env they_sing `
  --input <they-sing-root>\playtest-logs\session_ID.jsonl `
  --out datasets\unified\they_sing `
  --env-version 0879110 `
  --generator-model 'gpt-5; reasoning=high; temperature=1'
```

The live They Sing repository also has the additive entrypoint `scripts/export-unified-corpus.mjs`, which calls this shared adapter without changing its existing serializer.

### AIpha CentaurAI

`adaptCentauriJsonl()` groups native `reset`/`step` lines by legacy episode ID:

- action maps become structured `action` events;
- native engine messages become `public_message` events;
- proposer/target negotiation diary entries become `private_message` events;
- accepted structured diary pacts become commitments and are closed from observable engine deadlines;
- the final `eventual_leader` (or score leader) supplies the outcome.

Example:

```powershell
node scripts/adapt_corpus.mjs --env centauri `
  --input '<centauri-root>\datasets\demo-v1.jsonl' `
  --out datasets\unified\centauri `
  --env-version 0.3.0 `
  --generator-model 'sampled-policy; temperature=8; epsilon=.05'
```

The live AIpha CentaurAI repository also has the additive entrypoint `tools/export_unified_corpus.mjs`, which calls this shared adapter without changing its existing dataset writer.

For new generation, pass a JSON disposition map with `--dispositions`. Historical
agents that were not actually prompted with the new templates must remain `neutral`
with prompt ID `legacy.neutral.unprompted.v1`; they are never retroactively assigned
a strategic disposition.

The mixed Sol/Terra/Luna production run and its exact `o200k_base` leakage-safe
training view are documented in [CAMPAIGN.md](CAMPAIGN.md). Canonical logs remain
the source of truth; the primary SFT export strips the disposition directive while
retaining its label, and the separate conditional view retains the directive.

## Validation and reports

Run:

```powershell
python validate_corpus.py datasets\unified --out results\corpus-validation.json
```

Validation includes:

- JSON Schema and timestamp/UUID formats;
- one complete JSON object per line and at most 500 episodes per shard;
- unique episode IDs, seats, and commitment IDs;
- resolution-to-commitment referential integrity and single resolution;
- event seat references and strictly increasing turns;
- outcome winner references and commitment-summary tie-outs;
- per-environment episodes, exact `cl100k_base` tokens, commitment/break counts, and disposition win rates;
- a disposition × seat matrix and explicit coverage gaps.

The validator reads both `.jsonl` and `.jsonl.gz`. Its broad canonical-log report
uses `cl100k_base` for continuity. Production target accounting uses
`scripts/count_training_tokens.py` with exact `o200k_base` counts over the exported
message contents and reports input/assistant splits.

## Corpus release licensing

The repository code and authored documentation are Apache-2.0. Generated transcript
shards are separate release artifacts: every published corpus must include a data
card naming its generator models, environment code versions, prompts, filters,
known role/outcome skews, and applicable upstream model-provider or environment
terms. Do not infer that the software license automatically relicenses third-party
inputs or model outputs.
