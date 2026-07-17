# Mixed Sol/Terra/Luna corpus campaign

The campaign harness targets an 8.0–8.5M `o200k_base`-token primary SFT view
across Centauri, They Sing, and Court. Canonical episode logs remain the source
of truth. The primary view removes the disposition directive from model input
while retaining its label; `training/conditional` retains the directive for
explicitly conditioned experiments. Hidden chain-of-thought is never exported.

## Target mixture

- Environments: Centauri 30%, They Sing 35%, Court 35% (±5 points).
- Models: Sol 30%, Terra 35%, Luna 35% (±5 points).
- Reasoning levels: medium 30%, high 45%, xhigh 25% (±5 points).
- Prompted dispositions: Machiavellian 50%, coalition 50% (±3 points).
- Legacy unprompted material remains `neutral` and is capped at 2M tokens.
- No more than 1,200 accepted model decisions.

The 18-slot pilot covers every model × reasoning × prompted-disposition cell
once across five Centauri, seven They Sing, and six Court seats. Full rollout is
locked until the pilot passes legality, uniqueness, token-share, commitment,
and storage gates.

## Configuration

Use `.env.example` as a reference and set the equivalent environment variables
in the invoking shell. At minimum, point the harness at writable campaign
storage and an isolated authenticated Codex home:

```powershell
$env:AICOURT_CAMPAIGN_ROOT = "E:\corpora\aicourt-campaign"
$env:AICOURT_CODEX_HOME = "E:\corpora\codex-player-home"
$env:ALPHA_CENTAURAI_ROOT = "..\AIpha CentaurAI"
$env:THEYSING_ROOT = "..\TheySing\TheySing"
$env:THEYSING_REPLAY_CONFIG = "..\TheySing\TheySing\playtest\replay_session_config.json"
```

Legacy imports are optional and have separate source variables. No source,
credential, cache, or output path is hard-coded to a contributor workstation.

## Run order

```powershell
npm test
npm run campaign:plan
npm run campaign:legacy   # only when legacy sources are configured
npm run campaign:pilot -- --autoScale false
npm run campaign:status
npm run campaign:run
```

`campaign:run` is resumable. Concurrency is bounded to 1–6; the default is two.
Canonical episodes and training views are promoted atomically only after their
receipts and validation gates pass.

The cost-bounded 18-cell pilot uses one fixed six-seat Court lineup and ten
turns to validate the call and promotion pipeline. Full Court rollout rotates
5/6/7-seat lineups across every optional role and permits all 16 turns, so the
random turn-8–14 succession window is never truncated. Pilot outcomes must not
be used as role-coverage or balance evidence.

## Promotion gates

The pilot requires:

- 100% schema-valid responses and at least 95% legal actions;
- zero fallbacks and at least 80% distinct response hashes;
- at least 15% assistant tokens in the leakage-safe training view;
- a 15–40% engine-resolved broken-commitment rate; and
- configured free-space floors on both the system and campaign volumes.

Storage paths, player state, temporary files, and model-call receipts remain
outside Git by default. Failed pilots are retained under the configured campaign
root for audit but are not promoted.

## Interpretation

Model-agent campaign episodes use `createCourtModelEpisode`. The deterministic
balance suite uses `createCourtEpisode`; its results are mechanics evidence, not
evidence of Sol/Terra/Luna strategic quality. Do not combine the two populations
in one balance table without a `policy_population` dimension.
