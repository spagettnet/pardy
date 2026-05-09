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

CRITICAL — DO NOT TELEGRAPH THE ANSWER. This is the most common failure mode and the one I will reject the hardest.

Hard rules:
1. NO WORD from the answer appears anywhere in the prompt. Not the full name, not a partial name, not a substring of the answer that's longer than 3 characters. If the answer is "Albert Einstein", the prompt cannot contain "Albert", "Einstein", "Einstein's", or any related word. If the answer is "The Great Gatsby", the prompt cannot contain "Gatsby" or "Great Gatsby". Run this check explicitly on every clue before emitting it.
2. NO synonyms or rephrasings of the answer. If the answer is "Frankenstein", don't say "this Mary Shelley creature" or "Shelley's monster".
3. NO near-tautologies. Bad: "This Italian Renaissance painter painted the Mona Lisa" (telegraphs Leonardo). Bad: "Marlon Brando's iconic role as the head of the Corleone family in this 1972 film" (the year + family + role uniquely identifies The Godfather and rephrases the answer).
4. The clue should make a player THINK. If a 10-year-old who'd never heard of the answer could guess from the prompt alone, the clue is broken.

Before emitting, walk through each clue and confirm: accurate (web search verified), single answer, not telegraphed (re-read once pretending you don't know the answer — does the prompt give it away?), on-theme, escalating difficulty.

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

/* ---------------- Per-clue retry ---------------- */

const RETRY_SYSTEM = `You are repairing one bad clue in an existing Jeopardy! category.

You will receive:
- The category title and research brief
- The 5 surviving clues in order from cheapest to most expensive (some may be marked [BAD] — those are the ones to replace)
- The dollar value of the slot you are writing

Write a SINGLE replacement clue that:
1. Is FACTUALLY ACCURATE — verify with web_search.
2. Has EXACTLY ONE correct answer.
3. Does NOT telegraph the answer. The answer's name (or any answer word > 3 chars, excluding stopwords) MUST NOT appear in the prompt. No near-tautologies.
4. Does NOT repeat any topic, person, work, place, year, or specific fact already used in another clue in this category. Read all the surviving clues first; pick a different angle.
5. Has appropriate difficulty for its slot. Clues at lower dollar values should be easier; clues at higher values should be harder. Look at the surviving easier and harder clues for calibration.
6. The answer is a noun (not phrased as a question).

Return via the rewrite_clue tool. No prose.`;

const RETRY_TOOL = {
  name: "rewrite_clue",
  description: "Return the replacement clue for the requested slot.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string" as const },
      answer: { type: "string" as const },
    },
    required: ["prompt", "answer"],
  },
};

/**
 * Compute the answer's significant words — the ones that, if they appear
 * in the prompt, count as a leak. Same logic as detectAnswerLeak.
 */
function answerWordsToForbid(answer: string): string[] {
  return answer
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

async function retryClue(
  brief: CategoryBrief,
  roundNum: 1 | 2,
  position: number,
  surviving: Array<{
    prompt: string;
    answer: string;
    value: number;
    bad?: boolean;
  }>,
  reason: string,
  /** Previously-tried prompts that still leaked, with the leak word. Helps the model not repeat its own mistakes. */
  priorAttempts: Array<{ prompt: string; answer: string; leakedWord: string }> = [],
): Promise<{ prompt: string; answer: string } | null> {
  if (!client) return null;
  const valueAtPosition = surviving[position]!.value;
  const targetAnswer = surviving[position]!.answer;
  const forbidden = answerWordsToForbid(targetAnswer);

  const lines = surviving
    .map((c, i) => {
      const tag = i === position ? " ← REPLACE THIS" : c.bad ? " [BAD — being replaced separately]" : "";
      const body = c.bad ? "—" : `${c.prompt}\n     Answer: ${c.answer}`;
      return `  $${c.value}${tag}: ${body}`;
    })
    .join("\n");

  const priorBlock = priorAttempts.length
    ? `\n\nPRIOR FAILED ATTEMPTS (do not repeat these — they all leaked):\n${priorAttempts
        .map(
          (p, n) =>
            `  Attempt ${n + 1}: "${p.prompt}"\n    → leaked word: "${p.leakedWord}"`,
        )
        .join("\n")}`
    : "";

  const userBlock = `Category: ${brief.title}
Research brief: ${brief.research_brief}
Slot to repair: $${valueAtPosition}
Target answer: "${targetAnswer}"

FORBIDDEN WORDS in your prompt — your prompt MUST NOT contain ANY of these (or close variants like plurals/possessives):
  ${forbidden.length === 0 ? "(no significant answer words to avoid — the answer is short)" : forbidden.map((w) => `"${w}"`).join(", ")}

The 5 clues in this category (cheapest → most expensive):
${lines}

The clue at $${valueAtPosition} was rejected because: ${reason}.${priorBlock}

Write a replacement clue for the $${valueAtPosition} slot.

Constraints (recap):
- The clue's prompt CANNOT contain any of the forbidden words above. Sanity-check by re-reading your draft and looking for each forbidden word.
- Don't repeat the topic, person, work, place, year, or fact of any surviving clue in the category.
- Difficulty fits the slot: $${valueAtPosition} is ${valueAtPosition <= 400 ? "the easy end — accessible recall" : valueAtPosition >= 1600 ? "the hard end — a real stumper" : "mid-range — moderate difficulty"} for a player into this category.
- Keep the answer "${targetAnswer}" itself OR pick a different angle that lands on a closely-related fact. (If sticking with "${targetAnswer}" keeps leaking, switch to a different fact about the same subject.)

Call rewrite_clue when done.`;

  const tools: Anthropic.Messages.ToolUnion[] = supportsServerTools
    ? [
        { type: "web_search_20260209", name: "web_search" } as unknown as Anthropic.Messages.ToolUnion,
        RETRY_TOOL,
      ]
    : [RETRY_TOOL];

  try {
    const resp = await client.messages.create({
      model: modelWithWebSearch(BASE_MODEL),
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: RETRY_SYSTEM,
      tools,
      tool_choice: { type: "tool", name: "rewrite_clue" },
      messages: [{ role: "user", content: userBlock }],
    });
    const tool = resp.content.find(
      (b) => b.type === "tool_use" && b.name === "rewrite_clue",
    );
    if (!tool || tool.type !== "tool_use") return null;
    const data = tool.input as { prompt?: unknown; answer?: unknown };
    if (typeof data.prompt !== "string" || typeof data.answer !== "string")
      return null;
    return { prompt: data.prompt.trim(), answer: data.answer.trim() };
  } catch (err) {
    console.error(`[retry] "${brief.title}" $${valueAtPosition} failed:`, err);
    return null;
  }
}

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

  /* Phase 2.5: validate + retry any leaky clues */
  await retryLeaks(plan.round1, r1Results, 1, progress);
  await retryLeaks(plan.round2, r2Results, 2, progress);

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

/**
 * For each category in a round, scan the generated clues for answer leaks
 * (the answer's name appearing in the prompt). For any leaky clue, fire a
 * retryClue call in parallel that has the surviving clues as context. Up
 * to 1 retry per clue; if the retry still leaks, leave it leaky and
 * assembleClues will drop it to a placeholder. We log loudly so it's
 * visible in dev.
 */
async function retryLeaks(
  briefs: CategoryBrief[],
  results: Array<{ clues: { prompt: string; answer: string }[] }>,
  roundNum: 1 | 2,
  progress: (p: BoardProgress) => void,
): Promise<void> {
  const standardValues =
    roundNum === 1 ? [200, 400, 600, 800, 1000] : [400, 800, 1200, 1600, 2000];
  const retryTasks: Array<Promise<void>> = [];
  let scheduled = 0;

  for (let ci = 0; ci < briefs.length; ci++) {
    const brief = briefs[ci]!;
    const clues = results[ci]?.clues ?? [];
    // Build a "surviving" snapshot; any leaky clue is marked bad.
    const snapshot = clues.map((c, i) => {
      const leaked = detectAnswerLeak(c.prompt, c.answer);
      return {
        prompt: c.prompt,
        answer: c.answer,
        value: standardValues[i]!,
        bad: !!leaked,
        reason: leaked ? `answer word "${leaked}" leaked into prompt` : "",
      };
    });

    for (let i = 0; i < snapshot.length; i++) {
      if (!snapshot[i]!.bad) continue;
      scheduled += 1;
      const reason = snapshot[i]!.reason;
      const slotValue = snapshot[i]!.value;
      const task = (async () => {
        console.warn(
          `[board] R${roundNum} "${brief.title}" $${slotValue}: leak detected (${reason}) → retrying…`,
        );
        const priorAttempts: Array<{
          prompt: string;
          answer: string;
          leakedWord: string;
        }> = [];
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const replacement = await retryClue(
            brief,
            roundNum,
            i,
            snapshot,
            reason,
            priorAttempts,
          );
          if (!replacement) {
            console.warn(
              `[board] R${roundNum} "${brief.title}" $${slotValue}: attempt ${attempt} returned nothing`,
            );
            continue;
          }
          const leaked = detectAnswerLeak(replacement.prompt, replacement.answer);
          if (!leaked) {
            results[ci]!.clues[i] = replacement;
            console.log(
              `[board] R${roundNum} "${brief.title}" $${slotValue}: attempt ${attempt} succeeded`,
            );
            progress({
              phase: "Repairing clue",
              detail: `↻ ${brief.title} $${slotValue}`,
            });
            return;
          }
          console.warn(
            `[board] R${roundNum} "${brief.title}" $${slotValue}: attempt ${attempt} STILL leaks "${leaked}" (prompt: "${replacement.prompt.slice(0, 90)}…")`,
          );
          priorAttempts.push({
            prompt: replacement.prompt,
            answer: replacement.answer,
            leakedWord: leaked,
          });
        }
        console.warn(
          `[board] R${roundNum} "${brief.title}" $${slotValue}: gave up after ${MAX_ATTEMPTS} attempts — slot will be dropped`,
        );
      })();
      retryTasks.push(task);
    }
  }

  if (scheduled === 0) return;
  progress({ phase: `Repairing ${scheduled} leaky clue${scheduled > 1 ? "s" : ""}` });
  await Promise.all(retryTasks);
}

// Stop-words we don't flag as leaks even if they appear in both prompt and
// answer — they're noise, not identifying information.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "but", "is",
  "this", "that", "these", "those", "his", "her", "its", "their", "from",
  "with", "by", "as", "at", "be", "was", "were", "are", "do", "did", "have",
  "has", "had", "will", "what", "who", "which", "where", "when", "how",
]);

/**
 * Returns the offending answer word if the prompt leaks the answer, else null.
 * Considers any answer word longer than 3 characters that isn't a stopword.
 */
function detectAnswerLeak(prompt: string, answer: string): string | null {
  const promptLower = " " + prompt.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ") + " ";
  const answerWords = answer
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  for (const w of answerWords) {
    if (promptLower.includes(" " + w + " ")) return w;
    // Catch suffix variants like "Einstein's"
    if (promptLower.includes(" " + w)) return w;
  }
  return null;
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
      const prompt = r.prompt.trim();
      const answer = r.answer.trim();
      const leaked = detectAnswerLeak(prompt, answer);
      if (leaked) {
        // The model gave the answer away in the prompt. Drop it to a
        // placeholder rather than ship a broken clue.
        console.warn(
          `[board] DROPPED leaky clue: answer="${answer}" leaked word="${leaked}" prompt="${prompt}"`,
        );
        out.push({
          value: standardValues[i]!,
          prompt: "(answer-leak detected — clue dropped)",
          answer: "—",
          missing: true,
        });
      } else {
        out.push({ value: standardValues[i]!, prompt, answer });
      }
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
