import "dotenv/config";

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { networkInterfaces, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import qrcode from "qrcode";

import {
  apply,
  emptyState,
  publicView,
  type Effect,
  type StateEvent,
} from "./state.js";
import {
  loadGame,
  type GameMode,
  listEpisodes,
  listEpisodesByTier,
} from "./games.js";
import type {
  ClientMessage,
  GameDef,
  GameState,
  Player,
  PublicState,
  ServerMessage,
  TtsTag,
} from "./types.js";
import { judgeAnswer, matchPick, type BoardCell } from "./judge.js";
import { buildCustomBoard, type PlayerProfile } from "./board_builder.js";
import {
  synthesizeSpeech,
  transcribeAudio,
  ttsHealth,
  sttHealth,
} from "./voice.js";

const PORT = parseInt(process.env.PORT || "3030", 10);
const PUBLIC_DIR = resolve(import.meta.dirname, "..", "public");

// ---------- shared mutable game ----------

interface PlayerSocket {
  ws: WebSocket;
  playerId: string;
}

interface World {
  def: GameDef;
  state: GameState;
  hostSockets: Set<WebSocket>;
  playerSockets: Map<string, PlayerSocket[]>; // playerId -> sockets
  rejoinTokens: Map<string, string>; // token -> playerId
  buzzTimer: NodeJS.Timeout | null;
  answerTimer: NodeJS.Timeout | null;
  finalTimer: NodeJS.Timeout | null;
  pendingFinalAnswers: Set<string>; // playerIds expected to answer
  audioStore: Map<string, { buf: Buffer; mime: string }>;
}

function freshStateFor(def: GameDef) {
  const s = emptyState();
  // Auto-mark any "missing" cells (clues that were skipped on the original
  // air) as already taken, so they show greyed-out from the start.
  for (let r = 0; r < 2; r++) {
    const round = def.rounds[r as 0 | 1];
    for (let c = 0; c < round.categories.length; c++) {
      const cat = round.categories[c]!;
      for (let i = 0; i < cat.clues.length; i++) {
        if (cat.clues[i]?.missing) s.taken[r as 0 | 1][c]![i] = true;
      }
    }
  }
  return s;
}

const initialDef = loadGame(
  (process.env.GAME_MODE as GameMode) || "mix",
  process.env.GAME_AIR_DATE,
);

const world: World = {
  def: initialDef,
  state: freshStateFor(initialDef),
  hostSockets: new Set(),
  playerSockets: new Map(),
  rejoinTokens: new Map(),
  buzzTimer: null,
  answerTimer: null,
  finalTimer: null,
  pendingFinalAnswers: new Set(),
  audioStore: new Map(),
};

console.log(`[pardy] loaded game: ${world.def.title}`);

// ---------- helpers ----------

function lanIp(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(): void {
  const view: PublicState = publicView(world.state, world.def);
  const msg: ServerMessage = { type: "state", state: view };
  for (const ws of world.hostSockets) send(ws, msg);
  for (const sockets of world.playerSockets.values()) {
    for (const s of sockets) send(s.ws, msg);
  }
}

function sendToPlayer(playerId: string, msg: ServerMessage): void {
  const sockets = world.playerSockets.get(playerId);
  if (!sockets) return;
  for (const s of sockets) send(s.ws, msg);
}

function sendToHosts(msg: ServerMessage): void {
  for (const ws of world.hostSockets) send(ws, msg);
}

function clearTimers(): void {
  if (world.buzzTimer) clearTimeout(world.buzzTimer);
  if (world.answerTimer) clearTimeout(world.answerTimer);
  world.buzzTimer = null;
  world.answerTimer = null;
}

// ---------- effect runner ----------

function dispatch(event: StateEvent): void {
  const result = apply(world.state, event, world.def);
  world.state = result.state;
  for (const eff of result.effects) {
    runEffect(eff);
  }
}

function runEffect(eff: Effect): void {
  switch (eff.type) {
    case "broadcast":
      broadcastState();
      break;
    case "speak":
      void speakAndAnnounce(eff.tag, eff.text);
      break;
    case "openBuzzWindow":
      // 10s window; if no one buzzes, mark passed.
      clearTimers();
      world.buzzTimer = setTimeout(() => {
        dispatch({ type: "buzzTimeout" });
      }, 10_000);
      break;
    case "startAnswerWindow": {
      const playerId = eff.playerId;
      sendToPlayer(playerId, { type: "youBuzzed" });
      clearTimers();
      // Player has 8s to record + submit.
      world.answerTimer = setTimeout(() => {
        dispatch({ type: "answerTimeout", playerId });
      }, 12_000);
      break;
    }
    case "startFinalAnswerWindow": {
      // Tell every wagering player to record.
      world.pendingFinalAnswers = new Set(
        Object.keys(world.state.finalWagers),
      );
      for (const pid of world.pendingFinalAnswers) {
        sendToPlayer(pid, { type: "youBuzzed" });
      }
      // 30s to record.
      if (world.finalTimer) clearTimeout(world.finalTimer);
      world.finalTimer = setTimeout(() => {
        // Any non-submitting players: insert empty transcripts so judging proceeds.
        for (const pid of world.pendingFinalAnswers) {
          dispatch({
            type: "finalAnswerTranscribed",
            playerId: pid,
            transcript: "",
          });
        }
      }, 30_000);
      break;
    }
    case "judge":
      void runJudge(eff);
      break;
    case "judgeFinal":
      void runFinalJudge(eff);
      break;
    case "promptPlayerToBuzz":
      sendToPlayer(eff.playerId, { type: "youBuzzed" });
      break;
    case "promptInterview":
      sendToPlayer(eff.playerId, { type: "youBuzzed" });
      break;
    case "buildBoard":
      void runBoardBuild();
      break;
  }
}

async function runBoardBuild(): Promise<void> {
  const profiles: PlayerProfile[] = [];
  for (const pid of world.state.interviewQueue) {
    const player = world.state.players.find((p) => p.id === pid);
    const transcript = world.state.interviewTranscripts[pid];
    if (player && transcript) {
      profiles.push({ name: player.name, transcript });
    }
  }
  if (profiles.length === 0) {
    dispatch({ type: "boardBuildFailed", reason: "no interview transcripts" });
    return;
  }
  try {
    console.log(`[board] building custom board for ${profiles.length} player(s) with Opus 4.7…`);
    const startedAt = Date.now();
    const def = await buildCustomBoard(profiles);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[board] built "${def.title}" in ${elapsed}s`);
    world.def = def;
    dispatch({ type: "boardBuildCompleted" });
  } catch (err) {
    console.error(`[board] build failed:`, err);
    sendToHosts({
      type: "error",
      message: `Board build failed: ${(err as Error).message}`,
    });
    dispatch({ type: "boardBuildFailed", reason: (err as Error).message });
  }
}

async function speakAndAnnounce(tag: TtsTag, text: string): Promise<void> {
  try {
    const buf = await synthesizeSpeech(text);
    const id = randomUUID();
    world.audioStore.set(id, { buf, mime: "audio/wav" });
    // Free old entries to avoid leaking.
    if (world.audioStore.size > 64) {
      const oldest = world.audioStore.keys().next().value;
      if (oldest) world.audioStore.delete(oldest);
    }
    const url = `/audio/${id}.wav`;
    sendToHosts({ type: "tts", url, tag });
  } catch (err) {
    console.error(`[tts] failed:`, err);
    // Still send a marker so the host can simulate "ttsDone" via timer.
    sendToHosts({ type: "tts", url: "", tag });
  }
}

async function runJudge(eff: Extract<Effect, { type: "judge" }>): Promise<void> {
  sendToHosts({ type: "judging" });
  const ref = world.state.currentClue;
  if (!ref) return;
  const cat = world.def.rounds[ref.round].categories[ref.cat]!;
  try {
    const result = await judgeAnswer({
      category: cat.title,
      prompt: eff.clue.prompt,
      correctAnswer: eff.clue.answer,
      transcribedGuess: eff.transcript,
    });
    // Stash transcript on lastJudgement after dispatch (apply doesn't see transcript).
    dispatch({ type: "judgement", correct: result.correct, riff: result.riff });
    // Patch the lastJudgement transcript directly for display.
    if (world.state.lastJudgement) {
      world.state.lastJudgement.transcript = eff.transcript;
      broadcastState();
    }
  } catch (err) {
    console.error(`[judge] failed:`, err);
    sendToHosts({
      type: "error",
      message: `Judge failed: ${(err as Error).message}`,
    });
    // Treat as wrong so the game can continue; host can override.
    dispatch({ type: "judgement", correct: false, riff: null });
    if (world.state.lastJudgement) {
      world.state.lastJudgement.transcript = eff.transcript;
      broadcastState();
    }
  }
}

async function runFinalJudge(
  eff: Extract<Effect, { type: "judgeFinal" }>,
): Promise<void> {
  try {
    const result = await judgeAnswer({
      category: world.def.final.category,
      prompt: world.def.final.prompt,
      correctAnswer: world.def.final.answer,
      transcribedGuess: eff.transcript,
      isFinal: true,
    });
    dispatch({
      type: "finalJudgement",
      playerId: eff.playerId,
      correct: result.correct,
    });
  } catch (err) {
    console.error(`[finalJudge] failed:`, err);
    dispatch({
      type: "finalJudgement",
      playerId: eff.playerId,
      correct: false,
    });
  }
}

// ---------- WS routing ----------

function handlePlayerJoin(ws: WebSocket, name: string, rejoinToken?: string): void {
  let playerId: string | null = null;
  let token: string | null = null;
  if (rejoinToken) {
    const existing = world.rejoinTokens.get(rejoinToken);
    if (existing) {
      playerId = existing;
      token = rejoinToken;
      const player = world.state.players.find((p) => p.id === existing);
      if (player) {
        player.name = name || player.name;
        player.connected = true;
      }
    }
  }
  if (!playerId) {
    playerId = randomUUID();
    token = randomUUID();
    world.rejoinTokens.set(token, playerId);
    const player: Player = {
      id: playerId,
      name: name || "Player",
      score: 0,
      connected: true,
      token,
    };
    dispatch({ type: "addPlayer", player });
  } else {
    dispatch({ type: "setConnected", playerId, connected: true });
  }
  // Track socket.
  const list = world.playerSockets.get(playerId) ?? [];
  list.push({ ws, playerId });
  world.playerSockets.set(playerId, list);
  send(ws, { type: "joined", playerId, rejoinToken: token! });
  broadcastState();
}

function handlePlayerDisconnect(ws: WebSocket): void {
  for (const [pid, sockets] of world.playerSockets) {
    const filtered = sockets.filter((s) => s.ws !== ws);
    if (filtered.length === 0) {
      world.playerSockets.delete(pid);
      dispatch({ type: "setConnected", playerId: pid, connected: false });
    } else {
      world.playerSockets.set(pid, filtered);
    }
  }
}

function onClientMessage(
  ws: WebSocket,
  isHost: boolean,
  msg: ClientMessage,
): void {
  if (msg.type === "host:hello") {
    if (!isHost) return;
    return;
  }
  if (msg.type === "host:ttsDone") {
    if (!isHost) return;
    dispatch({ type: "ttsDone", tag: msg.tag });
    return;
  }
  if (msg.type === "player:join") {
    handlePlayerJoin(ws, msg.name, msg.rejoinToken);
    return;
  }
  // Player-tagged operations require a known socket -> playerId mapping.
  const playerId = playerIdForSocket(ws);
  switch (msg.type) {
    case "host:start":
      if (isHost) dispatch({ type: "startGame" });
      break;
    case "host:pickQuestion":
      if (isHost && world.state.pickerId) {
        dispatch({
          type: "pickQuestion",
          playerId: world.state.pickerId,
          cat: msg.cat,
          idx: msg.idx,
        });
      }
      break;
    case "host:override":
      if (isHost) dispatch({ type: "override", correct: msg.correct });
      break;
    case "host:pass":
      if (isHost) dispatch({ type: "pass" });
      break;
    case "host:advance":
      if (isHost) dispatch({ type: "advance" });
      break;
    case "host:nextRound":
      if (isHost) dispatch({ type: "advance" });
      break;
    case "host:revealNextFinal":
      if (isHost) dispatch({ type: "revealNextFinal" });
      break;
    case "host:endGame":
      if (isHost) dispatch({ type: "endGame" });
      break;
    case "host:resetGame":
      if (isHost) {
        clearTimers();
        if (world.finalTimer) clearTimeout(world.finalTimer);
        world.finalTimer = null;
        world.audioStore.clear();
        world.pendingFinalAnswers.clear();
        if (msg.reloadGame) {
          const tier = msg.tier;
          world.def = loadGame(
            tier ? "tier" : ((process.env.GAME_MODE as GameMode) || "mix"),
            process.env.GAME_AIR_DATE,
            tier,
          );
          console.log(`[pardy] reloaded game: ${world.def.title}`);
        }
        // Preserve players + their identities; rebuild taken with missing-cell handling.
        const players = world.state.players.map((p) => ({ ...p, score: 0 }));
        const fresh = freshStateFor(world.def);
        fresh.players = players;
        world.state = fresh;
        broadcastState();
      }
      break;
    case "host:startInterview":
      if (isHost) {
        clearTimers();
        world.audioStore.clear();
        dispatch({ type: "startInterview" });
      }
      break;
    case "host:skipInterviewPlayer":
      if (isHost) dispatch({ type: "skipInterviewPlayer" });
      break;
    case "host:cancelInterview":
      if (isHost) dispatch({ type: "cancelInterview" });
      break;
    case "host:kickPlayer":
      if (isHost) {
        const sockets = world.playerSockets.get(msg.playerId) ?? [];
        for (const s of sockets) {
          send(s.ws, { type: "kicked", reason: "Removed by host" });
          try { s.ws.close(); } catch {}
        }
        world.playerSockets.delete(msg.playerId);
        // Drop their rejoin token(s).
        for (const [tok, pid] of world.rejoinTokens) {
          if (pid === msg.playerId) world.rejoinTokens.delete(tok);
        }
        dispatch({ type: "removePlayer", playerId: msg.playerId });
      }
      break;
    case "player:buzz":
      if (playerId) dispatch({ type: "buzz", playerId });
      break;
    case "player:answer":
      if (playerId) {
        void handlePlayerAnswer(playerId, msg.audioBase64, msg.mimeType);
      }
      break;
    case "player:pickVoice":
      if (playerId) {
        void handlePlayerPickVoice(playerId, msg.audioBase64, msg.mimeType);
      }
      break;
    case "player:interview":
      if (playerId) {
        void handlePlayerInterview(playerId, msg.audioBase64, msg.mimeType);
      }
      break;
    case "player:wager":
      if (playerId) {
        dispatch({ type: "wager", playerId, amount: msg.amount });
      }
      break;
  }
}

function playerIdForSocket(ws: WebSocket): string | null {
  for (const [pid, sockets] of world.playerSockets) {
    if (sockets.some((s) => s.ws === ws)) return pid;
  }
  return null;
}

async function handlePlayerInterview(
  playerId: string,
  audioBase64: string,
  mimeType: string,
): Promise<void> {
  if (world.state.phase !== "INTERVIEW") return;
  const expected =
    world.state.interviewQueue[world.state.interviewIdx] ?? null;
  if (expected !== playerId) return;
  let transcript = "";
  try {
    const buf = Buffer.from(audioBase64, "base64");
    transcript = await transcribeAudio(buf, mimeType);
  } catch (err) {
    console.error(`[interview] STT failed:`, err);
    sendToPlayer(playerId, {
      type: "error",
      message: `Couldn't hear you — try again.`,
    });
    return;
  }
  console.log(
    `[interview] ${playerId} (${world.state.players.find((p) => p.id === playerId)?.name}): "${transcript.slice(0, 100)}…"`,
  );
  dispatch({ type: "interviewTranscribed", playerId, transcript });
}

async function handlePlayerPickVoice(
  playerId: string,
  audioBase64: string,
  mimeType: string,
): Promise<void> {
  if (world.state.phase !== "PICKING") return;
  if (world.state.pickerId !== playerId) return;
  let transcript = "";
  try {
    const buf = Buffer.from(audioBase64, "base64");
    transcript = await transcribeAudio(buf, mimeType);
  } catch (err) {
    console.error(`[stt] pick failed:`, err);
    sendToPlayer(playerId, {
      type: "error",
      message: `Couldn't hear you — try again.`,
    });
    return;
  }
  // Build the available-cells list for the current round.
  const round = world.def.rounds[world.state.round];
  const taken = world.state.taken[world.state.round];
  const available: BoardCell[] = [];
  for (let c = 0; c < round.categories.length; c++) {
    const cat = round.categories[c]!;
    for (let i = 0; i < cat.clues.length; i++) {
      if (taken[c]?.[i]) continue;
      available.push({
        cat: c,
        idx: i,
        category: cat.title,
        value: cat.clues[i]!.value,
      });
    }
  }
  const result = await matchPick(transcript, available);
  console.log(
    `[pick] "${transcript}" → cat=${result.cat} idx=${result.idx} (${result.reason})`,
  );
  if (result.cat === null || result.idx === null) {
    sendToPlayer(playerId, {
      type: "error",
      message: `Didn't catch that ("${transcript}"). Try again — say the category and dollar amount.`,
    });
    sendToHosts({
      type: "error",
      message: `Pick unclear: "${transcript}"`,
    });
    return;
  }
  dispatch({
    type: "pickQuestion",
    playerId,
    cat: result.cat,
    idx: result.idx,
  });
}

async function handlePlayerAnswer(
  playerId: string,
  audioBase64: string,
  mimeType: string,
): Promise<void> {
  let transcript = "";
  try {
    const buf = Buffer.from(audioBase64, "base64");
    transcript = await transcribeAudio(buf, mimeType);
  } catch (err) {
    console.error(`[stt] failed:`, err);
    sendToHosts({
      type: "error",
      message: `STT failed: ${(err as Error).message}`,
    });
  }
  // Route to either standard answer or final answer.
  if (
    world.state.phase === "FINAL_ANSWERING" &&
    world.pendingFinalAnswers.has(playerId)
  ) {
    world.pendingFinalAnswers.delete(playerId);
    dispatch({
      type: "finalAnswerTranscribed",
      playerId,
      transcript,
    });
  } else {
    dispatch({ type: "answerTranscribed", playerId, transcript });
  }
}

// ---------- HTTP ----------

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  try {
    const full = resolve(PUBLIC_DIR, "." + path);
    if (!full.startsWith(PUBLIC_DIR)) return false;
    const s = await stat(full);
    if (!s.isFile()) return false;
    const buf = await readFile(full);
    res.writeHead(200, {
      "content-type": STATIC_TYPES[extname(full)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// HTTPS is required for getUserMedia on phones over LAN. Auto-detect a cert
// in ./certs (created by `pnpm cert`) and use it; fall back to HTTP otherwise.
const CERT_KEY = resolve(import.meta.dirname, "..", "certs", "key.pem");
const CERT_CRT = resolve(import.meta.dirname, "..", "certs", "cert.pem");
const useHttps = existsSync(CERT_KEY) && existsSync(CERT_CRT);
const scheme = useHttps ? "https" : "http";

const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;

  // Audio store: GET /audio/:id.wav
  if (path.startsWith("/audio/") && req.method === "GET") {
    const id = path.replace("/audio/", "").replace(/\.wav$/, "");
    const entry = world.audioStore.get(id);
    if (!entry) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": entry.mime,
      "content-length": String(entry.buf.length),
      "cache-control": "no-cache",
    });
    res.end(entry.buf);
    return;
  }

  // QR for join URL
  if (path === "/qr" && req.method === "GET") {
    const ip = lanIp();
    const joinUrl = `${scheme}://${ip}:${PORT}/buzzer`;
    const png = await qrcode.toBuffer(joinUrl, {
      width: 320,
      margin: 1,
      color: { dark: "#0b0b3b", light: "#ffffff" },
    });
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
    return;
  }

  // Lan info JSON
  if (path === "/api/info" && req.method === "GET") {
    const ip = lanIp();
    const ttsOk = await ttsHealth();
    const sttOk = await sttHealth();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        joinUrl: `${scheme}://${ip}:${PORT}/buzzer`,
        host: hostname(),
        gameTitle: world.def.title,
        episodeCount: listEpisodes().length,
        tiers: listEpisodesByTier(),
        services: {
          tts: ttsOk,
          stt: sttOk,
          judge: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY),
          backend: process.env.ANTHROPIC_API_KEY
            ? "anthropic"
            : process.env.OPENROUTER_API_KEY
              ? "openrouter"
              : "none",
        },
      }),
    );
    return;
  }

  // Routes
  if (path === "/" || path === "/host") {
    if (await serveStatic(req, res, "/host.html")) return;
  }
  if (path === "/buzzer") {
    if (await serveStatic(req, res, "/buzzer.html")) return;
  }

  if (await serveStatic(req, res, path)) return;
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
};

const httpServer = useHttps
  ? createHttpsServer(
      {
        key: readFileSync(CERT_KEY),
        cert: readFileSync(CERT_CRT),
      },
      requestHandler,
    )
  : createHttpServer(requestHandler);

// ---------- WS ----------

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const role = url.searchParams.get("role") === "host" ? "host" : "player";
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (role === "host") {
      world.hostSockets.add(ws);
      send(ws, { type: "state", state: publicView(world.state, world.def) });
    }
    ws.on("message", (data) => {
      let msg: ClientMessage | null = null;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string")
        return;
      try {
        onClientMessage(ws, role === "host", msg);
      } catch (err) {
        console.error(`[ws] handler error:`, err);
        send(ws, {
          type: "error",
          message: `server error: ${(err as Error).message}`,
        });
      }
    });
    ws.on("close", () => {
      if (role === "host") world.hostSockets.delete(ws);
      else handlePlayerDisconnect(ws);
    });
  });
});

httpServer.listen(PORT, () => {
  const ip = lanIp();
  console.log(`[pardy] host UI:    ${scheme}://localhost:${PORT}/host`);
  console.log(`[pardy] phone URL:  ${scheme}://${ip}:${PORT}/buzzer`);
  if (!useHttps) {
    console.log(
      `[pardy] WARNING: serving HTTP. Phones won't get mic permission prompts on LAN.`,
    );
    console.log(`[pardy]          Run \`pnpm cert\` to enable HTTPS.`);
  } else {
    console.log(
      `[pardy] HTTPS enabled (self-signed). Phones will see a cert warning the first time — tap "advanced" / "proceed".`,
    );
  }
  console.log(`[pardy] phones on the same Wi-Fi can scan the QR on the host screen.`);
});

// Host-side TTS playback completion: the host UI sends a synthetic message
// after the audio element ends so we can advance the state machine. We piggy-
// back on the existing ws channel as a host:advance for simple tags, or a
// special-cased "ttsDone" routed through onClientMessage if you wire it.
//
// We allow the host page to POST the ttsDone via the HTTP server too so it
// works even if the WS hiccups during audio playback.
httpServer.on("request", () => {});
