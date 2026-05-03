/**
 * Custom-board generator. One big Opus 4.7 call with web_search + a custom
 * tool for structured output.
 *
 * Input: each player's interview transcript ("what I'm good at + why").
 * Output: a complete GameDef — 6×5 round 1, 6×5 round 2, plus Final Jeopardy.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Category, Clue, FinalJeopardy, GameDef, Round } from "./types.js";
import {
  client,
  hasLlm,
  modelWithWebSearch,
  supportsServerTools,
  describeBackend,
} from "./llm.js";

const BASE_MODEL = process.env.BOARD_MODEL || "claude-opus-4-7";

export interface PlayerProfile {
  name: string;
  transcript: string;
}

const SYSTEM = `You are the producer of a custom Jeopardy! board for a small house party. The host has just interviewed each player about what they know best.

Your job: build a 6×5 Jeopardy round + 6×5 Double Jeopardy round + Final Jeopardy that is *tailored* to these specific players. Each player should hit categories where they shine and a category where they're stretched.

Use the web_search tool aggressively. Do not invent facts. Whenever a clue depends on a specific date, name, score, lyric, location, or numerical fact, search to verify. You have a generous research budget — be thorough.

Style rules (match TV show practice):
- Categories should be short, punchy, sometimes punny ("PRESIDENTIAL POTPOURRI", "POP MUSIC OF THE 2010s", "BOB'S BEAT", "CODE & CODERS").
- Each clue's PROMPT is what the host reads. The ANSWER is the correct response — do NOT phrase it as a question. ("Albert Einstein", not "Who is Albert Einstein?")
- Difficulty escalates within each category from $200 (easy entry-level for the targeted player) up to $1000 (a genuine stumper from their domain). Round 2 escalates from $400 to $2000 with the same shape.
- Avoid clues that depend on visual or audio media — text-only.
- Avoid clues whose answers are common to multiple plausible items unless the prompt narrows it cleanly.
- Final Jeopardy should be broadly known but tricky — something at least one player has a shot at.

Coverage rules:
- For a 2-player party: each player gets 4 of 6 categories tilted in their favor in round 1, the rest mixed.
- For 3+ players: each player should be the primary target of at least 2 categories total across both rounds.
- Always include 1-2 categories that play to *shared* interests (themes mentioned by multiple players, or universal pop-culture references).
- Avoid categories that no player would have any hook into.

Some categories may explicitly name a player ("BOB'S CHILDHOOD" — for clues about places/people Bob mentioned), but most should not.

Once you've finished researching, call the generate_board tool with the complete board. Do not output any other text after the tool call. The tool call is the deliverable.`;

const categorySchema = {
  type: "object" as const,
  properties: {
    title: {
      type: "string" as const,
      description: "Category title — short, all-caps preferred.",
    },
    targetedPlayer: {
      type: ["string", "null"] as const,
      description:
        "Name of the player this category is tailored toward, or null if shared/general. Use the exact name as provided.",
    },
    clues: {
      type: "array" as const,
      minItems: 5,
      maxItems: 5,
      items: {
        type: "object" as const,
        properties: {
          prompt: {
            type: "string" as const,
            description:
              "What the host reads aloud. State the clue, do not phrase as a question.",
          },
          answer: {
            type: "string" as const,
            description:
              "The single correct response (e.g. 'Albert Einstein', 'The Pacific Ocean', '1969'). NOT phrased as a question.",
          },
        },
        required: ["prompt", "answer"],
      },
    },
  },
  required: ["title", "clues"],
};

const GENERATE_BOARD_TOOL = {
  name: "generate_board",
  description:
    "Emit the complete custom Jeopardy board. Call this exactly once after research is done.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string" as const,
        description:
          "Game title — playful, references the players' interests if possible (≤ 60 chars).",
      },
      round1: {
        type: "array" as const,
        minItems: 6,
        maxItems: 6,
        items: categorySchema,
      },
      round2: {
        type: "array" as const,
        minItems: 6,
        maxItems: 6,
        items: categorySchema,
      },
      final: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const },
          prompt: { type: "string" as const },
          answer: { type: "string" as const },
        },
        required: ["category", "prompt", "answer"],
      },
    },
    required: ["title", "round1", "round2", "final"],
  },
};

interface ToolBoardOutput {
  title: string;
  round1: Array<{
    title: string;
    targetedPlayer?: string | null;
    clues: Array<{ prompt: string; answer: string }>;
  }>;
  round2: Array<{
    title: string;
    targetedPlayer?: string | null;
    clues: Array<{ prompt: string; answer: string }>;
  }>;
  final: { category: string; prompt: string; answer: string };
}

export interface BoardBuildOptions {
  onProgress?: (snippet: string) => void; // optional callback for streaming UI
}

export async function buildCustomBoard(
  profiles: PlayerProfile[],
  opts: BoardBuildOptions = {},
): Promise<GameDef> {
  if (!hasLlm || !client) {
    throw new Error(
      "ANTHROPIC_API_KEY or OPENROUTER_API_KEY required for custom board build",
    );
  }
  if (profiles.length === 0) {
    throw new Error("Need at least one player profile");
  }

  const userBlock = `Players and their self-described strengths (transcribed from speech, expect some STT noise):

${profiles
  .map(
    (p, i) =>
      `## Player ${i + 1}: ${p.name}\n${p.transcript || "(no transcript provided)"}`,
  )
  .join("\n\n")}

Build a custom 6×5 + 6×5 + Final board tailored to these ${profiles.length} player(s). ${supportsServerTools ? "Use web_search to verify any factual claims." : "Web search results have already been retrieved and are in your context."} Then call the generate_board tool with the complete result.

Reminder of standard board values:
- Round 1: $200 / $400 / $600 / $800 / $1000 (easy → hard within each category)
- Round 2: $400 / $800 / $1200 / $1600 / $2000

Make it fun.`;

  // Route web search per backend:
  //   - Anthropic direct: server-side `web_search_20260209` tool (model decides searches).
  //   - OpenRouter: `:online` model suffix (Exa-backed search runs once before the call).
  const tools: Anthropic.Messages.ToolUnion[] = supportsServerTools
    ? [
        { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Messages.ToolUnion,
        GENERATE_BOARD_TOOL,
      ]
    : [GENERATE_BOARD_TOOL];

  const model = modelWithWebSearch(BASE_MODEL);
  console.log(`[board] using model=${model} backend=${describeBackend()}`);

  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: SYSTEM,
    tools,
    messages: [{ role: "user", content: userBlock }],
  });

  // Find the structured output tool call
  const toolBlock = response.content.find(
    (b) => b.type === "tool_use" && b.name === "generate_board",
  );
  if (!toolBlock || toolBlock.type !== "tool_use") {
    // Surface any text from the model so the user can see what went wrong
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    throw new Error(
      `Board builder did not call generate_board. stop_reason=${response.stop_reason}. text="${text.slice(0, 200)}"`,
    );
  }

  const data = toolBlock.input as ToolBoardOutput;
  if (opts.onProgress) {
    opts.onProgress(`Generated "${data.title}"`);
  }

  return assemble(data);
}

function assemble(data: ToolBoardOutput): GameDef {
  const r1 = buildRoundFromTool(data.round1, 1);
  const r2 = buildRoundFromTool(data.round2, 2);
  // Real Jeopardy: 1 daily double in round 1, 2 in round 2. Rough heuristic
  // — random cell in rows 2-4 (avoid $200 / $1000 extremes).
  injectDailyDoubles(r1, 1);
  injectDailyDoubles(r2, 2);
  const final: FinalJeopardy = {
    category: data.final.category.trim(),
    prompt: data.final.prompt.trim(),
    answer: data.final.answer.trim(),
  };
  return { title: data.title, rounds: [r1, r2], final };
}

function buildRoundFromTool(
  cats: ToolBoardOutput["round1"],
  roundNum: 1 | 2,
): Round {
  const standardValues =
    roundNum === 1 ? [200, 400, 600, 800, 1000] : [400, 800, 1200, 1600, 2000];
  if (!Array.isArray(cats) || cats.length !== 6) {
    throw new Error(
      `Round ${roundNum} must have 6 categories, got ${cats?.length ?? 0}`,
    );
  }
  const categories: Category[] = cats.map((c, ci) => {
    if (!Array.isArray(c.clues) || c.clues.length !== 5) {
      throw new Error(
        `Round ${roundNum} cat ${ci} ("${c.title}") must have 5 clues`,
      );
    }
    const clues: Clue[] = c.clues.map((q, qi) => ({
      value: standardValues[qi]!,
      prompt: q.prompt.trim(),
      answer: q.answer.trim(),
    }));
    return { title: c.title.trim(), clues };
  });
  return { categories };
}

function injectDailyDoubles(round: Round, count: number) {
  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    let attempts = 0;
    while (attempts++ < 30) {
      const cat = Math.floor(Math.random() * 6);
      const idx = 1 + Math.floor(Math.random() * 4); // rows 1..4 ($400/$600/$800/$1000 in r1, $800/$1200/$1600/$2000 in r2)
      const key = `${cat}-${idx}`;
      if (taken.has(key)) continue;
      taken.add(key);
      round.categories[cat]!.clues[idx]!.dailyDouble = true;
      break;
    }
  }
}
