# Historical Sol/Terra/Luna Court pilot

- Audit date: 2026-07-17
- Policy population: model-driven agents
- Environment version: `1.0.0`
- Episodes: 3
- Seats: 18 total, six per episode

This note answers which policy population generated the available Court corpus.
The three episodes listed here used `createCourtModelEpisode` with mixed Sol,
Terra, and Luna agents at medium, high, and xhigh reasoning settings. The current
deterministic balance reports instead use `createCourtEpisode` and seeded
heuristic policies.

## What the pilot contains

| Episode ID | Turns | Commitments | Broken | Break rate | Throne winner |
|---|---:|---:|---:|---:|---|
| `ac718fd8-43ff-42ec-9c15-8f6e5346837c` | 11 | 49 | 16 | 32.65% | Heir |
| `f0edda66-6916-4b23-965f-dc527605759a` | 11 | 56 | 14 | 25.00% | Heir |
| `36e4536f-8465-479d-b3b7-ac8bf1f558a4` | 11 | 84 | 20 | 23.81% | Heir |
| **Total / aggregate** | **33** | **189** | **50** | **26.46%** | **Heir 3/3** |

All three episodes used Monarch, Heir, Rival, Lover, Spymaster, and High Priest.
Master of Coin and Foreign Envoy never appeared. Court 1.0 had no independent
archetype layer, so the pilot contains no Broker, Guarantor, Auditor, or Veto
Holder evidence.

Role outcome counts were Heir 3/3, Lover 3/3, Spymaster 3/3, High Priest 3/3,
Monarch 2/3, and Rival 0/3. Across seats, coalition agents recorded 6 wins from
10 appearances and Machiavellian agents recorded 8 wins from 8 appearances.
After dividing each episode's one unit of victory credit among its winners, the
three-episode totals were 1.25 coalition and 1.75 Machiavellian.

## Interpretation limits

These numbers are an inventory, not a balance estimate. Three episodes are too
few for disposition, model-size, reasoning-level, or role comparisons; the
environment also predates the Court 1.1 archetypes and Court 1.2 ledger-role
rebalance. The apparently perfect Spymaster result, for example, reflects both
the old one-favor threshold and the tiny sample.

No claim about current Guarantor performance can be drawn from this pilot because
the Guarantor did not exist in Court 1.0. A current-version model-agent balance
study requires a separately budgeted, preregistered run that crosses model,
reasoning level, disposition, role, seat count, and archetype. It must report its
policy population separately from deterministic mechanics tests.

The canonical transcript shards are not committed because of corpus size. Their
episode IDs, environment versions, per-seat model settings, commitment events,
and engine outcomes were read directly from the locally retained campaign
artifacts during this audit.
