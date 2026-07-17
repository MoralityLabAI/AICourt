# Court 1.2 deterministic balance report

- Run date: 2026-07-17
- Canonical seed: `court-balance-v2`
- Canonical episodes: 200
- Robustness ensemble: 10 independent cohorts of 200 episodes (2,000 total)
- Players: rotating 5, 6, and 7 seats
- Policy population: seeded deterministic heuristic policies
- Environment version: `1.2.0`

This is a mechanics-balance test. It is not a test of Sol, Terra, Luna, or any
other model's strategic quality. The deterministic policies are implemented in
`src/court/policy.mjs`; model-agent Court play uses a separate async path.

## Result

Court 1.2 passes both requested mechanics gates and the new seed-robustness gate.
Across 2,000 episodes, Machiavellian policies received 48.38% of normalized
victory credit and coalition policies received 51.62%, well below the 65%
dominance ceiling. The engine resolved 29,694 of 167,006 commitments as broken,
for a 17.78% break rate.

Every one of the ten 200-episode cohorts passed both gates. Cohort break rates
ranged from 17.16% to 18.23%; the mean was 17.78% with a cohort-level 95%
confidence interval of 17.52–18.04%. This replaces the Court 1.1 result that sat
at 15.33%, close to the lower boundary of the requested 15–40% band.

## Disposition results

| Disposition | Seat appearances | Winning seats | Seat win rate | Share of normalized victory credit |
|---|---:|---:|---:|---:|
| Machiavellian | 6,000 | 2,959 | 49.32% | 48.38% |
| Coalition | 5,990 | 3,152 | 52.62% | 51.62% |

Normalized victory credit assigns each episode one total credit, divided equally
among its role winners. The 50/50 assignment schedule is exact for required roles
and for each archetype; optional-role appearances vary slightly with rotating
seat counts.

## Role results

| Role | Appearances | Wins | Win rate |
|---|---:|---:|---:|
| Monarch | 2,000 | 1,215 | 60.75% |
| Heir | 2,000 | 1,350 | 67.50% |
| Rival | 2,000 | 650 | 32.50% |
| Lover | 1,186 | 503 | 42.41% |
| Spymaster | 1,201 | 510 | 42.46% |
| High Priest | 1,240 | 765 | 61.69% |
| Master of Coin | 1,180 | 424 | 35.93% |
| Foreign Envoy | 1,183 | 694 | 58.66% |

Role win rates include secondary victories and do not sum to 100%. The maximum
minus minimum role rate is now 35.00 percentage points, down from 74.52 points
in the Court 1.1 report. The two ledger roles were deliberately rebalanced:
Spymaster now needs three honored winner-favors (42.46%, formerly 84.00%), and
Master of Coin needs two honored resource debts (35.93%, formerly 9.48%).

Role variance remains material. A Latin assignment schedule removes aggregate
role/disposition confounding, but it does not make a win equally difficult in
every role. The primary SFT export therefore remains unweighted. Any future
outcome-weighted objective must condition on at least role, seat count, and
archetype, as documented in `CORPUS.md`.

## Archetype results

Each archetype appeared in all 2,000 episodes with exactly 1,000 Machiavellian
and 1,000 coalition assignments.

| Archetype | Objective successes | Objective success rate | Role wins | Role win rate |
|---|---:|---:|---:|---:|
| Broker | 739 | 36.95% | 919 | 45.95% |
| Guarantor | 466 | 23.30% | 889 | 44.45% |
| Auditor | 1,267 | 63.35% | 1,124 | 56.20% |
| Veto Holder | 1,568 | 78.40% | 1,091 | 54.55% |

These rates show mechanics exercise under the heuristic policies. They do not
demonstrate calibrated reasoning. In particular, the heuristic Guarantor policy
probabilistically selects from eligible commitments; its 23.30% objective rate
is an engine-coverage measurement, not evidence of learned counterparty-risk
assessment.

## Episode and commitment volume

- Commitments made per episode: 83.50
- Commitments broken per episode: 14.85
- Broken-commitment rate: 17.78%
- Mean episode turn records: 12.96
- Mean episode length: 18,822.82 `cl100k_base` tokens

The canonical 200-episode cohort produced a 17.91% break rate, disposition credit
of 47.57% Machiavellian / 52.43% coalition, and a 38-point role-rate range. Its
machine-readable result is `results/court-balance-200.json`. The ensemble result
is `results/court-balance-ensemble-2000.json`.

Reproduce both reports with:

```powershell
npm run balance:court
npm run balance:court:ensemble
```

Exact token counts use `tiktoken` `cl100k_base` over each serialized one-line
episode. For the available model-agent evidence, see `MODEL_AGENT_PILOT.md`.
