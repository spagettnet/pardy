import type {
  Clue,
  ClueRef,
  GameDef,
  GameState,
  Player,
  RoundIndex,
  TtsTag,
} from "./types.js";

export type StateEvent =
  | { type: "addPlayer"; player: Player }
  | { type: "removePlayer"; playerId: string }
  | { type: "setConnected"; playerId: string; connected: boolean }
  | { type: "startGame" }
  | { type: "resetGame" } // back to LOBBY, clear scores + board, keep players
  | { type: "matchPickFailed"; playerId: string; transcript: string; reason: string }
  | { type: "pickQuestion"; playerId: string; cat: number; idx: number }
  | { type: "ttsDone"; tag: TtsTag }
  | { type: "buzz"; playerId: string }
  | { type: "answerTranscribed"; playerId: string; transcript: string }
  | { type: "judgement"; correct: boolean; riff: string | null }
  | { type: "buzzTimeout" } // open window expired w/ no buzz
  | { type: "answerTimeout"; playerId: string } // buzzed player didn't speak
  | { type: "override"; correct: boolean }
  | { type: "pass" } // host: nobody got it / move on
  | { type: "advance" } // generic advance from RESOLVED/ROUND_BREAK/FINAL_REVEAL
  | { type: "wager"; playerId: string; amount: number }
  | { type: "finalAnswerTranscribed"; playerId: string; transcript: string }
  | { type: "finalJudgement"; playerId: string; correct: boolean }
  | { type: "revealNextFinal" }
  | { type: "endGame" };

export type Effect =
  | { type: "speak"; tag: TtsTag; text: string }
  | { type: "broadcast" } // always emitted; server uses to push public state
  | { type: "openBuzzWindow" }
  | { type: "startAnswerWindow"; playerId: string }
  | { type: "startFinalAnswerWindow" }
  | { type: "judge"; clue: Clue; transcript: string; playerId: string }
  | { type: "judgeFinal"; clue: Clue; transcript: string; playerId: string }
  | { type: "promptPlayerToBuzz"; playerId: string };

export function emptyState(): GameState {
  const grid = (): boolean[][] =>
    Array.from({ length: 6 }, () => Array.from({ length: 5 }, () => false));
  return {
    phase: "LOBBY",
    round: 0,
    players: [],
    pickerId: null,
    taken: [grid(), grid()],
    currentClue: null,
    buzzedPlayerId: null,
    attemptedPlayerIds: [],
    ddWager: null,
    finalWagers: {},
    finalAnswers: [],
    finalRevealIndex: 0,
    lastJudgement: null,
    lastClueRef: null,
  };
}

export function getClue(def: GameDef, ref: ClueRef): Clue {
  const cat = def.rounds[ref.round].categories[ref.cat];
  if (!cat) throw new Error(`bad category ${ref.cat}`);
  const clue = cat.clues[ref.idx];
  if (!clue) throw new Error(`bad clue ${ref.idx}`);
  return clue;
}

function allCluesTaken(state: GameState, round: RoundIndex): boolean {
  const grid = state.taken[round];
  return grid.every((col) => col.every(Boolean));
}

function pickRandomFirstPlayer(players: Player[]): string | null {
  if (players.length === 0) return null;
  const idx = Math.floor(Math.random() * players.length);
  return players[idx]!.id;
}

function eligibleBuzzers(state: GameState): Player[] {
  return state.players.filter(
    (p) => p.connected && !state.attemptedPlayerIds.includes(p.id),
  );
}

function maxDailyDoubleWager(player: Player, round: RoundIndex): number {
  // Standard: at least max clue value of round, or your score, whichever is greater.
  const minMax = round === 0 ? 1000 : 2000;
  return Math.max(minMax, player.score);
}

export function maxFinalWager(player: Player): number {
  return Math.max(0, player.score);
}

function findPlayer(state: GameState, id: string): Player | undefined {
  return state.players.find((p) => p.id === id);
}

function adjustScore(state: GameState, playerId: string, delta: number): void {
  const p = findPlayer(state, playerId);
  if (p) p.score += delta;
}

export interface ApplyResult {
  state: GameState;
  effects: Effect[];
}

export function apply(
  prev: GameState,
  event: StateEvent,
  def: GameDef,
): ApplyResult {
  // structuredClone to keep apply pure-ish (we still mutate the clone freely below).
  const state: GameState = structuredClone(prev);
  const effects: Effect[] = [];

  switch (event.type) {
    case "addPlayer": {
      if (state.phase !== "LOBBY") {
        // Allow late joiners; they get $0 and can't pick until eligible.
      }
      if (state.players.find((p) => p.id === event.player.id)) break;
      state.players.push(event.player);
      break;
    }
    case "removePlayer": {
      state.players = state.players.filter((p) => p.id !== event.playerId);
      if (state.pickerId === event.playerId) {
        state.pickerId = pickRandomFirstPlayer(state.players);
      }
      break;
    }
    case "setConnected": {
      const p = findPlayer(state, event.playerId);
      if (p) p.connected = event.connected;
      break;
    }
    case "startGame": {
      if (state.phase !== "LOBBY") break;
      if (state.players.length < 2) break;
      state.phase = "PICKING";
      state.round = 0;
      state.pickerId = pickRandomFirstPlayer(state.players);
      const picker = findPlayer(state, state.pickerId!);
      effects.push({
        type: "speak",
        tag: "intro",
        text: `Welcome to ${def.title}. ${picker?.name ?? "First player"}, you're up. Pick a category and a dollar amount.`,
      });
      break;
    }
    case "pickQuestion": {
      if (state.phase !== "PICKING") break;
      if (state.pickerId !== event.playerId) break;
      if (state.taken[state.round][event.cat]?.[event.idx]) break;
      const ref: ClueRef = {
        round: state.round,
        cat: event.cat,
        idx: event.idx,
      };
      const clue = getClue(def, ref);
      state.currentClue = ref;
      state.attemptedPlayerIds = [];
      state.lastJudgement = null;
      state.lastClueRef = null;
      state.buzzedPlayerId = null;

      if (clue.dailyDouble) {
        state.phase = "DD_WAGER";
        const picker = findPlayer(state, state.pickerId!);
        effects.push({
          type: "speak",
          tag: "ddPrompt",
          text: `Daily Double! ${picker?.name ?? "Player"}, place your wager.`,
        });
      } else {
        state.phase = "READING";
        const cat = def.rounds[state.round].categories[event.cat]!;
        effects.push({
          type: "speak",
          tag: "clue",
          text: `${cat.title} for $${clue.value}. ${clue.prompt}`,
        });
      }
      break;
    }
    case "wager": {
      if (state.phase === "DD_WAGER") {
        if (state.pickerId !== event.playerId) break;
        const picker = findPlayer(state, event.playerId);
        if (!picker) break;
        const max = maxDailyDoubleWager(picker, state.round);
        const amount = Math.max(5, Math.min(max, Math.floor(event.amount)));
        state.ddWager = amount;
        state.phase = "DD_ANSWERING";
        const ref = state.currentClue!;
        const clue = getClue(def, ref);
        const cat = def.rounds[ref.round].categories[ref.cat]!;
        effects.push({
          type: "speak",
          tag: "clue",
          text: `${cat.title}, for $${amount}. ${clue.prompt}`,
        });
      } else if (state.phase === "FINAL_WAGER") {
        const p = findPlayer(state, event.playerId);
        if (!p) break;
        const max = maxFinalWager(p);
        const amount = Math.max(0, Math.min(max, Math.floor(event.amount)));
        state.finalWagers[event.playerId] = amount;
        // If all eligible players (score > 0) have wagered, advance.
        const eligible = state.players.filter((pl) => pl.score > 0);
        if (eligible.every((pl) => state.finalWagers[pl.id] !== undefined)) {
          state.phase = "FINAL_READING";
          effects.push({
            type: "speak",
            tag: "final",
            text: `In the category ${def.final.category}, the final clue is. ${def.final.prompt}. Players, record your responses now.`,
          });
        }
      }
      break;
    }
    case "ttsDone": {
      if (state.phase === "READING" && event.tag === "clue") {
        state.phase = "OPEN";
        effects.push({ type: "openBuzzWindow" });
      } else if (state.phase === "DD_ANSWERING" && event.tag === "clue") {
        // After DD prompt, the picker has the floor.
        const picker = state.pickerId!;
        state.buzzedPlayerId = picker;
        effects.push({ type: "startAnswerWindow", playerId: picker });
        effects.push({ type: "promptPlayerToBuzz", playerId: picker });
      } else if (state.phase === "FINAL_READING" && event.tag === "final") {
        state.phase = "FINAL_ANSWERING";
        effects.push({ type: "startFinalAnswerWindow" });
      } else if (state.phase === "RESOLVED" && event.tag === "judgement") {
        // Auto-advance after the judgement is read aloud. Recurse so the
        // existing advance() logic (round transitions, picker prompts, etc.)
        // runs verbatim.
        return apply(state, { type: "advance" }, def);
      } else if (state.phase === "ROUND_BREAK" && event.tag === "roundEnd") {
        // Auto-advance through the round break too.
        return apply(state, { type: "advance" }, def);
      }
      // intro/picker/gameOver TTS done is informational only.
      break;
    }
    case "buzz": {
      if (state.phase !== "OPEN") break;
      if (state.attemptedPlayerIds.includes(event.playerId)) break;
      if (!findPlayer(state, event.playerId)?.connected) break;
      state.buzzedPlayerId = event.playerId;
      state.phase = "ANSWERING";
      effects.push({ type: "startAnswerWindow", playerId: event.playerId });
      break;
    }
    case "answerTranscribed": {
      if (
        (state.phase === "ANSWERING" || state.phase === "DD_ANSWERING") &&
        state.buzzedPlayerId === event.playerId &&
        state.currentClue
      ) {
        const clue = getClue(def, state.currentClue);
        state.phase = "JUDGING";
        effects.push({
          type: "judge",
          clue,
          transcript: event.transcript,
          playerId: event.playerId,
        });
      }
      break;
    }
    case "judgement": {
      if (state.phase !== "JUDGING") break;
      const playerId = state.buzzedPlayerId!;
      const clue = getClue(def, state.currentClue!);
      const isDD = !!clue.dailyDouble;
      const wager = isDD ? state.ddWager ?? 0 : clue.value;
      const player = findPlayer(state, playerId)!;
      state.lastJudgement = {
        playerId,
        correct: event.correct,
        transcript: "",
        riff: event.riff,
      };
      state.lastClueRef = state.currentClue;
      if (event.correct) {
        adjustScore(state, playerId, wager);
        state.taken[state.currentClue!.round][state.currentClue!.cat]![
          state.currentClue!.idx
        ] = true;
        state.pickerId = playerId;
        state.phase = "RESOLVED";
        effects.push({
          type: "speak",
          tag: "judgement",
          text: `Correct, ${player.name}!${event.riff ? ` ${event.riff}` : ""} You're up to $${player.score}.`,
        });
      } else {
        if (isDD) {
          adjustScore(state, playerId, -wager);
        } else {
          adjustScore(state, playerId, -clue.value);
        }
        state.attemptedPlayerIds.push(playerId);
        if (isDD) {
          // DD: no rebuzz. Reveal answer and resolve.
          state.taken[state.currentClue!.round][state.currentClue!.cat]![
            state.currentClue!.idx
          ] = true;
          state.phase = "RESOLVED";
          effects.push({
            type: "speak",
            tag: "judgement",
            text: `Sorry, that's wrong.${event.riff ? ` ${event.riff}` : ""} The correct answer was ${clue.answer}.`,
          });
        } else {
          state.buzzedPlayerId = null;
          // If anyone left to attempt, reopen buzz; else resolve.
          const remaining = eligibleBuzzers(state);
          if (remaining.length === 0) {
            state.taken[state.currentClue!.round][state.currentClue!.cat]![
              state.currentClue!.idx
            ] = true;
            state.phase = "RESOLVED";
            effects.push({
              type: "speak",
              tag: "judgement",
              text: `No takers. The correct answer was ${clue.answer}.`,
            });
          } else {
            state.phase = "OPEN";
            effects.push({
              type: "speak",
              tag: "judgement",
              text: `Nope.${event.riff ? ` ${event.riff}` : ""} Anyone else?`,
            });
            effects.push({ type: "openBuzzWindow" });
          }
        }
      }
      break;
    }
    case "buzzTimeout": {
      if (state.phase !== "OPEN") break;
      if (!state.currentClue) break;
      const clue = getClue(def, state.currentClue);
      state.taken[state.currentClue.round][state.currentClue.cat]![
        state.currentClue.idx
      ] = true;
      state.phase = "RESOLVED";
      effects.push({
        type: "speak",
        tag: "judgement",
        text: `Time. The answer was ${clue.answer}.`,
      });
      break;
    }
    case "answerTimeout": {
      if (
        (state.phase !== "ANSWERING" && state.phase !== "DD_ANSWERING") ||
        state.buzzedPlayerId !== event.playerId
      )
        break;
      // Treat timeout as wrong.
      return apply(
        state,
        { type: "judgement", correct: false, riff: null },
        def,
      );
    }
    case "override": {
      // Override flips the most recent ruling. Allowed any time we still
      // have a lastJudgement + lastClueRef snapshot — works retroactively
      // even after we've auto-advanced to PICKING.
      const last = state.lastJudgement;
      const ref = state.lastClueRef;
      if (!last || !ref) break;
      if (last.correct === event.correct) break;
      const clue = getClue(def, ref);
      const isDD = !!clue.dailyDouble;
      const wager = isDD ? state.ddWager ?? 0 : clue.value;
      // Reverse previous score change.
      if (last.correct) {
        adjustScore(state, last.playerId, -wager);
      } else {
        adjustScore(state, last.playerId, isDD ? +wager : +clue.value);
      }
      // Apply new ruling.
      if (event.correct) {
        adjustScore(state, last.playerId, +wager);
        state.pickerId = last.playerId;
        state.taken[ref.round][ref.cat]![ref.idx] = true;
        state.attemptedPlayerIds = state.attemptedPlayerIds.filter(
          (id) => id !== last.playerId,
        );
      } else {
        adjustScore(state, last.playerId, isDD ? -wager : -clue.value);
      }
      last.correct = event.correct;
      // If we have a currentClue, the clue is still in flight on the host
      // screen — force RESOLVED so the host UI shows the corrected outcome.
      // If currentClue is null, we've already auto-advanced — the override
      // is purely a score/picker correction; leave the phase alone.
      if (state.currentClue) {
        state.phase = "RESOLVED";
      }
      const player = findPlayer(state, last.playerId)!;
      effects.push({
        type: "speak",
        tag: "judgement",
        text: event.correct
          ? `Override — ruling reversed. ${player.name}, you're correct.`
          : `Override — ruling reversed. That's incorrect.`,
      });
      break;
    }
    case "pass": {
      if (state.phase === "OPEN" || state.phase === "ANSWERING") {
        if (!state.currentClue) break;
        const clue = getClue(def, state.currentClue);
        state.taken[state.currentClue.round][state.currentClue.cat]![
          state.currentClue.idx
        ] = true;
        state.phase = "RESOLVED";
        effects.push({
          type: "speak",
          tag: "judgement",
          text: `Moving on. The answer was ${clue.answer}.`,
        });
      }
      break;
    }
    case "advance": {
      if (state.phase === "RESOLVED") {
        // Check round completion.
        if (allCluesTaken(state, state.round)) {
          if (state.round === 0) {
            state.round = 1;
            state.phase = "ROUND_BREAK";
            effects.push({
              type: "speak",
              tag: "roundEnd",
              text: `That's the end of the Jeopardy round. On to Double Jeopardy.`,
            });
          } else {
            // Move to Final Jeopardy
            state.phase = "FINAL_WAGER";
            state.finalWagers = {};
            effects.push({
              type: "speak",
              tag: "final",
              text: `And now, Final Jeopardy. The category is ${def.final.category}. Players with positive scores, place your wagers.`,
            });
          }
        } else {
          state.phase = "PICKING";
          state.currentClue = null;
          state.buzzedPlayerId = null;
          state.attemptedPlayerIds = [];
          state.ddWager = null;
          const picker = findPlayer(state, state.pickerId ?? "");
          if (picker) {
            effects.push({
              type: "speak",
              tag: "picker",
              text: `${picker.name}, pick again.`,
            });
          }
        }
      } else if (state.phase === "ROUND_BREAK") {
        state.phase = "PICKING";
        state.currentClue = null;
        state.buzzedPlayerId = null;
        state.attemptedPlayerIds = [];
        // Picker remains: typically last correct from prior round (or trailing player in TV show).
        if (!state.pickerId)
          state.pickerId = pickRandomFirstPlayer(state.players);
        const picker = findPlayer(state, state.pickerId!);
        if (picker) {
          effects.push({
            type: "speak",
            tag: "picker",
            text: `${picker.name}, you have the board.`,
          });
        }
      }
      break;
    }
    case "finalAnswerTranscribed": {
      if (state.phase !== "FINAL_ANSWERING") break;
      // Record into finalAnswers (no judgement yet).
      const existing = state.finalAnswers.find(
        (a) => a.playerId === event.playerId,
      );
      const wager = state.finalWagers[event.playerId] ?? 0;
      if (existing) {
        existing.transcript = event.transcript;
      } else {
        state.finalAnswers.push({
          playerId: event.playerId,
          wager,
          transcript: event.transcript,
          correct: null,
        });
      }
      // Trigger judging for this player asynchronously via effect.
      const clue: Clue = {
        value: wager,
        prompt: def.final.prompt,
        answer: def.final.answer,
      };
      effects.push({
        type: "judgeFinal",
        clue,
        transcript: event.transcript,
        playerId: event.playerId,
      });
      // If every eligible player has submitted, transition once all have judged.
      // (Phase change happens in finalJudgement once all are judged.)
      break;
    }
    case "finalJudgement": {
      const rec = state.finalAnswers.find(
        (a) => a.playerId === event.playerId,
      );
      if (!rec) break;
      rec.correct = event.correct;
      // Once every eligible player has been judged, move to FINAL_REVEAL.
      const eligible = state.players.filter(
        (p) => state.finalWagers[p.id] !== undefined,
      );
      const allJudged = eligible.every(
        (p) =>
          state.finalAnswers.find((a) => a.playerId === p.id)?.correct !== null,
      );
      if (allJudged && state.phase !== "FINAL_REVEAL") {
        state.phase = "FINAL_REVEAL";
        state.finalRevealIndex = 0;
      }
      break;
    }
    case "revealNextFinal": {
      if (state.phase !== "FINAL_REVEAL") break;
      const idx = state.finalRevealIndex;
      const rec = state.finalAnswers[idx];
      if (rec) {
        const delta = rec.correct ? +rec.wager : -rec.wager;
        adjustScore(state, rec.playerId, delta);
        const player = findPlayer(state, rec.playerId)!;
        effects.push({
          type: "speak",
          tag: "judgement",
          text: rec.correct
            ? `${player.name} said: ${rec.transcript ?? "no answer"}. Correct! ${delta >= 0 ? "Plus" : "Minus"} $${Math.abs(delta)}.`
            : `${player.name} said: ${rec.transcript ?? "no answer"}. Incorrect. The correct answer was ${def.final.answer}. Minus $${Math.abs(delta)}.`,
        });
      }
      state.finalRevealIndex += 1;
      if (state.finalRevealIndex >= state.finalAnswers.length) {
        state.phase = "GAME_OVER";
        const winner = [...state.players].sort((a, b) => b.score - a.score)[0];
        if (winner) {
          effects.push({
            type: "speak",
            tag: "gameOver",
            text: `That's the game! Your winner is ${winner.name} with $${winner.score}.`,
          });
        }
      }
      break;
    }
    case "endGame": {
      state.phase = "GAME_OVER";
      break;
    }
    case "resetGame": {
      // Back to lobby. Keep the player list but reset scores and board state.
      const players = state.players.map((p) => ({
        ...p,
        score: 0,
      }));
      const fresh = emptyState();
      fresh.players = players;
      return { state: fresh, effects: [{ type: "broadcast" }] };
    }
    case "matchPickFailed": {
      // Picker's voice didn't map to a cell — keep the phase, just log the
      // transcript so the host UI can surface it. We piggy-back on
      // lastJudgement.transcript only if we have one; otherwise just
      // re-broadcast and let the server send an error toast.
      // (Server is responsible for sending {type:'error'} to that player.)
      break;
    }
  }

  effects.push({ type: "broadcast" });
  return { state, effects };
}

export function publicView(
  state: GameState,
  def: GameDef,
): import("./types.js").PublicState {
  const buildRound = (r: RoundIndex): import("./types.js").PublicRound => ({
    categories: def.rounds[r].categories.map((c, ci) => ({
      title: c.title,
      cells: c.clues.map((clue, idx) => ({
        value: clue.value,
        taken: state.taken[r][ci]?.[idx] ?? false,
        missing: clue.missing,
      })),
    })),
  });
  const cc = state.currentClue;
  const showAnswer = state.phase === "RESOLVED" || state.phase === "FINAL_REVEAL";
  return {
    phase: state.phase,
    round: state.round,
    players: state.players.map(({ id, name, score, connected }) => ({
      id,
      name,
      score,
      connected,
    })),
    pickerId: state.pickerId,
    rounds: [buildRound(0), buildRound(1)],
    finalCategory:
      state.phase.startsWith("FINAL") || state.phase === "GAME_OVER"
        ? def.final.category
        : null,
    currentClue: cc
      ? {
          round: cc.round,
          cat: cc.cat,
          idx: cc.idx,
          value: getClue(def, cc).value,
          prompt:
            state.phase === "PICKING" || state.phase === "DD_WAGER"
              ? ""
              : getClue(def, cc).prompt,
          dailyDouble: !!getClue(def, cc).dailyDouble,
          revealedAnswer: showAnswer ? getClue(def, cc).answer : null,
        }
      : null,
    buzzedPlayerId: state.buzzedPlayerId,
    ddWager: state.ddWager,
    finalWagerSubmitted: Object.fromEntries(
      Object.keys(state.finalWagers).map((k) => [k, true]),
    ),
    finalReveal:
      state.phase === "FINAL_REVEAL" || state.phase === "GAME_OVER"
        ? (() => {
            const rec = state.finalAnswers[
              Math.max(0, state.finalRevealIndex - 1)
            ];
            return rec
              ? {
                  playerId: rec.playerId,
                  wager: rec.wager,
                  transcript: rec.transcript,
                  correct: rec.correct,
                }
              : null;
          })()
        : null,
    lastJudgement: state.lastJudgement,
    gameTitle: def.title,
  };
}
