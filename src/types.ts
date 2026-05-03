export type Phase =
  | "LOBBY"
  | "INTERVIEW"
  | "BUILDING"
  | "PICKING"
  | "READING"
  | "OPEN"
  | "ANSWERING"
  | "JUDGING"
  | "RESOLVED"
  | "DD_WAGER"
  | "DD_ANSWERING"
  | "ROUND_BREAK"
  | "FINAL_WAGER"
  | "FINAL_READING"
  | "FINAL_ANSWERING"
  | "FINAL_REVEAL"
  | "GAME_OVER";

export type RoundIndex = 0 | 1; // 0 = Jeopardy, 1 = Double Jeopardy

export type GameTier =
  | "regular"
  | "kids"
  | "teen"
  | "college"
  | "celebrity"
  | "tournament";

export interface Clue {
  value: number;
  prompt: string;
  answer: string;
  dailyDouble?: boolean;
  // Set when the clue wasn't actually played on the original episode
  // (skipped for time, etc.). Server marks the cell as already-taken so it
  // shows greyed-out and isn't pickable.
  missing?: boolean;
}

export interface Category {
  title: string;
  clues: Clue[]; // length 5
}

export interface Round {
  categories: Category[]; // length 6
}

export interface FinalJeopardy {
  category: string;
  prompt: string;
  answer: string;
}

export interface GameDef {
  title: string;
  rounds: [Round, Round];
  final: FinalJeopardy;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  token: string; // rejoin token
}

export interface ClueRef {
  round: RoundIndex;
  cat: number; // 0..5
  idx: number; // 0..4
}

export interface FinalAnswerRecord {
  playerId: string;
  wager: number;
  transcript: string | null;
  correct: boolean | null;
}

export interface GameState {
  phase: Phase;
  round: RoundIndex;
  players: Player[];
  pickerId: string | null;
  // For each round, a 6x5 boolean grid of completed clues.
  taken: [boolean[][], boolean[][]];
  currentClue: ClueRef | null;
  buzzedPlayerId: string | null;
  attemptedPlayerIds: string[]; // players who already tried this clue
  // Daily double wager amount (active player), final wagers (per player)
  ddWager: number | null;
  finalWagers: Record<string, number>;
  finalAnswers: FinalAnswerRecord[];
  finalRevealIndex: number; // which player's final answer is currently revealed
  lastJudgement: {
    playerId: string;
    correct: boolean;
    transcript: string;
    riff: string | null;
  } | null;
  // Snapshot of the clue that the lastJudgement applies to. Stays alive
  // past the advance so retroactive overrides still find it.
  lastClueRef: ClueRef | null;
  // Custom-board interview state
  interviewQueue: string[]; // player ids in order
  interviewIdx: number;
  interviewTranscripts: Record<string, string>;
  interviewError: string | null;
}

// === Public-facing state (sanitized; never includes answers) ===

export interface PublicClueCell {
  value: number;
  taken: boolean;
  missing?: boolean; // skipped on the original episode — render greyed
}

export interface PublicCategory {
  title: string;
  cells: PublicClueCell[];
}

export interface PublicRound {
  categories: PublicCategory[];
}

export interface PublicState {
  phase: Phase;
  round: RoundIndex;
  players: Array<Pick<Player, "id" | "name" | "score" | "connected">>;
  pickerId: string | null;
  rounds: [PublicRound, PublicRound];
  finalCategory: string | null; // shown only during FINAL phases
  // Active clue context — prompt is sent during reading/answer phases.
  // Correct answer is ONLY included for the host display, after the clue resolves.
  currentClue: {
    round: RoundIndex;
    cat: number;
    idx: number;
    value: number;
    prompt: string;
    dailyDouble: boolean;
    revealedAnswer: string | null;
  } | null;
  buzzedPlayerId: string | null;
  ddWager: number | null;
  // Per-player final wager submission status (amounts hidden from peers)
  finalWagerSubmitted: Record<string, boolean>;
  finalReveal: {
    playerId: string;
    wager: number;
    transcript: string | null;
    correct: boolean | null;
  } | null;
  lastJudgement: GameState["lastJudgement"];
  gameTitle: string;
  // Interview/custom-board fields (only meaningful in INTERVIEW/BUILDING phase)
  interview: {
    currentPlayerId: string | null;
    submitted: Record<string, boolean>;
    error: string | null;
  };
}

// === Messages ===

export type ClientMessage =
  | { type: "host:hello" }
  | { type: "host:ttsDone"; tag: TtsTag }
  | { type: "host:start" }
  | { type: "host:pickQuestion"; cat: number; idx: number } // fallback when picker can't
  | { type: "host:override"; correct: boolean }
  | { type: "host:pass" }
  | { type: "host:nextRound" }
  | { type: "host:advance" }
  | { type: "host:revealNextFinal" }
  | { type: "host:endGame" }
  | { type: "host:resetGame"; reloadGame?: boolean; tier?: GameTier; airDate?: string }
  | { type: "host:kickPlayer"; playerId: string }
  | { type: "host:startInterview" }
  | { type: "host:skipInterviewPlayer" }
  | { type: "host:cancelInterview" }
  | { type: "player:join"; name: string; rejoinToken?: string }
  | { type: "player:buzz" }
  | { type: "player:answer"; audioBase64: string; mimeType: string }
  | { type: "player:pickVoice"; audioBase64: string; mimeType: string }
  | { type: "player:interview"; audioBase64: string; mimeType: string }
  | { type: "player:wager"; amount: number };

export type ServerMessage =
  | { type: "state"; state: PublicState }
  | { type: "joined"; playerId: string; rejoinToken: string }
  | { type: "tts"; url: string; tag: TtsTag }
  | { type: "ttsDone"; tag: TtsTag } // host -> server -> all
  | { type: "judging" }
  | { type: "error"; message: string }
  | { type: "youBuzzed" } // sent to buzzed player; phone should start recording
  | { type: "kicked"; reason: string };

export type TtsTag =
  | "intro"
  | "picker"
  | "clue"
  | "ddPrompt"
  | "judgement"
  | "final"
  | "roundEnd"
  | "gameOver";
