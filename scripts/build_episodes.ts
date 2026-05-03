/**
 * Convert the jwolle1/jeopardy_clue_dataset TSV into our GameDef format.
 *
 * Source schema: round, clue_value, daily_double_value, category, comments,
 *                answer, question, air_date, notes
 *
 * Note: in the dataset's column names "answer" is the *prompt* shown to
 * contestants, and "question" is the correct response. Our GameDef uses
 * "prompt" + "answer" instead. We translate accordingly.
 *
 * Outputs:
 *  - data/episodes.json — array of complete episodes (full 6x5 + 6x5 + Final)
 *  - data/categories.json — flat list of full 5-clue categories grouped by round,
 *    for mix-and-match game generation.
 */

import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Category, Clue, GameDef } from "../src/types.js";

interface RawRow {
  round: number; // 1, 2, 3
  clueValue: number;
  ddValue: number;
  category: string;
  prompt: string; // dataset "answer"
  answer: string; // dataset "question"
  airDate: string;
  notes: string;
  source: "regular" | "extra" | "kids_teen";
}

interface EpisodeAccum {
  airDate: string;
  rows: RawRow[];
}

type Tier = "regular" | "kids" | "teen" | "college" | "celebrity" | "tournament";

function detectTier(notes: string, source: RawRow["source"]): Tier {
  const n = notes.toLowerCase();
  if (n.includes("kids week") || n.includes("kids tournament") || n.includes("back to school"))
    return "kids";
  if (n.includes("teen tournament") || n.includes("teen reunion")) return "teen";
  if (n.includes("college championship") || n.includes("college tournament")) return "college";
  if (n.includes("celebrity jeopardy") || n.includes("celeb")) return "celebrity";
  if (n) return "tournament";
  return source === "kids_teen" ? "teen" : source === "extra" ? "tournament" : "regular";
}

const ROOT = resolve(import.meta.dirname, "..");
const SRC_REGULAR = resolve(ROOT, "data/raw/jeopardy.tsv");
const SRC_EXTRA = resolve(ROOT, "data/raw/extra_matches.tsv");
const SRC_KIDS = resolve(ROOT, "data/raw/kids_teen_matches.tsv");
const OUT_EPISODES = resolve(ROOT, "data/episodes.json");
const OUT_CATEGORIES = resolve(ROOT, "data/categories.json");

const HTML_ENT = /&([a-z]+|#\d+);/gi;
const HTML_TAGS = /<[^>]+>/g;

function decodeHtml(s: string): string {
  return s
    .replace(HTML_TAGS, "")
    .replace(HTML_ENT, (_m, ent: string) => {
      const map: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      if (ent.startsWith("#")) {
        const code = parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCharCode(code) : "";
      }
      return map[ent.toLowerCase()] ?? "";
    })
    .replace(/\\['"]/g, (m) => m[1]!)
    .replace(/\s+/g, " ")
    .trim();
}

function isUsable(prompt: string, answer: string): boolean {
  if (!prompt || !answer) return false;
  // Skip clues that obviously rely on visual/audio content not in the dataset.
  const lower = prompt.toLowerCase();
  if (
    lower.includes("seen here") ||
    lower.includes("(seen here)") ||
    lower.includes("[video clue") ||
    lower.includes("[audio clue") ||
    lower.includes("the picture") ||
    lower.includes("this picture") ||
    lower.includes("heard here")
  ) {
    return false;
  }
  if (prompt.length > 500 || answer.length > 200) return false;
  return true;
}

async function loadFile(
  path: string,
  source: RawRow["source"],
  byEpisode: Map<string, RawRow[]>,
  exists = true,
): Promise<number> {
  if (!exists) return 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;
  let count = 0;
  for await (const line of rl) {
    if (!line) continue;
    const parts = line.split("\t");
    if (!header) {
      header = parts.map((h) => h.trim());
      continue;
    }
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]!] = parts[i] ?? "";
    }
    const round = parseInt(obj.round || "0", 10);
    if (!(round === 1 || round === 2 || round === 3)) continue;
    const prompt = decodeHtml(obj.answer || "");
    const answer = decodeHtml(obj.question || "");
    if (round !== 3 && !isUsable(prompt, answer)) continue;
    if (round === 3 && (!prompt || !answer)) continue;
    const row: RawRow = {
      round,
      clueValue: parseInt(obj.clue_value || "0", 10),
      ddValue: parseInt(obj.daily_double_value || "0", 10),
      category: decodeHtml(obj.category || ""),
      prompt,
      answer,
      airDate: obj.air_date || "",
      notes: obj.notes || "",
      source,
    };
    if (!row.airDate) continue;
    // Air-date collisions across files: prefer the more specific source (extra/kids over regular).
    const existing = byEpisode.get(row.airDate);
    if (existing) {
      // If first row is regular but new is special, replace.
      if (existing[0]?.source === "regular" && source !== "regular") {
        byEpisode.set(row.airDate, [row]);
      } else if (existing[0]?.source === source) {
        existing.push(row);
      }
      // else: drop (different specials sharing a date)
    } else {
      byEpisode.set(row.airDate, [row]);
    }
    count++;
  }
  return count;
}

async function loadRows(): Promise<EpisodeAccum[]> {
  const byEpisode = new Map<string, RawRow[]>();
  const fs = await import("node:fs/promises");
  const exists = async (p: string) => {
    try { await fs.stat(p); return true; } catch { return false; }
  };
  const total = (await Promise.all([
    loadFile(SRC_REGULAR, "regular", byEpisode, await exists(SRC_REGULAR)),
    loadFile(SRC_EXTRA, "extra", byEpisode, await exists(SRC_EXTRA)),
    loadFile(SRC_KIDS, "kids_teen", byEpisode, await exists(SRC_KIDS)),
  ])).reduce((a, b) => a + b, 0);
  process.stderr.write(
    `parsed ${total} rows across ${byEpisode.size} air dates\n`,
  );
  return [...byEpisode.entries()].map(([airDate, rows]) => ({
    airDate,
    rows,
  }));
}

function tierForValue(value: number, round: number): number | null {
  // Modern era: r1 = 200/400/600/800/1000; r2 = 400/800/1200/1600/2000.
  // Pre-Nov-2001: r1 = 100/200/300/400/500; r2 = 200/400/600/800/1000.
  // Map any of these to tier 0..4.
  const tiers =
    round === 1
      ? [
          [100, 200, 300, 400, 500],
          [200, 400, 600, 800, 1000],
        ]
      : [
          [200, 400, 600, 800, 1000],
          [400, 800, 1200, 1600, 2000],
        ];
  for (const set of tiers) {
    const idx = set.indexOf(value);
    if (idx >= 0) return idx;
  }
  return null;
}

function buildEpisode(accum: EpisodeAccum): GameDef | null {
  const { airDate, rows } = accum;
  const r1Rows = rows.filter((r) => r.round === 1);
  const r2Rows = rows.filter((r) => r.round === 2);
  const finalRows = rows.filter((r) => r.round === 3);
  if (r1Rows.length === 0 || r2Rows.length === 0 || finalRows.length === 0) {
    return null;
  }

  const buildRound = (
    rRows: RawRow[],
    roundNum: 1 | 2,
  ): { categories: Category[] } | null => {
    const byCat = new Map<string, RawRow[]>();
    for (const row of rRows) {
      const list = byCat.get(row.category);
      if (list) list.push(row);
      else byCat.set(row.category, [row]);
    }
    const cats: Category[] = [];
    for (const [title, list] of byCat) {
      // Allow up to 5 clues per cat. We'll back-fill missing slots with
      // a "[skipped on air]" placeholder so the episode is still playable.
      if (list.length === 0 || list.length > 5) return null;
      const slots: (Clue | null)[] = [null, null, null, null, null];
      const standardValues =
        roundNum === 1
          ? [200, 400, 600, 800, 1000]
          : [400, 800, 1200, 1600, 2000];
      for (const r of list) {
        const tier = tierForValue(r.clueValue, roundNum);
        if (tier === null) return null;
        if (slots[tier] !== null) return null; // duplicate value: bail
        slots[tier] = {
          value: standardValues[tier]!,
          prompt: r.prompt,
          answer: r.answer,
          dailyDouble: r.ddValue > 0 ? true : undefined,
        };
      }
      // Fill any null slots with placeholder.
      for (let i = 0; i < 5; i++) {
        if (slots[i] === null) {
          slots[i] = {
            value: standardValues[i]!,
            prompt: "(skipped on air)",
            answer: "—",
            missing: true,
          };
        }
      }
      cats.push({ title, clues: slots as Clue[] });
    }
    if (cats.length !== 6) return null;
    return { categories: cats };
  };

  const r1 = buildRound(r1Rows, 1);
  const r2 = buildRound(r2Rows, 2);
  if (!r1 || !r2) return null;

  // Pick the first finalRow that's usable (most episodes have exactly 1).
  const fjRow = finalRows.find((f) => f.prompt && f.answer);
  if (!fjRow) return null;

  // Detect tier from the first row's notes — usually consistent across an episode.
  const sampleRow = rows[0]!;
  const tier = detectTier(sampleRow.notes, sampleRow.source);
  // Cleaner title: include tier + a short notes excerpt when available.
  const titleSuffix = sampleRow.notes
    ? sampleRow.notes.replace(/\s+game \d+\.?$/, "").replace(/\.+$/, "")
    : "";
  const tierLabel: Record<Tier, string> = {
    regular: "Jeopardy!",
    kids: "Kids Week",
    teen: "Teen Tournament",
    college: "College Championship",
    celebrity: "Celebrity Jeopardy!",
    tournament: "Tournament",
  };
  const title = `${tierLabel[tier]} — ${airDate}${titleSuffix ? ` (${titleSuffix})` : ""}`;

  return {
    title,
    rounds: [r1, r2],
    final: {
      category: fjRow.category,
      prompt: fjRow.prompt,
      answer: fjRow.answer,
    },
    tier,
  } as GameDef & { tier: Tier };
}

async function main() {
  const accums = await loadRows();
  const episodes: Array<GameDef & { airDate: string; tier: Tier }> = [];
  let dropped = 0;
  for (const a of accums) {
    const ep = buildEpisode(a) as (GameDef & { tier: Tier }) | null;
    if (ep) episodes.push({ ...ep, airDate: a.airDate });
    else dropped++;
  }
  episodes.sort((a, b) => a.airDate.localeCompare(b.airDate));

  const byTier: Record<Tier, number> = {
    regular: 0,
    kids: 0,
    teen: 0,
    college: 0,
    celebrity: 0,
    tournament: 0,
  };
  for (const ep of episodes) byTier[ep.tier] = (byTier[ep.tier] || 0) + 1;
  process.stderr.write(
    `built ${episodes.length} complete episodes (dropped ${dropped}). by tier: ${JSON.stringify(byTier)}\n`,
  );

  // Categories pool for mix-and-match — flatten every full 5-clue category
  // tagged with its source tier.
  const r1Pool: Array<Category & { tier: Tier }> = [];
  const r2Pool: Array<Category & { tier: Tier }> = [];
  const finals: Array<{ category: string; prompt: string; answer: string; tier: Tier }> = [];
  for (const ep of episodes) {
    for (const c of ep.rounds[0].categories) r1Pool.push({ ...c, tier: ep.tier });
    for (const c of ep.rounds[1].categories) r2Pool.push({ ...c, tier: ep.tier });
    finals.push({ ...ep.final, tier: ep.tier });
  }

  writeFileSync(OUT_EPISODES, JSON.stringify(episodes));
  writeFileSync(
    OUT_CATEGORIES,
    JSON.stringify({ round1: r1Pool, round2: r2Pool, finals }),
  );
  process.stderr.write(
    `wrote ${OUT_EPISODES} and ${OUT_CATEGORIES} (r1 cats: ${r1Pool.length}, r2 cats: ${r2Pool.length}, finals: ${finals.length})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
