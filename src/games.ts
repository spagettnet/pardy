import { readFileSync, existsSync } from "node:fs";
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
  if (!existsSync(EPISODES_PATH)) {
    _episodes = [];
    return _episodes;
  }
  _episodes = JSON.parse(readFileSync(EPISODES_PATH, "utf8"));
  return _episodes!;
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
}

export function listEpisodes(): EpisodeSummary[] {
  return loadEpisodes().map((e) => ({ airDate: e.airDate, title: e.title }));
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
