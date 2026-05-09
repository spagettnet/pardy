import { client, hasLlm, modelId } from "./llm.js";

const MODEL = modelId(process.env.JUDGE_MODEL || "claude-haiku-4-5-20251001");

export interface JudgeInput {
  category: string;
  prompt: string;
  correctAnswer: string;
  transcribedGuess: string;
  isFinal?: boolean;
}

export interface JudgeResult {
  correct: boolean;
  reason: string;
  riff: string | null; // playful one-liner, optional
}

const SYSTEM = `You are an impartial Jeopardy! judge.

Given the clue, the canonical correct response, and a player's spoken guess (transcribed from speech-to-text, so expect mishearings), decide whether the guess should be accepted.

Acceptance rules — match TV show practice:
- Accept any correct response that unambiguously identifies the right answer.
- Be lenient on phrasing, articles, capitalization, partial names, common nicknames, and minor STT misspellings (e.g. "the godfather" == "godfather", "ada lovelace" == "lovelace" if the clue clearly cues her).
- Do NOT require "in the form of a question." Accept either form.
- Reject if the guess names a different specific entity.
- If the guess is empty, just filler, "I don't know", or unrelated, reject.

Style for "riff": one short playful sentence in the spirit of a TV host. Tease gently on wrong; congratulate briefly on right. Keep it under 12 words. Use null if nothing clever comes to mind.

CRITICAL — the riff is a JOKE, not a hint:
- It MUST NOT reveal the correct answer.
- It MUST NOT contain partial words, anagrams, definitions, or synonyms of the answer.
- It MUST NOT narrow the answer down (e.g. "think Italian Renaissance painter" or "starts with M").
- It MUST NOT refer to the answer's category, era, region, or other distinguishing facts.
- The other players are still trying to win the next clue. Anything you say to the buzzed-in player is heard by everyone — give nothing away.

Bad riff (gives info): "Close — think 19th century author."
Bad riff (says answer): "Nope, it's actually Shakespeare!"
Bad riff (synonym): "Sorry, the answer rhymes with 'bear'."
Good riff: "Nope, swing and a miss."
Good riff: "Boldly wrong, but I love the energy."
Good riff: "Tough one — better luck next time."
Good correct riff: "Nailed it!"
Good correct riff: "On the money."

When in doubt, return null instead of risking a leak.

Respond ONLY with the judgement tool call.`;

export async function judgeAnswer(input: JudgeInput): Promise<JudgeResult> {
  if (!hasLlm || !client) {
    // Fallback: dumb string match so dev works without any LLM key.
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(/\b(the|a|an|of)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const a = norm(input.correctAnswer);
    const b = norm(input.transcribedGuess);
    const correct = !!a && !!b && (b.includes(a) || a.includes(b));
    return {
      correct,
      reason: "fallback string match (no ANTHROPIC_API_KEY or OPENROUTER_API_KEY set)",
      riff: null,
    };
  }

  const userBlock = `Clue category: ${input.category}
Clue prompt: ${input.prompt}
Canonical correct response: ${input.correctAnswer}
Player's transcribed guess: ${JSON.stringify(input.transcribedGuess)}
${input.isFinal ? "(This is Final Jeopardy — be a touch stricter on identification but still tolerate STT noise.)" : ""}`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM,
    tool_choice: { type: "tool", name: "judgement" },
    tools: [
      {
        name: "judgement",
        description: "Return the ruling on a player's guess.",
        input_schema: {
          type: "object",
          properties: {
            correct: {
              type: "boolean",
              description: "True if the guess should be accepted.",
            },
            reason: {
              type: "string",
              description:
                "Brief internal explanation of the ruling (1 sentence).",
            },
            riff: {
              type: ["string", "null"],
              description:
                "Optional short host-style remark. Null if nothing fits. Must NOT reveal the correct answer when the guess is wrong.",
            },
          },
          required: ["correct", "reason"],
        },
      },
    ],
    messages: [{ role: "user", content: userBlock }],
  });

  const tool = resp.content.find(
    (c) => c.type === "tool_use" && c.name === "judgement",
  );
  if (!tool || tool.type !== "tool_use") {
    return {
      correct: false,
      reason: "judge returned no tool call",
      riff: null,
    };
  }
  const args = tool.input as {
    correct?: unknown;
    reason?: unknown;
    riff?: unknown;
  };
  return {
    correct: !!args.correct,
    reason: typeof args.reason === "string" ? args.reason : "",
    riff: typeof args.riff === "string" && args.riff.trim() ? args.riff : null,
  };
}

// === matchPick: map a spoken phrase like "Oscars 400" to a board cell ===

// === generateGameOverBanter: one-sentence host wrap-up at GAME_OVER ===

export interface GameOverContext {
  players: Array<{ name: string; score: number }>;
  finalCategory: string;
  finalAnswer: string;
}

const GAME_OVER_SYSTEM = `You are a Jeopardy!-style host wrapping up a game in ONE sentence.

Given the final scores and what happened in Final Jeopardy, deliver a single playful, broadcast-ready line that names the winner and acknowledges how the game actually ended. Examples of the *vibe*:

- "And what a finish — saved by Final Jeopardy, Nat takes it with $4,800!"
- "It's a runaway: Bob clears the table at $12,200 — see you tomorrow."
- "A two-hundred-dollar swing decides it — Carla edges out Alice for the win."
- "Alice held on through Final Jeopardy and walks away the champion."

Rules:
- Strictly ONE sentence.
- ≤ 22 words.
- Mention the winner by name and their final score.
- If it was close (winning margin < $1500), call it close.
- If it was a runaway (margin > $5000), call it a runaway.
- If everyone got Final wrong but the leader held on, mention that.
- If the leader changed because of Final, call it a comeback.
- Don't reveal the Final answer if anyone got it right (it's broadcast — they'd already know).
- Don't be saccharine or use the word "thrilling".

Return via the wrap_up tool.`;

export async function generateGameOverBanter(
  ctx: GameOverContext,
): Promise<string> {
  if (!hasLlm || !client) {
    // Fallback: simple winner announcement
    const sorted = [...ctx.players].sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    return winner
      ? `That's the game — ${winner.name} wins with $${winner.score}.`
      : "That's the game.";
  }
  const sorted = [...ctx.players].sort((a, b) => b.score - a.score);
  const userBlock = `Final scores (descending):
${sorted.map((p) => `- ${p.name}: $${p.score}`).join("\n")}

Final Jeopardy category: ${ctx.finalCategory}
Final Jeopardy correct answer: ${ctx.finalAnswer}

Wrap up the game in one sentence.`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: GAME_OVER_SYSTEM,
      tool_choice: { type: "tool", name: "wrap_up" },
      tools: [
        {
          name: "wrap_up",
          description: "Return the one-sentence wrap-up.",
          input_schema: {
            type: "object",
            properties: {
              line: { type: "string" },
            },
            required: ["line"],
          },
        },
      ],
      messages: [{ role: "user", content: userBlock }],
    });
    const tool = resp.content.find(
      (c) => c.type === "tool_use" && c.name === "wrap_up",
    );
    if (tool && tool.type === "tool_use") {
      const args = tool.input as { line?: unknown };
      if (typeof args.line === "string" && args.line.trim()) {
        return args.line.trim();
      }
    }
  } catch (err) {
    console.error("[banter] failed:", err);
  }
  // Same fallback as no-key path.
  const winner = sorted[0];
  return winner
    ? `That's the game — ${winner.name} wins with $${winner.score}.`
    : "That's the game.";
}

export interface BoardCell {
  cat: number; // 0..5
  idx: number; // 0..4
  category: string;
  value: number;
}

export interface MatchPickResult {
  cat: number | null;
  idx: number | null;
  reason: string;
}

const PICK_SYSTEM = `You map a Jeopardy contestant's spoken pick (transcribed from speech) to a specific board cell.

You will receive:
- The phrase the player said.
- The list of currently-available cells, each with (cat, idx, category title, dollar value).

The player typically says a category name (or fragment) plus a dollar amount.

CRITICAL: PEOPLE USE SHORTHAND FOR DOLLAR VALUES. Always interpret numbers as the closest available cell value. Common shortcuts:
- "16" or "sixteen" almost always means 1600 (in round 2). It does NOT mean $16.
- "8" or "eight" almost always means 800.
- "12" almost always means 1200.
- "two" or "2" usually means 200.
- "four" or "4" usually means 400.
- "for ten" / "ten" → 1000 (or 100 only if 1000 isn't available).
- "for the thousand" → 1000.
- "two grand" → 2000.

Rule of thumb: if the spoken number is small (1-20), it is shorthand. Map it to the nearest standard board value (200/400/600/800/1000 in round 1; 400/800/1200/1600/2000 in round 2). Multiply by 100 if needed.

The player may also drop the dollar amount entirely (just say a category) — if only one cell remains in that category, pick it; otherwise pick the highest-value remaining cell in that category.

Be lenient on STT noise: "oscar's" vs "oscars", partial category titles ("history" matches "World History"), plural mismatches, filler words ("uh", "let's go with"), the word "for".

Strict rules:
- Only choose from the provided available cells.
- Prefer cells where both the category AND a sensibly-interpreted value match.
- If the literal small number doesn't appear as a cell value but its ×100 does, USE THE ×100 INTERPRETATION. Do not refuse to map "16" just because no cell costs $16.
- If truly nothing matches (e.g. random unrelated speech), return cat=null, idx=null with a brief reason.

Respond ONLY with the matchPick tool call.`;

export async function matchPick(
  transcript: string,
  available: BoardCell[],
): Promise<MatchPickResult> {
  if (!transcript.trim() || available.length === 0) {
    return { cat: null, idx: null, reason: "empty input" };
  }

  if (!hasLlm || !client) {
    return naiveMatch(transcript, available);
  }

  try {
    const userBlock = `Player said: ${JSON.stringify(transcript)}

Available cells:
${available.map((c) => `- cat=${c.cat} idx=${c.idx}: "${c.category}" for $${c.value}`).join("\n")}`;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: PICK_SYSTEM,
      tool_choice: { type: "tool", name: "matchPick" },
      tools: [
        {
          name: "matchPick",
          description: "Return the cell the player picked, or null if unclear.",
          input_schema: {
            type: "object",
            properties: {
              cat: {
                type: ["integer", "null"],
                description: "Category index (0..5) of the chosen cell, or null if no clear match.",
              },
              idx: {
                type: ["integer", "null"],
                description: "Row index (0..4) of the chosen cell, or null if no clear match.",
              },
              reason: {
                type: "string",
                description: "Short explanation of the choice (or why nothing matched).",
              },
            },
            required: ["cat", "idx", "reason"],
          },
        },
      ],
      messages: [{ role: "user", content: userBlock }],
    });

    const tool = resp.content.find(
      (c) => c.type === "tool_use" && c.name === "matchPick",
    );
    if (!tool || tool.type !== "tool_use") {
      return naiveMatch(transcript, available);
    }
    const args = tool.input as { cat?: unknown; idx?: unknown; reason?: unknown };
    const cat = typeof args.cat === "number" ? args.cat : null;
    const idx = typeof args.idx === "number" ? args.idx : null;
    const reason = typeof args.reason === "string" ? args.reason : "";
    // Validate: must be one of the available cells.
    if (cat !== null && idx !== null) {
      const ok = available.some((c) => c.cat === cat && c.idx === idx);
      if (!ok) return { cat: null, idx: null, reason: `model returned unavailable cell (${reason})` };
    }
    return { cat, idx, reason };
  } catch (err) {
    return naiveMatch(transcript, available);
  }
}

function naiveMatch(transcript: string, available: BoardCell[]): MatchPickResult {
  // Fallback: pull the dollar amount and a category fragment.
  const t = transcript.toLowerCase();
  const dollarMatch = t.match(/(\d{2,4})/);
  const value = dollarMatch ? parseInt(dollarMatch[1]!, 10) : null;
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const tn = norm(t);

  let best: { cat: number; idx: number; score: number } | null = null;
  for (const c of available) {
    const cn = norm(c.category);
    let score = 0;
    if (value !== null && c.value === value) score += 5;
    // Token overlap on category title.
    const tokens = cn.split(" ").filter((w) => w.length > 2);
    for (const tok of tokens) {
      if (tn.includes(tok)) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { cat: c.cat, idx: c.idx, score };
    }
  }
  if (!best) return { cat: null, idx: null, reason: "no fallback match" };
  return { cat: best.cat, idx: best.idx, reason: `naive match score=${best.score}` };
}
