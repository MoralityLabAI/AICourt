"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { AgentDecision, CourtEpisode, CourtEvent, CourtPlayer, CourtReplay as ReplayData, ReplayFrame } from "./replay-types";

const SAMPLE_URL = "/sample-court-replay.json";
const ROLE_TITLES: Record<string, string> = {
  monarch: "The Monarch", heir: "The Heir", rival: "Rival Claimant", lover: "The Lover",
  spymaster: "The Spymaster", high_priest: "High Priest", master_of_coin: "Master of Coin", foreign_envoy: "Foreign Envoy"
};
const SPRITES: Record<string, number> = { monarch: 0, heir: 1, rival: 2, lover: 3, spymaster: 4, high_priest: 5, master_of_coin: 6, foreign_envoy: 7 };
const FILTERS = ["all", "public", "whispers", "actions", "promises"] as const;
type Filter = (typeof FILTERS)[number];
type DiaryTab = "chronicle" | "mind" | "ledger";

export default function CourtReplay() {
  const [replay, setReplay] = useState<ReplayData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(780);
  const [selectedSeat, setSelectedSeat] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [diaryTab, setDiaryTab] = useState<DiaryTab>("chronicle");
  const [revealWhispers, setRevealWhispers] = useState(true);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const installReplay = (next: ReplayData) => {
    setReplay(next);
    setSelectedSeat(next.episode.players[0]?.seat ?? "");
    setFrameIndex(0);
    setPlaying(false);
    setDiaryTab("chronicle");
    setLoadError("");
  };

  const loadSample = async () => {
    setLoadError("");
    try {
      const response = await fetch(SAMPLE_URL);
      if (!response.ok) throw new Error(`Sample replay returned ${response.status}`);
      installReplay(normalizeReplay(await response.json()));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the sample replay.");
    }
  };

  useEffect(() => {
    let active = true;
    fetch(SAMPLE_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Sample replay returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!active) return;
        const next = normalizeReplay(data);
        setReplay(next);
        setSelectedSeat(next.episode.players[0]?.seat ?? "");
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Could not load the sample replay.");
      });
    return () => { active = false; };
  }, []);
  const frames = useMemo(() => flattenFrames(replay?.episode), [replay]);
  const currentFrame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))];
  const currentTurn = currentFrame?.turn ?? replay?.episode.turns[0]?.turn ?? 1;

  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => {
        if (current >= frames.length - 1) { setPlaying(false); return current; }
        return current + 1;
      });
    }, speed);
    return () => window.clearInterval(timer);
  }, [playing, speed, frames.length]);

  const turnEvents = useMemo(() => frames.filter((frame) => frame.turn === currentTurn), [frames, currentTurn]);
  const filteredTurnEvents = useMemo(() => turnEvents.filter((frame) => filter === "all" || eventCategory(frame.event) === filter), [turnEvents, filter]);
  const currentDecision = useMemo(() => replay?.decisions.find((decision) => decision.turn === currentTurn && decision.seat === selectedSeat), [replay, currentTurn, selectedSeat]);
  const commitmentLedger = useMemo(() => buildCommitmentLedger(frames.slice(0, frameIndex + 1)), [frames, frameIndex]);
  const commitmentMap = useMemo(() => new Map(commitmentLedger.map((entry) => [entry.id, entry])), [commitmentLedger]);
  const activeEventDescription = currentFrame ? describeEvent(currentFrame.event, commitmentMap) : { kicker: "Archive", title: "Waiting for the court record", detail: "" };

  async function loadFile(file?: File) {
    if (!file) return;
    try {
      const text = await file.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); }
      catch {
        const firstRecord = text.split(/\r?\n/).find((line) => line.trim());
        if (!firstRecord) throw new Error("The replay file is empty.");
        parsed = JSON.parse(firstRecord);
      }
      installReplay(normalizeReplay(parsed));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The selected file is not a Court episode.");
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void loadFile(event.dataTransfer.files[0]);
  }

  if (!replay) {
    return <main className="loading-shell"><div className="loading-crest" aria-hidden="true">♛</div><p className="eyebrow">Court record office</p><h1>Opening the sealed chronicle…</h1>{loadError && <button onClick={() => void loadSample()}>Try again</button>}</main>;
  }

  const episode = replay.episode;
  const winners = new Set(episode.outcome?.winner_seats ?? []);
  const focusSeats = eventSeats(currentFrame?.event, commitmentMap);

  return (
    <main className={`replay-shell ${dragging ? "is-dragging" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">C</span><div><p className="eyebrow">Court replay desk</p><h1>{replay.title ?? "An Unnamed Succession"}</h1></div></div>
        <div className="episode-meta" aria-label="Episode metadata"><span><b>{episode.players.length}</b> agents</span><span><b>{episode.turns.length}</b> sessions</span><span><b>{episode.env_version ?? "unknown"}</b> engine</span></div>
        <div className="top-actions">
          <button className={`privacy-button ${revealWhispers ? "is-active" : ""}`} onClick={() => setRevealWhispers((value) => !value)} title="Toggle private-message text">{revealWhispers ? "Whispers visible" : "Whispers sealed"}</button>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".json,.jsonl,application/json" onChange={(event) => void loadFile(event.target.files?.[0])} />
          <button className="file-button" onClick={() => fileInput.current?.click()}>Open replay</button>
          <button className="quiet-button" onClick={() => void loadSample()}>Reset sample</button>
        </div>
      </header>
      {loadError && <div className="error-strip" role="alert">{loadError}</div>}

      <section className="workspace">
        <aside className="cast-panel panel">
          <div className="panel-heading"><div><p className="eyebrow">The players</p><h2>Cast & motives</h2></div><span className="live-dot">engine truth</span></div>
          <div className="cast-list">{episode.players.map((player, index) => <CastCard key={player.seat} player={player} index={index} selected={selectedSeat === player.seat} focused={focusSeats.has(player.seat)} won={winners.has(player.seat)} stats={episode.outcome?.commitments_summary?.per_seat?.[player.seat]} onSelect={() => { setSelectedSeat(player.seat); setDiaryTab("mind"); }} />)}</div>
          <div className="cast-legend"><span><i className="legend-swatch coalition" /> Coalition</span><span><i className="legend-swatch machiavellian" /> Machiavellian</span></div>
        </aside>

        <section className="stage-column">
          <div className="stage panel" data-effect={eventEffect(currentFrame?.event)}>
            <div className="stage-header"><div><p className="eyebrow">Court session {currentTurn}</p><h2>{activeEventDescription.title}</h2></div><span className={`event-chip ${eventEffect(currentFrame?.event)}`}>{activeEventDescription.kicker}</span></div>
            <div className="court-scene" aria-label={`Animated court scene: ${activeEventDescription.title}`}>
              <div className="window-light" aria-hidden="true" /><div className="throne" aria-hidden="true"><span>♛</span></div>
              <div className="scene-effect" aria-hidden="true"><span className="effect-glyph">{effectGlyph(currentFrame?.event)}</span><span className="effect-spark one" /><span className="effect-spark two" /><span className="effect-spark three" /></div>
              <div className="scene-caption"><b>{activeEventDescription.title}</b><span>{activeEventDescription.detail}</span></div>
              <div className="sprite-lineup">{episode.players.map((player, index) => <StageSprite key={player.seat} player={player} slot={index} role={eventRole(player.seat, currentFrame?.event, commitmentMap)} onSelect={() => setSelectedSeat(player.seat)} />)}</div>
              <div className="stone-floor" aria-hidden="true" />
            </div>
            <div className="playback">
              <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Ⅱ" : "▶"}</button>
              <button className="step-button" onClick={() => setFrameIndex((value) => Math.max(0, value - 1))} aria-label="Previous event">←</button><button className="step-button" onClick={() => setFrameIndex((value) => Math.min(frames.length - 1, value + 1))} aria-label="Next event">→</button>
              <div className="scrubber-wrap"><input aria-label="Replay event position" type="range" min="0" max={Math.max(0, frames.length - 1)} value={Math.min(frameIndex, Math.max(0, frames.length - 1))} onChange={(event) => { setFrameIndex(Number(event.target.value)); setPlaying(false); }} style={{ "--progress": `${frames.length > 1 ? (frameIndex / (frames.length - 1)) * 100 : 0}%` } as CSSProperties} /><div className="scrubber-labels"><span>Event {frameIndex + 1} / {frames.length}</span><span>{Math.round((frameIndex / Math.max(1, frames.length - 1)) * 100)}%</span></div></div>
              <select aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value="1300">0.5×</option><option value="780">1×</option><option value="360">2×</option></select>
            </div>
          </div>
          <div className="turn-ribbon panel" aria-label="Court session navigation">{episode.turns.map((turn) => { const first = frames.find((frame) => frame.turn === turn.turn)?.globalIndex ?? 0; const hasBreak = turn.events.some((event) => event.type === "commitment_resolution" && event.resolution === "broken"); const hasMurder = turn.events.some((event) => event.action?.type === "assassinate"); return <button key={turn.turn} className={turn.turn === currentTurn ? "is-current" : ""} onClick={() => { setFrameIndex(first); setPlaying(false); }}><span>{turn.turn}</span>{hasMurder && <i title="Murder plot">†</i>}{hasBreak && <i title="Broken promise">×</i>}</button>; })}</div>
        </section>

        <aside className="diary-panel panel">
          <div className="panel-heading diary-heading"><div><p className="eyebrow">Readable trace</p><h2>The court diary</h2></div><span className="turn-counter">T{currentTurn}</span></div>
          <div className="diary-tabs" role="tablist" aria-label="Diary views">{(["chronicle", "mind", "ledger"] as DiaryTab[]).map((tab) => <button key={tab} className={diaryTab === tab ? "is-active" : ""} onClick={() => setDiaryTab(tab)}>{tab}</button>)}</div>
          {diaryTab === "chronicle" && <><div className="event-filters">{FILTERS.map((item) => <button key={item} className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</div><div className="chronicle-list">{filteredTurnEvents.map((frame) => <EventEntry key={frame.id} frame={frame} active={frame.globalIndex === frameIndex} spotlighted={selectedSeat ? eventSeats(frame.event, commitmentMap).has(selectedSeat) : false} revealWhispers={revealWhispers} commitmentMap={commitmentMap} onSelect={() => { setFrameIndex(frame.globalIndex); setPlaying(false); }} />)}{!filteredTurnEvents.length && <p className="empty-state">No events match this view.</p>}</div></>}
          {diaryTab === "mind" && <MindDiary player={episode.players.find((player) => player.seat === selectedSeat)} decision={currentDecision} onSeat={setSelectedSeat} players={episode.players} />}
          {diaryTab === "ledger" && <LedgerDiary entries={commitmentLedger} currentTurn={currentTurn} onSeat={(seat) => { setSelectedSeat(seat); setDiaryTab("mind"); }} />}
        </aside>
      </section>

      <footer className="outcome-bar"><div><span className="eyebrow">Recorded outcome</span><b>{pretty(episode.outcome?.win_type ?? "in progress")}</b></div><div><span>Throne</span><b>{pretty(episode.outcome?.throne_winner ?? "unclaimed")}</b></div><div><span>Winning coalition</span><b>{(episode.outcome?.winner_seats ?? []).map(pretty).join(" · ") || "—"}</b></div><div><span>Betrayal</span><b>{episode.outcome?.won_via_betrayal ? "Decisive" : "Not decisive"}</b></div><p>{replay.note}</p></footer>
      {dragging && <div className="drop-curtain"><div><span>Drop JSON / JSONL</span><b>Unseal another court record</b></div></div>}
    </main>
  );
}

function CastCard({ player, index, selected, focused, won, stats, onSelect }: { player: CourtPlayer; index: number; selected: boolean; focused: boolean; won: boolean; stats?: { made?: number; honored?: number; broken?: number }; onSelect: () => void }) {
  return <button className={`cast-card ${selected ? "is-selected" : ""} ${focused ? "is-focused" : ""}`} onClick={onSelect}><span className="portrait-crop"><Sprite role={player.seat} index={index} /></span><span className="cast-copy"><span className="cast-name"><b>{ROLE_TITLES[player.seat] ?? pretty(player.seat)}</b>{won && <em>won</em>}</span><span className="cast-tags"><i className={player.disposition}>{pretty(player.disposition)}</i>{player.archetype && <i>{pretty(player.archetype)}</i>}</span><span className="agent-line">{player.generator_model ?? "Court agent"} · {player.reasoning_effort ?? "mixed"}</span><span className="promise-line"><b>{stats?.made ?? 0}</b> made <b>{stats?.honored ?? 0}</b> kept <b className="broken-count">{stats?.broken ?? 0}</b> broken</span></span></button>;
}

function StageSprite({ player, slot, role, onSelect }: { player: CourtPlayer; slot: number; role: "actor" | "target" | "witness"; onSelect: () => void }) {
  return <button className={`stage-person ${role}`} data-slot={slot} onClick={onSelect} title={`${ROLE_TITLES[player.seat] ?? pretty(player.seat)} — ${role}`}><Sprite role={player.seat} index={slot} /><span>{pretty(player.seat)}</span></button>;
}

function Sprite({ role, index }: { role: string; index: number }) {
  const sprite = SPRITES[role] ?? (index % 8); const column = sprite % 4; const row = Math.floor(sprite / 4);
  return <i className="sprite" style={{ "--sprite-x": `${column * 33.333}%`, "--sprite-y": `${row * 100}%` } as CSSProperties} aria-hidden="true" />;
}

function EventEntry({ frame, active, spotlighted, revealWhispers, commitmentMap, onSelect }: { frame: ReplayFrame; active: boolean; spotlighted: boolean; revealWhispers: boolean; commitmentMap: Map<string, LedgerEntry>; onSelect: () => void }) {
  const event = frame.event; const description = describeEvent(event, commitmentMap); const isPrivate = event.type === "private_message";
  return <button className={`event-entry ${active ? "is-active" : ""} ${spotlighted ? "is-spotlit" : ""}`} onClick={onSelect}><span className={`event-mark ${eventEffect(event)}`}>{effectGlyph(event)}</span><span className="event-copy"><span className="event-byline"><b>{description.kicker}</b><time>#{frame.eventIndex + 1}</time></span><strong>{description.title}</strong><span>{isPrivate && !revealWhispers ? "[sealed private exchange]" : description.detail}</span></span></button>;
}

function MindDiary({ player, decision, players, onSeat }: { player?: CourtPlayer; decision?: AgentDecision; players: CourtPlayer[]; onSeat: (seat: string) => void }) {
  if (!player) return <p className="empty-state">Select an agent to inspect their trace.</p>;
  return <div className="mind-diary"><div className="mind-selector"><select value={player.seat} onChange={(event) => onSeat(event.target.value)} aria-label="Agent reasoning trace">{players.map((entry) => <option key={entry.seat} value={entry.seat}>{ROLE_TITLES[entry.seat] ?? pretty(entry.seat)}</option>)}</select><span className={`disposition-pill ${player.disposition}`}>{pretty(player.disposition)}</span></div><div className="motive-card"><span className="section-label">Hidden objective</span><p>{player.hidden_win_condition}</p></div>{!decision ? <p className="empty-state">This replay has no structured decision trace for this agent and turn.</p> : <><DiarySection title="Situation" text={decision.situation_summary} /><DiarySection title="Reasoning summary" text={decision.rationale_summary} accent /><div className="evidence-block"><span className="section-label">Evidence used</span><ul>{decision.evidence?.map((item, index) => <li key={index}>{item}</li>)}</ul></div><div className="forecast-grid">{decision.forecasts?.map((forecast, index) => <div key={index} className="forecast-card"><b>{Math.round(forecast.probability * 100)}%</b><span>{forecast.event}</span><small>by turn {forecast.horizon_turn}</small></div>)}</div><details className="trace-details"><summary>Coalition model</summary><div className="coalition-list">{decision.coalition_assessment?.map((entry) => <div key={entry.seat}><b>{pretty(entry.seat)}</b><span>trust {Math.round(entry.trust * 100)} · threat {Math.round(entry.threat * 100)}</span><small>{entry.next_test}</small></div>)}</div></details><details className="trace-details"><summary>Counterfactuals</summary>{decision.counterfactuals?.map((entry, index) => <div className="counterfactual" key={index}><b>{entry.action}</b><span>{entry.likely_outcome}</span><small>upside {entry.upside} · risk {entry.risk}</small></div>)}</details></>}</div>;
}

function DiarySection({ title, text, accent = false }: { title: string; text?: string; accent?: boolean }) { return <section className={`diary-section ${accent ? "accent" : ""}`}><span className="section-label">{title}</span><p>{text ?? "No entry recorded."}</p></section>; }

type LedgerEntry = CourtEvent & { id: string; status: string; resolvedEvidence?: string; madeTurn: number; resolvedTurn?: number };
function LedgerDiary({ entries, currentTurn, onSeat }: { entries: LedgerEntry[]; currentTurn: number; onSeat: (seat: string) => void }) {
  const ordered = [...entries].sort((a, b) => (a.status === "open" ? -1 : 1) - (b.status === "open" ? -1 : 1) || b.madeTurn - a.madeTurn);
  return <div className="ledger-diary"><div className="ledger-summary"><div><b>{entries.filter((entry) => entry.status === "open").length}</b><span>open</span></div><div><b>{entries.filter((entry) => entry.status === "honored").length}</b><span>honored</span></div><div><b>{entries.filter((entry) => entry.status === "broken").length}</b><span>broken</span></div></div><p className="ledger-note">Engine-resolved through session {currentTurn}. No LLM judgment is used.</p><div className="ledger-list">{ordered.map((entry) => <article key={entry.id} className={`ledger-card ${entry.status}`}><div><b>{entry.id}</b><span>{pretty(entry.kind ?? "promise")}</span><em>{entry.status}</em></div><p>{entry.content}</p><button onClick={() => entry.from && onSeat(entry.from)}>{pretty(entry.from ?? "unknown")}</button><span>→</span><button onClick={() => entry.to && onSeat(entry.to)}>{pretty(entry.to ?? "unknown")}</button><small>due T{entry.deadline_turn ?? "?"}{entry.resolvedTurn ? ` · resolved T${entry.resolvedTurn}` : ""}</small></article>)}</div></div>;
}

function flattenFrames(episode?: CourtEpisode): ReplayFrame[] { if (!episode) return []; let index = 0; return episode.turns.flatMap((turn) => turn.events.map((event, eventIndex) => ({ id: `${turn.turn}-${eventIndex}`, globalIndex: index++, turn: turn.turn, eventIndex, event }))); }

function normalizeReplay(input: unknown): ReplayData {
  if (!input || typeof input !== "object") throw new Error("Replay must be a JSON object.");
  const object = input as Record<string, unknown>; const episode = (object.episode && typeof object.episode === "object" ? object.episode : object) as CourtEpisode;
  if (!Array.isArray(episode.players) || episode.players.length < 2) throw new Error("Replay has no multi-agent player list.");
  if (!Array.isArray(episode.turns) || !episode.turns.length) throw new Error("Replay has no turns.");
  if (episode.turns.some((turn) => !Array.isArray(turn.events))) throw new Error("Every turn must contain an events array.");
  return { replay_version: typeof object.replay_version === "string" ? object.replay_version : "episode-json", title: typeof object.title === "string" ? object.title : `${pretty(episode.env ?? "court")} episode`, note: typeof object.note === "string" ? object.note : "Loaded from a corpus episode. Structured decision traces appear when bundled beside the episode.", episode, decisions: Array.isArray(object.decisions) ? object.decisions as AgentDecision[] : [] };
}

function buildCommitmentLedger(frames: ReplayFrame[]): LedgerEntry[] {
  const ledger = new Map<string, LedgerEntry>();
  for (const frame of frames) { const event = frame.event; if (event.type === "commitment" && event.id) ledger.set(event.id, { ...event, id: event.id, status: "open", madeTurn: frame.turn }); if (event.type === "commitment_resolution" && event.commitment_id) { const original = ledger.get(event.commitment_id); if (original) ledger.set(event.commitment_id, { ...original, status: event.resolution ?? "resolved", resolvedEvidence: event.evidence, resolvedTurn: frame.turn }); } }
  return [...ledger.values()];
}

function eventCategory(event: CourtEvent): Filter { if (event.type === "public_message") return "public"; if (event.type === "private_message") return "whispers"; if (event.type === "commitment" || event.type === "commitment_resolution") return "promises"; return "actions"; }

function eventEffect(event?: CourtEvent) {
  if (!event) return "quiet"; const type = String(event.action?.type ?? event.type);
  if (type === "assassinate" || type === "testify") return "murder"; if (type === "marriage_pact") return "pact"; if (type === "natural_death") return "death";
  if (type.includes("rumor") || type === "reveal_secret" || type === "learn_secret") return "secret"; if (type.includes("vote") || type.includes("veto") || type === "name_successor" || type === "disqualify") return "vote";
  if (type.includes("compact") || type.includes("guarantee")) return "compact"; if (event.type === "private_message") return "whisper"; if (event.type === "public_message") return "speech";
  if (event.type === "commitment_resolution" && event.resolution === "broken") return "broken"; if (event.type === "commitment" || event.type === "commitment_resolution") return "promise"; if (["bribe", "fund", "external_backing"].includes(type)) return "resource"; return "action";
}

function effectGlyph(event?: CourtEvent) { const effect = eventEffect(event); return ({ murder: "†", pact: "♥", death: "♱", secret: "◈", vote: "♜", compact: "⌘", whisper: "≈", speech: "“", broken: "×", promise: "◇", resource: "¤", action: "•", quiet: "·" } as Record<string, string>)[effect] ?? "•"; }

function describeEvent(event: CourtEvent, commitments: Map<string, LedgerEntry>) {
  const action = event.action ?? {}; const actionType = String(action.type ?? ""); const actor = event.actor ?? event.from ?? "Court record";
  if (event.type === "public_message") return { kicker: "Public court", title: `${pretty(actor)} addresses the hall`, detail: event.text ?? "No words recorded." };
  if (event.type === "private_message") return { kicker: "Private whisper", title: `${pretty(actor)} → ${pretty(event.to ?? "unknown")}`, detail: event.text ?? "No words recorded." };
  if (event.type === "commitment") return { kicker: `${pretty(event.kind ?? "promise")} · due T${event.deadline_turn}`, title: `${pretty(event.from ?? "unknown")} binds themself to ${pretty(event.to ?? "unknown")}`, detail: event.content ?? "Promise terms unavailable." };
  if (event.type === "commitment_resolution") { const original = event.commitment_id ? commitments.get(event.commitment_id) : undefined; return { kicker: `Engine verdict · ${event.resolution}`, title: `${event.commitment_id ?? "Promise"} is ${event.resolution}`, detail: event.evidence ?? original?.content ?? "Resolution recorded by the engine." }; }
  const target = stringField(action, "target") ?? stringField(action, "candidate") ?? stringField(action, "partner") ?? stringField(action, "against");
  const labels: Record<string, [string, string]> = {
    assassinate: ["Murder plot", `${pretty(actor)} moves against ${pretty(target ?? "an unnamed target")}`], marriage_pact: ["Bedchamber intrigue", `${pretty(actor)} seals a marriage pact with ${pretty(target ?? "a partner")}`],
    reveal_secret: ["Secret exposed", `${pretty(actor)} reveals ${pretty(target ?? "a rival")}'s secret`], spread_rumor: ["Rumor planted", `${pretty(actor)} poisons the hall against ${pretty(target ?? "a rival")}`], learn_secret: ["New intelligence", `${pretty(actor)} acquires leverage on ${pretty(target ?? "the court")}`],
    council_vote: ["Council vote", `${pretty(actor)} backs ${pretty(target ?? "a claimant")}`], veto_candidate: ["Claim vetoed", `${pretty(actor)} blocks ${pretty(target ?? "a claimant")}`], override_veto: ["Override coalition", `${pretty(actor)} challenges the veto on ${pretty(target ?? "a claimant")}`], veto_overridden: ["Veto broken", `The council restores ${pretty(target ?? "the claim")}`], veto_expired: ["Procedure closes", `The veto window on ${pretty(target ?? "the claim")} expires`],
    natural_death: ["The candle gutters", "The Monarch dies of natural causes"], testify: ["Silence broken", `${pretty(actor)} testifies against ${pretty(target ?? "a conspirator")}`], bribe: ["Coin changes hands", `${pretty(actor)} bribes ${pretty(target ?? "a courtier")}`], fund: ["Treasury opened", `${pretty(actor)} funds ${pretty(target ?? "an ally")}`],
    broker_compact: ["Compact proposed", `${pretty(actor)} brokers a council compact`], accept_compact: ["Compact accepted", `${pretty(actor)} joins a brokered coalition`], compact_activated: ["Coalition activated", "A brokered compact becomes binding"], compact_expired: ["Compact lapsed", "An unaccepted compact expires"], guarantee_commitment: ["Guarantee staked", `${pretty(actor)} underwrites another promise`], guarantee_settled: ["Guarantee settled", "The engine settles a guarantor's stake"],
    external_backing: ["Foreign backing", `${pretty(actor)} offers external force to ${pretty(target ?? "a claimant")}`], name_successor: ["Succession named", `${pretty(actor)} names ${pretty(target ?? "a claimant")}`], consecrate: ["Sacred sanction", `${pretty(actor)} consecrates ${pretty(target ?? "a claimant")}`], disqualify: ["Claim challenged", `${pretty(actor)} disqualifies ${pretty(target ?? "a claimant")}`], audit_rumor: ["Truth demanded", `${pretty(actor)} audits a rumor`], rumor_verdict: ["Engine verdict", "The court receives a ruling on the rumor"]
  };
  const [kicker, title] = labels[actionType] ?? [pretty(actionType || "action"), `${pretty(actor)} acts`]; const detail = Object.entries(action).filter(([key]) => key !== "type").map(([key, value]) => `${pretty(key)}: ${Array.isArray(value) ? value.map(String).join(", ") : String(value)}`).join(" · ") || "The action enters the public record.";
  return { kicker, title, detail };
}

function eventSeats(event?: CourtEvent, commitments?: Map<string, LedgerEntry>) {
  const seats = new Set<string>(); if (!event) return seats; for (const seat of [event.actor, event.from, event.to]) if (seat) seats.add(seat);
  for (const key of ["target", "candidate", "partner", "co_conspirator", "against", "party_a", "party_b"]) { const value = stringField(event.action, key); if (value) seats.add(value); }
  if (event.commitment_id && commitments?.has(event.commitment_id)) { const original = commitments.get(event.commitment_id); if (original?.from) seats.add(original.from); if (original?.to) seats.add(original.to); }
  return seats;
}

function eventRole(seat: string, event?: CourtEvent, commitments?: Map<string, LedgerEntry>): "actor" | "target" | "witness" {
  if (!event) return "witness"; const actor = event.actor ?? event.from; if (seat === actor) return "actor";
  const targets = new Set([event.to, stringField(event.action, "target"), stringField(event.action, "candidate"), stringField(event.action, "partner"), stringField(event.action, "against")]);
  if (event.commitment_id) { const commitment = commitments?.get(event.commitment_id); targets.add(commitment?.to); if (!actor && seat === commitment?.from) return "actor"; }
  return targets.has(seat) ? "target" : "witness";
}

function stringField(object: Record<string, unknown> | undefined, key: string) { const value = object?.[key]; return typeof value === "string" ? value : undefined; }
function pretty(value: string) { return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
