export type Disposition = "machiavellian" | "coalition" | "neutral" | string;

export type CourtPlayer = {
  seat: string;
  agent_id: string;
  disposition: Disposition;
  disposition_prompt_id?: string;
  hidden_win_condition?: string;
  archetype?: string | null;
  archetype_brief?: Record<string, unknown> | null;
  generator_model?: string;
  reasoning_effort?: string;
};

export type CourtEvent = {
  type: string;
  from?: string;
  to?: string;
  actor?: string;
  text?: string;
  id?: string;
  commitment_id?: string;
  content?: string;
  kind?: string;
  deadline_turn?: number;
  resolution?: string;
  evidence?: string;
  action?: Record<string, unknown>;
};

export type CourtTurn = { turn: number; events: CourtEvent[] };

export type CourtEpisode = {
  episode_id: string;
  env: string;
  env_version?: string;
  generator_model?: string;
  created_at?: string;
  players: CourtPlayer[];
  turns: CourtTurn[];
  outcome?: {
    winner_seats?: string[];
    throne_winner?: string;
    win_type?: string;
    won_via_betrayal?: boolean;
    death_turn?: number;
    commitments_summary?: { per_seat?: Record<string, { made?: number; honored?: number; broken?: number }> };
    role_results?: Record<string, { won?: boolean; evidence?: string }>;
  };
};

export type Forecast = { event: string; probability: number; horizon_turn: number; evidence?: string };
export type CoalitionAssessment = { seat: string; trust: number; threat: number; leverage?: string; next_test?: string };

export type AgentDecision = {
  episode_id?: string;
  env?: string;
  seat: string;
  turn: number;
  phase?: string;
  model?: string;
  reasoning_effort?: string;
  disposition?: string;
  situation_summary?: string;
  rationale_summary?: string;
  evidence?: string[];
  forecasts?: Forecast[];
  coalition_assessment?: CoalitionAssessment[];
  counterfactuals?: Array<{ action: string; likely_outcome: string; upside?: number; risk?: number }>;
  public_message?: string;
  private_messages?: Array<{ to: string; text: string }>;
  commitments?: CourtEvent[];
  action?: Record<string, unknown>;
};

export type CourtReplay = {
  replay_version?: string;
  title?: string;
  note?: string;
  episode: CourtEpisode;
  decisions: AgentDecision[];
};

export type ReplayFrame = {
  id: string;
  globalIndex: number;
  turn: number;
  eventIndex: number;
  event: CourtEvent;
};
