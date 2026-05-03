import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, emptyState, getClue, type Effect } from "./state.js";
import type { GameDef, Player } from "./types.js";

const tinyDef: GameDef = {
  title: "test",
  rounds: [
    {
      categories: Array.from({ length: 6 }, (_unused, c) => ({
        title: `Cat${c}`,
        clues: Array.from({ length: 5 }, (_x, i) => ({
          value: 200 * (i + 1),
          prompt: `R1 C${c} I${i} prompt`,
          answer: `r1c${c}i${i}`,
          dailyDouble: c === 1 && i === 2 ? true : undefined,
        })),
      })),
    },
    {
      categories: Array.from({ length: 6 }, (_unused, c) => ({
        title: `D${c}`,
        clues: Array.from({ length: 5 }, (_x, i) => ({
          value: 400 * (i + 1),
          prompt: `R2 C${c} I${i} prompt`,
          answer: `r2c${c}i${i}`,
        })),
      })),
    },
  ],
  final: {
    category: "Finals",
    prompt: "final prompt",
    answer: "final answer",
  },
};

const mkPlayer = (id: string, name: string): Player => ({
  id,
  name,
  score: 0,
  connected: true,
  token: `tok-${id}`,
});

const speakTexts = (effects: Effect[]): string[] =>
  effects.flatMap((e) => (e.type === "speak" ? [e.text] : []));

test("game cannot start with one player", () => {
  let s = emptyState();
  ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer("a", "A") }, tinyDef));
  const r = apply(s, { type: "startGame" }, tinyDef);
  assert.equal(r.state.phase, "LOBBY");
});

test("happy path: start, pick, read, buzz, correct → score and re-pick", () => {
  let s = emptyState();
  ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer("a", "Alice") }, tinyDef));
  ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer("b", "Bob") }, tinyDef));
  let res = apply(s, { type: "startGame" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "PICKING");
  assert.ok(s.pickerId);
  // Force picker for determinism
  s.pickerId = "a";

  res = apply(s, { type: "pickQuestion", playerId: "a", cat: 0, idx: 0 }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "READING");

  res = apply(s, { type: "ttsDone", tag: "clue" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "OPEN");

  res = apply(s, { type: "buzz", playerId: "b" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "ANSWERING");
  assert.equal(s.buzzedPlayerId, "b");

  res = apply(s, { type: "answerTranscribed", playerId: "b", transcript: "bla" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "JUDGING");
  // Effect should include a judge call
  assert.ok(res.effects.some((e) => e.type === "judge"));

  res = apply(s, { type: "judgement", correct: true, riff: null }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "RESOLVED");
  assert.equal(s.players.find((p) => p.id === "b")?.score, 200);
  assert.equal(s.taken[0][0]?.[0], true);

  res = apply(s, { type: "advance" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "PICKING");
  assert.equal(s.pickerId, "b");
});

test("wrong answer applies penalty and reopens to other players", () => {
  let s = emptyState();
  for (const id of ["a", "b", "c"])
    ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer(id, id) }, tinyDef));
  ({ state: s } = apply(s, { type: "startGame" }, tinyDef));
  s.pickerId = "a";
  ({ state: s } = apply(s, { type: "pickQuestion", playerId: "a", cat: 0, idx: 1 }, tinyDef));
  ({ state: s } = apply(s, { type: "ttsDone", tag: "clue" }, tinyDef));
  ({ state: s } = apply(s, { type: "buzz", playerId: "a" }, tinyDef));
  ({ state: s } = apply(s, { type: "answerTranscribed", playerId: "a", transcript: "x" }, tinyDef));
  ({ state: s } = apply(s, { type: "judgement", correct: false, riff: null }, tinyDef));
  assert.equal(s.phase, "OPEN");
  assert.deepEqual(s.attemptedPlayerIds, ["a"]);
  assert.equal(s.players.find((p) => p.id === "a")?.score, -400);

  // Player a tries to buzz again → ignored
  const tried = apply(s, { type: "buzz", playerId: "a" }, tinyDef);
  assert.equal(tried.state.phase, "OPEN");

  // b buzzes and gets it right
  ({ state: s } = apply(s, { type: "buzz", playerId: "b" }, tinyDef));
  ({ state: s } = apply(s, { type: "answerTranscribed", playerId: "b", transcript: "x" }, tinyDef));
  ({ state: s } = apply(s, { type: "judgement", correct: true, riff: null }, tinyDef));
  assert.equal(s.players.find((p) => p.id === "b")?.score, 400);
  assert.equal(s.pickerId, "b");
});

test("daily double routes through DD_WAGER then resolves immediately on wrong", () => {
  let s = emptyState();
  for (const id of ["a", "b"])
    ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer(id, id) }, tinyDef));
  ({ state: s } = apply(s, { type: "startGame" }, tinyDef));
  s.pickerId = "a";
  // Cat 1, idx 2 is a DD in our tiny def
  let res = apply(s, { type: "pickQuestion", playerId: "a", cat: 1, idx: 2 }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "DD_WAGER");
  res = apply(s, { type: "wager", playerId: "a", amount: 500 }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "DD_ANSWERING");
  assert.equal(s.ddWager, 500);

  res = apply(s, { type: "ttsDone", tag: "clue" }, tinyDef);
  s = res.state;
  // After clue read, state remains DD_ANSWERING (server prompts player); machine unchanged.
  assert.equal(s.phase, "DD_ANSWERING");

  res = apply(s, { type: "answerTranscribed", playerId: "a", transcript: "no" }, tinyDef);
  s = res.state;
  assert.equal(s.phase, "JUDGING");
  res = apply(s, { type: "judgement", correct: false, riff: null }, tinyDef);
  s = res.state;
  // DD wrong: -wager, no rebuzz, resolved
  assert.equal(s.phase, "RESOLVED");
  assert.equal(s.players.find((p) => p.id === "a")?.score, -500);
  assert.equal(s.taken[0][1]?.[2], true);
});

test("override flips a wrong ruling correctly", () => {
  let s = emptyState();
  for (const id of ["a", "b"])
    ({ state: s } = apply(s, { type: "addPlayer", player: mkPlayer(id, id) }, tinyDef));
  ({ state: s } = apply(s, { type: "startGame" }, tinyDef));
  s.pickerId = "a";
  ({ state: s } = apply(s, { type: "pickQuestion", playerId: "a", cat: 0, idx: 0 }, tinyDef));
  ({ state: s } = apply(s, { type: "ttsDone", tag: "clue" }, tinyDef));
  ({ state: s } = apply(s, { type: "buzz", playerId: "a" }, tinyDef));
  ({ state: s } = apply(s, { type: "answerTranscribed", playerId: "a", transcript: "x" }, tinyDef));
  ({ state: s } = apply(s, { type: "judgement", correct: false, riff: null }, tinyDef));
  // a is at -200 now; rebuzz window open. Override the prior false to true.
  ({ state: s } = apply(s, { type: "override", correct: true }, tinyDef));
  assert.equal(s.phase, "RESOLVED");
  assert.equal(s.players.find((p) => p.id === "a")?.score, 200);
  assert.equal(s.pickerId, "a");
});

test("getClue helper", () => {
  const c = getClue(tinyDef, { round: 0, cat: 0, idx: 0 });
  assert.equal(c.value, 200);
});
