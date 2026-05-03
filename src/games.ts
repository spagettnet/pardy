import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Category,
  FinalJeopardy,
  GameDef,
  GameTier,
  Round,
} from "./types.js";

const ROOT = resolve(import.meta.dirname, "..");
const EPISODES_PATH = resolve(ROOT, "data/episodes.json");
const CATEGORIES_PATH = resolve(ROOT, "data/categories.json");
const SAMPLE_PATH = resolve(ROOT, "data/sample-game.json");
const CUSTOM_BOARDS_DIR = resolve(ROOT, "data/custom-boards");

interface EpisodeRecord extends GameDef {
  airDate: string;
  tier?: GameTier;
}

interface CategoryPool {
  round1: Array<Category & { tier?: GameTier }>;
  round2: Array<Category & { tier?: GameTier }>;
  finals: Array<FinalJeopardy & { tier?: GameTier }>;
}

let _episodes: EpisodeRecord[] | null = null;
let _pool: CategoryPool | null = null;

function loadEpisodes(): EpisodeRecord[] {
  if (_episodes) return _episodes;
  const out: EpisodeRecord[] = [];
  if (existsSync(EPISODES_PATH)) {
    const eps = JSON.parse(readFileSync(EPISODES_PATH, "utf8")) as EpisodeRecord[];
    for (const e of eps) out.push(e);
  }
  // Append any saved custom boards as a "custom" tier so they show up
  // in the lobby picker for replay.
  if (existsSync(CUSTOM_BOARDS_DIR)) {
    try {
      const files = readdirSync(CUSTOM_BOARDS_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const raw = readFileSync(resolve(CUSTOM_BOARDS_DIR, f), "utf8");
          const def = JSON.parse(raw) as GameDef & {
            builtAt?: string;
            players?: string[];
          };
          // Air-date-ish: derive from filename prefix, keep ISO-y for sorting.
          const m = f.match(/^(\d{4})-(\d{2})-(\d{2})/);
          const airDate = m ? `${m[1]}-${m[2]}-${m[3]}` : (def.builtAt?.slice(0, 10) ?? "custom");
          out.push({
            ...def,
            airDate,
            tier: "custom" as GameTier,
          });
        } catch {
          // skip malformed file
        }
      }
    } catch {}
  }
  _episodes = out;
  return _episodes;
}

export function invalidateEpisodeCache(): void {
  _episodes = null;
}

function loadPool(): CategoryPool | null {
  if (_pool) return _pool;
  if (!existsSync(CATEGORIES_PATH)) return null;
  _pool = JSON.parse(readFileSync(CATEGORIES_PATH, "utf8"));
  return _pool;
}

function loadSample(): GameDef {
  return JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
}

export interface EpisodeSummary {
  airDate: string;
  title: string;
  tier?: GameTier;
  categories?: string[]; // round1 + round2 titles
}

export function listEpisodes(): EpisodeSummary[] {
  return loadEpisodes().map((e) => ({ airDate: e.airDate, title: e.title }));
}

export interface EpisodeSearchOpts {
  q?: string;
  tier?: GameTier;
  year?: number;
  limit?: number;
}

/**
 * Search episodes by query string (matches date, title, or category names),
 * tier, or year. Returns summaries sorted by date desc, capped by limit.
 */
export function searchEpisodes(opts: EpisodeSearchOpts = {}): EpisodeSummary[] {
  const { q, tier, year, limit = 50 } = opts;
  const eps = loadEpisodes();
  const needle = (q || "").toLowerCase().trim();
  const results: Array<EpisodeSummary & { score: number }> = [];
  for (const ep of eps) {
    if (tier && ep.tier !== tier) continue;
    if (year !== undefined && !ep.airDate.startsWith(String(year))) continue;
    let score = 0;
    let categoriesAllText = "";
    const cats: string[] = [];
    for (const r of ep.rounds) {
      for (const c of r.categories) cats.push(c.title);
    }
    categoriesAllText = cats.join(" • ").toLowerCase();
    if (needle) {
      const haystack = `${ep.airDate} ${ep.title} ${categoriesAllText}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      // Prioritize matches in title/date over deep category hits
      if (ep.airDate.toLowerCase().includes(needle)) score += 10;
      if (ep.title.toLowerCase().includes(needle)) score += 5;
      if (categoriesAllText.includes(needle)) score += 1;
    }
    results.push({
      airDate: ep.airDate,
      title: ep.title,
      tier: ep.tier,
      categories: cats,
      score,
    });
  }
  // Sort: needle-match score first, then date desc.
  results.sort((a, b) => b.score - a.score || b.airDate.localeCompare(a.airDate));
  return results.slice(0, limit).map(({ score, ...rest }) => rest);
}

export function getEpisodeByAirDate(airDate: string): GameDef | null {
  const ep = loadEpisodes().find((e) => e.airDate === airDate);
  if (!ep) return null;
  const { airDate: _ignore, ...def } = ep;
  return def;
}

export function getRandomEpisode(): GameDef {
  const eps = loadEpisodes();
  if (eps.length === 0) return loadSample();
  const ep = eps[Math.floor(Math.random() * eps.length)]!;
  const { airDate: _i, ...def } = ep;
  return def;
}

function pickN<T>(arr: T[], n: number): T[] {
  const indices = new Set<number>();
  while (indices.size < Math.min(n, arr.length)) {
    indices.add(Math.floor(Math.random() * arr.length));
  }
  return [...indices].map((i) => arr[i]!);
}

/**
 * Mix-and-match: pull 6 random round-1 categories and 6 random round-2
 * categories from the pool, plus a random Final.
 *
 * This breaks airing-day coherence but gives endless variety for parties.
 */
export function getMixAndMatchGame(): GameDef {
  const pool = loadPool();
  if (!pool) return loadSample();
  const r1cats = pickN(pool.round1, 6);
  const r2cats = pickN(pool.round2, 6);
  const final = pool.finals[Math.floor(Math.random() * pool.finals.length)]!;
  return {
    title: `Pardy — Mix & Match`,
    rounds: [{ categories: r1cats }, { categories: r2cats }] as [Round, Round],
    final,
  };
}

export type GameMode = "episode" | "mix" | "sample" | "tier";

export function listEpisodesByTier(): Record<GameTier, number> {
  const counts: Record<GameTier, number> = {
    regular: 0,
    kids: 0,
    teen: 0,
    college: 0,
    celebrity: 0,
    tournament: 0,
    custom: 0,
  };
  for (const ep of loadEpisodes()) {
    if (ep.tier) counts[ep.tier] = (counts[ep.tier] || 0) + 1;
  }
  return counts;
}

export function getRandomEpisodeByTier(tier: GameTier): GameDef | null {
  const pool = loadEpisodes().filter((e) => e.tier === tier);
  if (pool.length === 0) return null;
  const ep = pool[Math.floor(Math.random() * pool.length)]!;
  const { airDate: _i, tier: _t, ...def } = ep;
  return def;
}

export function loadGame(
  mode: GameMode,
  airDate?: string,
  tier?: GameTier,
): GameDef {
  if (mode === "sample") return loadSample();
  if (mode === "tier" && tier) {
    const ep = getRandomEpisodeByTier(tier);
    if (ep) return ep;
    // Fallback: any episode.
    return getRandomEpisode();
  }
  if (mode === "episode") {
    if (airDate) {
      const ep = getEpisodeByAirDate(airDate);
      if (ep) return ep;
    }
    return getRandomEpisode();
  }
  return getMixAndMatchGame();
}
