/**
 * Custom-board generator. Three-phase parallel design with progress callbacks:
 *
 *   1. PLANNER (1 call, ~5s):
 *      Opus 4.7 reads player transcripts and outputs the board *spine*:
 *      24 category briefs (12 round-1 + 12 round-2 — wait, 6 + 6 = 12) plus 1 Final.
 *      For each category: title, optional targetedPlayer, and a research_brief
 *      describing what kinds of clues should fill it.
 *
 *   2. CATEGORY FAN-OUT (12 parallel calls, ~15-25s wall time):
 *      Each category brief → one Opus 4.7 call that does web search and returns
 *      its 5 clues. Plus one parallel call for Final Jeopardy.
 *
 *   3. ASSEMBLE:
 *      Stitch the parts back into a GameDef. Inject daily doubles.
 *
 * Progress is reported via opts.onProgress so the server can broadcast updates
 * to the host UI's BUILDING screen.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Category, Clue, FinalJeopardy, GameDef, Round } from "./types.js";
import {
  client,
  hasLlm,
  modelWithWebSearch,
  modelId,
  supportsServerTools,
  describeBackend,
} from "./llm.js";

const BASE_MODEL = process.env.BOARD_MODEL || "claude-opus-4-7";

export interface PlayerProfile {
  name: string;
  transcript: string;
}

export interface BoardProgress {
  phase: string;          // short status like "planning", "researching"
  detail?: string;        // optional category title etc.
  done?: number;          // for fan-out: how many done
  total?: number;         // for fan-out: total tasks
}

export interface BoardBuildOptions {
  onProgress?: (p: BoardProgress) => void;
}

/* ---------------- Planner ---------------- */

const PLANNER_SYSTEM = `You are designing a custom Jeopardy! board for a small house party.

Given the players' interview transcripts, plan the board STRUCTURE only — do not write any clues yet. Output 12 category briefs (6 for round 1, 6 for round 2) plus 1 Final Jeopardy brief.

For each category, decide:
- title: short, punchy, sometimes punny ("PRESIDENTIAL POTPOURRI", "BOB'S BEAT", "CODE & CODERS").
- targetedPlayer: name of the player tilted toward this category, or null if shared/general. Use the exact name as provided.
- research_brief: 1-3 sentences telling the next-stage clue writer what to research and what kind of facts to aim for. Be specific — name eras, sub-domains, recurring topics from the transcript.

Coverage rules:
- Each player should be the primary target of ≥2 categories total across both rounds.
- Include 1-2 categories tilted to *shared* interests, themes mentioned by multiple players, or universal pop-culture.
- Avoid categories no player has any hook into.
- Round 2 categories should generally be a hair tougher / nichier than round 1.

Final Jeopardy should be broadly known but tricky — something at least one player has a shot at. Pick a category that resonates with the players' stated interests but isn't too obscure.

Return via the plan_board tool. No prose.`;

const PLAN_BOARD_TOOL = {
  name: "plan_board",
  description: "Emit the structural plan for the custom board.",
  input_schema: {
    type: "object" as const,
    properties: {
      title: {
        type: "string" as const,
        description: "Game title (≤ 60 chars).",
      },
      round1: {
        type: "array" as const,
        minItems: 6,
        maxItems: 6,
        items: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            targetedPlayer: { type: ["string", "null"] as const },
            research_brief: { type: "string" as const },
          },
          required: ["title", "research_brief"],
        },
      },
      round2: {
        type: "array" as const,
        minItems: 6,
        maxItems: 6,
        items: {
          type: "object" as const,
          properties: {
            title: { type: "string" as const },
            targetedPlayer: { type: ["string", "null"] as const },
            research_brief: { type: "string" as const },
          },
          required: ["title", "research_brief"],
        },
      },
      final: {
        type: "object" as const,
        properties: {
          category: { type: "string" as const },
          research_brief: { type: "string" as const },
        },
        required: ["category", "research_brief"],
      },
    },
    required: ["title", "round1", "round2", "final"],
  },
};

interface CategoryBrief {
  title: string;
  targetedPlayer?: string | null;
  research_brief: string;
}

interface BoardPlan {
  title: string;
  round1: CategoryBrief[];
  round2: CategoryBrief[];
  final: { category: string; research_brief: string };
}

async function planBoard(profiles: PlayerProfile[]): Promise<BoardPlan> {
  if (!client) throw new Error("no client");
  const userBlock = `Players and their self-described strengths (transcribed from speech, expect some STT noise):

${profiles.map((p, i) => `## Player ${i + 1}: ${p.name}\n${p.transcript || "(no transcript provided)"}`).join("\n\n")}

Plan a custom 6×5 + 6×5 + Final board for these ${profiles.length} player(s). Call plan_board with the structure.`;

  const resp = await client.messages.create({
    model: modelId(BASE_MODEL),
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: PLANNER_SYSTEM,
    tools: [PLAN_BOARD_TOOL],
    tool_choice: { type: "tool", name: "plan_board" },
    messages: [{ role: "user", content: userBlock }],
  });

  const tool = resp.content.find(
    (b) => b.type === "tool_use" && b.name === "plan_board",
  );
  if (!tool || tool.type !== "tool_use") {
    throw new Error("planner did not call plan_board");
  }
  return tool.input as BoardPlan;
}

/* ---------------- Category fan-out ---------------- */

const CATEGORY_SYSTEM = `You write 5 Jeopardy! clues for one category, given a research brief and the standard board values for that round.

Style rules:
- The PROMPT is what the host reads. The ANSWER is the canonical correct response (a noun, not phrased as a question — "Albert Einstein", not "Who is Albert Einstein").
- Use web_search aggressively. Verify every name, date, score, lyric, location.
- Difficulty escalates within the category from $200 (easy entry-level for the targeted player) up to $1000 (a stretch from their domain). Round 2 escalates from $400 to $2000 with the same shape.
- Avoid clues that depend on visual or audio media.
- Each prompt narrows to exactly ONE correct answer.

CRITICAL — do not telegraph the answer:
- The answer's name must NOT appear in the prompt.
- Avoid near-tautologies ("This Italian Renaissance painter painted the Mona Lisa" telegraphs Leonardo).
- Don't list distinctive features that uniquely identify the answer in too obvious a way.

Before emitting, walk through each clue and confirm: accurate (web search verified), single answer, not telegraphed, on-theme, escalating difficulty.

Return exactly 5 clues via the write_category tool. No prose.`;

const CATEGORY_TOOL = {
  name: "write_category",
  description: "Emit the 5 clues for this category, in order from $200 to $1000 (round 1) or $400 to $2000 (round 2).",
  input_schema: {
    type: "object" as const,
    properties: {
      clues: {
        type: "array" as const,
        minItems: 5,
        maxItems: 5,
        items: {
          type: "object" as const,
          properties: {
            prompt: { type: "string" as const },
            answer: { type: "string" as const },
          },
          required: ["prompt", "answer"],
        },
      },
    },
    required: ["clues"],
  },
};

const FINAL_TOOL = {
  name: "write_final",
  description: "Emit the Final Jeopardy clue.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string" as const },
      answer: { type: "string" as const },
    },
    required: ["prompt", "answer"],
  },
};

async function writeCategory(
  brief: CategoryBrief,
  roundNum: 1 | 2,
  players: PlayerProfile[],
): Promise<{ prompt: string; answer: string }[]> {
  if (!client) throw new Error("no client");
  const standardValues =
    roundNum === 1 ? [200, 400, 600, 800, 1000] : [400, 800, 1200, 1600, 2000];

  const playerSummary = players
    .map((p) => `- ${p.name}: ${p.transcript.slice(0, 280)}`)
    .join("\n");

  const userBlock = `Round ${roundNum}. Category: ${brief.title}
${brief.targetedPlayer ? `Primarily targeting: ${brief.targetedPlayer}` : "Shared category."}
Research brief: ${brief.research_brief}

Standard values for this round: ${standardValues.map((v) => `$${v}`).join(", ")}

Player profiles for context:
${playerSummary}

Write exactly 5 clues for this category, ordered $${standardValues[0]} → $${standardValues[4]}. Use web_search to verify facts. Call write_category when done.`;

  const tools: Anthropic.Messages.ToolUnion[] = supportsServerTools
    ? [
        { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Messages.ToolUnion,
        CATEGORY_TOOL,
      ]
    : [CATEGORY_TOOL];

  const resp = await client.messages.create({
    model: modelWithWebSearch(BASE_MODEL),
    max_tokens: 6000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: CATEGORY_SYSTEM,
    tools,
    tool_choice: { type: "tool", name: "write_category" },
    messages: [{ role: "user", content: userBlock }],
  });

  const tool = resp.content.find(
    (b) => b.type === "tool_use" && b.name === "write_category",
  );
  if (!tool || tool.type !== "tool_use") {
    throw new Error(`category "${brief.title}" returned no tool call`);
  }
  const data = tool.input as { clues: { prompt: string; answer: string }[] };
  if (!Array.isArray(data.clues) || data.clues.length !== 5) {
    throw new Error(`category "${brief.title}" did not return 5 clues`);
  }
  return data.clues;
}

const FINAL_SYSTEM = `You write a single Final Jeopardy! clue.

Style: broadly known but tricky. One unambiguous correct answer. Verify with web_search if facts are involved.

CRITICAL: do not telegraph. The answer's name must not appear in the prompt; no near-tautologies; no synonyms that give it away. The answer is a noun, not phrased as a question.

Return via the write_final tool. No prose.`;

async function writeFinal(
  brief: { category: string; research_brief: string },
  players: PlayerProfile[],
): Promise<{ prompt: string; answer: string }> {
  if (!client) throw new Error("no client");
  const playerSummary = players
    .map((p) => `- ${p.name}: ${p.transcript.slice(0, 200)}`)
    .join("\n");
  const userBlock = `Final Jeopardy category: ${brief.category}
Research brief: ${brief.research_brief}

Player profiles for context:
${playerSummary}

Write a single Final Jeopardy clue + answer. Verify with web_search. Call write_final.`;

  const tools: Anthropic.Messages.ToolUnion[] = supportsServerTools
    ? [
        { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Messages.ToolUnion,
        FINAL_TOOL,
      ]
    : [FINAL_TOOL];

  const resp = await client.messages.create({
    model: modelWithWebSearch(BASE_MODEL),
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: FINAL_SYSTEM,
    tools,
    tool_choice: { type: "tool", name: "write_final" },
    messages: [{ role: "user", content: userBlock }],
  });

  const tool = resp.content.find(
    (b) => b.type === "tool_use" && b.name === "write_final",
  );
  if (!tool || tool.type !== "tool_use") {
    throw new Error("final did not return a tool call");
  }
  return tool.input as { prompt: string; answer: string };
}

/* ---------------- Main ---------------- */

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
  const progress = opts.onProgress ?? (() => {});

  console.log(
    `[board] backend=${describeBackend()} model=${BASE_MODEL} players=${profiles.length}`,
  );

  /* Phase 1: planner */
  progress({ phase: "Planning the board structure", detail: "Reading interview transcripts" });
  const t0 = Date.now();
  const plan = await planBoard(profiles);
  console.log(
    `[board] plan in ${((Date.now() - t0) / 1000).toFixed(1)}s — title="${plan.title}"`,
  );
  console.log(
    `[board] R1: ${plan.round1.map((c) => c.title).join(", ")}`,
  );
  console.log(
    `[board] R2: ${plan.round2.map((c) => c.title).join(", ")}`,
  );
  console.log(`[board] Final: ${plan.final.category}`);

  /* Phase 2: parallel fan-out */
  const totalTasks = plan.round1.length + plan.round2.length + 1;
  let done = 0;
  progress({
    phase: `Researching ${totalTasks} categories in parallel`,
    detail: plan.title,
    done,
    total: totalTasks,
  });

  const tickProgress = (label: string) => {
    done += 1;
    progress({
      phase: "Researching",
      detail: `${label}`,
      done,
      total: totalTasks,
    });
  };

  const r1Promises: Promise<{ clues: { prompt: string; answer: string }[] }>[] =
    plan.round1.map((brief) =>
      writeCategory(brief, 1, profiles).then((clues) => {
        tickProgress(`✓ ${brief.title}`);
        return { clues };
      }).catch((err) => {
        console.error(`[board] R1 "${brief.title}" failed:`, err);
        tickProgress(`✗ ${brief.title}`);
        return { clues: [] };
      }),
    );
  const r2Promises = plan.round2.map((brief) =>
    writeCategory(brief, 2, profiles).then((clues) => {
      tickProgress(`✓ ${brief.title}`);
      return { clues };
    }).catch((err) => {
      console.error(`[board] R2 "${brief.title}" failed:`, err);
      tickProgress(`✗ ${brief.title}`);
      return { clues: [] };
    }),
  );
  const finalPromise = writeFinal(plan.final, profiles).then((f) => {
    tickProgress(`✓ Final`);
    return f;
  });

  const [r1Results, r2Results, final] = await Promise.all([
    Promise.all(r1Promises),
    Promise.all(r2Promises),
    finalPromise,
  ]);

  /* Phase 3: assemble */
  progress({ phase: "Assembling the board", detail: plan.title });

  const r1: Round = {
    categories: plan.round1.map((brief, i) => ({
      title: brief.title.trim(),
      clues: assembleClues(r1Results[i]?.clues ?? [], 1),
    })),
  };
  const r2: Round = {
    categories: plan.round2.map((brief, i) => ({
      title: brief.title.trim(),
      clues: assembleClues(r2Results[i]?.clues ?? [], 2),
    })),
  };
  injectDailyDoubles(r1, 1);
  injectDailyDoubles(r2, 2);

  const fj: FinalJeopardy = {
    category: plan.final.category.trim(),
    prompt: final.prompt.trim(),
    answer: final.answer.trim(),
  };

  return { title: plan.title.trim(), rounds: [r1, r2], final: fj };
}

function assembleClues(
  raw: { prompt: string; answer: string }[],
  roundNum: 1 | 2,
): Clue[] {
  const standardValues =
    roundNum === 1 ? [200, 400, 600, 800, 1000] : [400, 800, 1200, 1600, 2000];
  const out: Clue[] = [];
  for (let i = 0; i < 5; i++) {
    const r = raw[i];
    if (r && r.prompt && r.answer) {
      out.push({
        value: standardValues[i]!,
        prompt: r.prompt.trim(),
        answer: r.answer.trim(),
      });
    } else {
      // Failed clue → mark missing so it shows greyed-out in the UI.
      out.push({
        value: standardValues[i]!,
        prompt: "(generation failed)",
        answer: "—",
        missing: true,
      });
    }
  }
  return out;
}

function injectDailyDoubles(round: Round, count: number) {
  const taken = new Set<string>();
  for (let i = 0; i < count; i++) {
    let attempts = 0;
    while (attempts++ < 30) {
      const cat = Math.floor(Math.random() * 6);
      const idx = 1 + Math.floor(Math.random() * 4);
      const key = `${cat}-${idx}`;
      if (taken.has(key)) continue;
      const clue = round.categories[cat]?.clues[idx];
      if (!clue || clue.missing) continue;
      taken.add(key);
      clue.dailyDouble = true;
      break;
    }
  }
}
