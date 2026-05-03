let state = null;
let info = null;
let ws = null;
let reconnectDelay = 500;
let lastPhase = null;
let lastClueKey = null;
let ttsFallbackTimer = null;

const $ = (id) => document.getElementById(id);
const audioEl = $("tts");

const SCREENS = [
  "lobby",
  "board-screen",
  "dd-wager-screen",
  "round-break-screen",
  "final-wager-screen",
  "final-prompt-screen",
  "final-reveal-screen",
  "game-over-screen",
];

function showScreen(id) {
  for (const s of SCREENS) {
    const el = $(s);
    if (el) el.hidden = s !== id;
  }
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect() {
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsScheme}://${location.host}/ws?role=host`);

  ws.addEventListener("open", () => {
    reconnectDelay = 500;
    send({ type: "host:hello" });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });

  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case "state":
      state = msg.state;
      render();
      break;
    case "tts":
      playTts(msg.url, msg.tag);
      break;
    case "judging":
      $("judging-pill").hidden = false;
      break;
    case "error":
      toast(msg.message);
      break;
    default:
      break;
  }
}

function playTts(url, tag) {
  if (ttsFallbackTimer) {
    clearTimeout(ttsFallbackTimer);
    ttsFallbackTimer = null;
  }

  const finish = () => {
    if (ttsFallbackTimer) {
      clearTimeout(ttsFallbackTimer);
      ttsFallbackTimer = null;
    }
    audioEl.removeEventListener("ended", onEnd);
    audioEl.removeEventListener("error", onEnd);
    send({ type: "host:ttsDone", tag });
  };

  const onEnd = () => finish();

  if (!url) {
    send({ type: "host:ttsDone", tag });
    return;
  }

  audioEl.addEventListener("ended", onEnd, { once: true });
  audioEl.addEventListener("error", onEnd, { once: true });
  audioEl.src = url;
  const p = audioEl.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => finish());
  }
  ttsFallbackTimer = setTimeout(finish, 30000);
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

async function loadInfo() {
  try {
    const res = await fetch("/api/info");
    info = await res.json();
    if (info.gameTitle) $("game-title").textContent = info.gameTitle;
    if (info.joinUrl) $("join-url").textContent = info.joinUrl;
    renderTierPicker();
  } catch (e) {
    console.warn("info fetch failed", e);
  }
}

const TIER_LABELS = {
  regular: "Regular",
  kids: "Kids Week",
  teen: "Teen Tournament",
  college: "College Champ.",
  celebrity: "Celebrity",
  tournament: "Tournament",
};
const TIER_ORDER = ["kids", "teen", "celebrity", "college", "tournament", "regular"];

function renderTierPicker() {
  if (!info || !info.tiers) return;
  const grid = $("tier-grid");
  grid.innerHTML = "";
  for (const t of TIER_ORDER) {
    const count = info.tiers[t] || 0;
    const btn = document.createElement("button");
    btn.className = "tier-btn" + (count === 0 ? " disabled" : "");
    btn.dataset.tier = t;
    btn.disabled = count === 0;
    btn.innerHTML = `${TIER_LABELS[t]}<span class="count">${count}</span>`;
    btn.addEventListener("click", () => pickTier(t));
    grid.appendChild(btn);
  }
  $("tier-current").textContent = state && state.gameTitle ? state.gameTitle : "";
}

function pickTier(tier) {
  send({ type: "host:resetGame", reloadGame: true, tier });
}

document.addEventListener("DOMContentLoaded", () => {
  const mix = document.getElementById("tier-mix-btn");
  const reroll = document.getElementById("tier-reroll-btn");
  if (mix) mix.addEventListener("click", () => {
    send({ type: "host:resetGame", reloadGame: true });
  });
  if (reroll) reroll.addEventListener("click", () => {
    // Re-roll: send the current title's inferred tier if we can detect it
    const title = state && state.gameTitle ? state.gameTitle : "";
    let tier = null;
    for (const t of Object.keys(TIER_LABELS)) {
      if (title.toLowerCase().includes(TIER_LABELS[t].toLowerCase().split(" ")[0])) {
        tier = t;
        break;
      }
    }
    send({ type: "host:resetGame", reloadGame: true, tier: tier || undefined });
  });
});

/* === Render === */

function render() {
  if (!state) return;
  const phase = state.phase;

  renderTopBar();
  renderScoreboard();

  // Detect phase / clue change to retrigger countdown animation
  const clueKey = state.currentClue
    ? `${state.currentClue.round}-${state.currentClue.cat}-${state.currentClue.idx}`
    : null;
  const phaseChanged = phase !== lastPhase || clueKey !== lastClueKey;
  lastPhase = phase;
  lastClueKey = clueKey;

  // Hide judging pill unless we are still in JUDGING
  if (phase !== "JUDGING") $("judging-pill").hidden = true;

  // Pick screen
  if (phase === "LOBBY") {
    showScreen("lobby");
    renderLobby();
  } else if (
    phase === "PICKING" ||
    phase === "READING" ||
    phase === "OPEN" ||
    phase === "ANSWERING" ||
    phase === "JUDGING" ||
    phase === "RESOLVED"
  ) {
    showScreen("board-screen");
    renderBoard();
    renderClueOverlay(phaseChanged);
  } else if (phase === "DD_WAGER") {
    showScreen("dd-wager-screen");
    renderDdWager();
  } else if (phase === "DD_ANSWERING") {
    showScreen("board-screen");
    renderBoard();
    renderClueOverlay(phaseChanged);
  } else if (phase === "ROUND_BREAK") {
    showScreen("round-break-screen");
  } else if (phase === "FINAL_WAGER") {
    showScreen("final-wager-screen");
    renderFinalWager();
  } else if (phase === "FINAL_READING" || phase === "FINAL_ANSWERING") {
    showScreen("final-prompt-screen");
    renderFinalPrompt(phaseChanged);
  } else if (phase === "FINAL_REVEAL") {
    showScreen("final-reveal-screen");
    renderFinalReveal();
  } else if (phase === "GAME_OVER") {
    showScreen("game-over-screen");
    renderGameOver();
  }

  renderFloatingControls();
}

function renderTopBar() {
  const phase = state.phase;
  const labels = {
    0: "Jeopardy",
    1: "Double Jeopardy",
  };
  let indicator = "";
  if (phase === "LOBBY") indicator = "Lobby";
  else if (
    phase === "FINAL_WAGER" ||
    phase === "FINAL_READING" ||
    phase === "FINAL_ANSWERING" ||
    phase === "FINAL_REVEAL"
  )
    indicator = "Final Jeopardy";
  else if (phase === "GAME_OVER") indicator = "Game Over";
  else if (phase === "ROUND_BREAK") indicator = "Round Break";
  else indicator = labels[state.round] || "";
  $("round-indicator").textContent = indicator;

  if (state.gameTitle) $("game-title").textContent = state.gameTitle;

  const startBtn = $("start-btn");
  const showStart = phase === "LOBBY";
  startBtn.hidden = !showStart;
  startBtn.disabled = !(state.players && state.players.length >= 2);
}

function renderLobby() {
  const list = $("lobby-players");
  list.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "conn-dot" + (p.connected ? "" : " off");
    li.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = p.name;
    li.appendChild(name);
    list.appendChild(li);
  }
  const tierCurrent = $("tier-current");
  if (tierCurrent) tierCurrent.textContent = state.gameTitle || "";
}

function renderBoard() {
  const board = $("board");
  const round = state.rounds[state.round];
  if (!round) {
    board.innerHTML = "";
    return;
  }

  const picker = state.players.find((p) => p.id === state.pickerId);
  const banner = $("picker-banner");
  if (state.phase === "PICKING" && picker) {
    banner.textContent = `${picker.name} is picking…`;
    banner.classList.remove("empty");
  } else {
    banner.textContent = "";
    banner.classList.add("empty");
  }

  // Build/refresh board cells in-place when shape unchanged
  const expectedCount = 6 + 6 * 5;
  if (board.children.length !== expectedCount) {
    board.innerHTML = "";
    for (let c = 0; c < 6; c++) {
      const cat = document.createElement("div");
      cat.className = "cat-cell";
      board.appendChild(cat);
    }
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 6; c++) {
        const cell = document.createElement("div");
        cell.className = "value-cell";
        cell.dataset.cat = String(c);
        cell.dataset.idx = String(r);
        cell.addEventListener("click", () => {
          if (state.phase === "PICKING" && !cell.classList.contains("taken")) {
            send({
              type: "host:pickQuestion",
              cat: Number(cell.dataset.cat),
              idx: Number(cell.dataset.idx),
            });
          }
        });
        board.appendChild(cell);
      }
    }
  }

  for (let c = 0; c < 6; c++) {
    const catEl = board.children[c];
    catEl.textContent = round.categories[c]?.title || "";
  }
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 6; c++) {
      const cell = board.children[6 + r * 6 + c];
      const data = round.categories[c]?.cells[r];
      const taken = !!data?.taken;
      const missing = !!data?.missing;
      cell.classList.toggle("taken", taken);
      cell.classList.toggle("missing", missing);
      cell.classList.toggle(
        "pickable",
        state.phase === "PICKING" && !taken,
      );
      cell.textContent = missing ? "—" : taken ? "" : `$${data?.value ?? ""}`;
    }
  }
}

function renderClueOverlay(phaseChanged) {
  const overlay = $("clue-overlay");
  const phase = state.phase;
  const showOverlay =
    state.currentClue &&
    (phase === "READING" ||
      phase === "OPEN" ||
      phase === "ANSWERING" ||
      phase === "JUDGING" ||
      phase === "RESOLVED" ||
      phase === "DD_ANSWERING");

  if (!showOverlay) {
    overlay.hidden = true;
    return;
  }

  overlay.hidden = false;
  const c = state.currentClue;
  $("clue-value").textContent = `$${c.value}`;
  $("clue-prompt").textContent = c.prompt || "";
  $("clue-dd-splash").hidden = !c.dailyDouble || phase !== "READING";

  const ans = $("clue-answer");
  if (c.revealedAnswer) {
    ans.hidden = false;
    ans.textContent = c.revealedAnswer;
  } else {
    ans.hidden = true;
    ans.textContent = "";
  }

  // Progress bar reset
  const prog = $("clue-progress");
  prog.classList.remove("run-10", "run-12");
  // Force reflow so animation restarts
  void prog.offsetWidth;
  if (phase === "OPEN") prog.classList.add("run-10");
  else if (phase === "ANSWERING" || phase === "DD_ANSWERING")
    prog.classList.add("run-12");

  $("judging-pill").hidden = phase !== "JUDGING";
}

function renderDdWager() {
  const picker = state.players.find((p) => p.id === state.pickerId);
  const text = $("dd-wager-text");
  const name = picker ? picker.name : "Player";
  if (state.ddWager != null) {
    text.innerHTML = `${escapeHtml(name)} wagered <span class="amount">$${state.ddWager}</span>`;
  } else {
    text.innerHTML = `${escapeHtml(name)} is wagering…`;
  }
}

function renderFinalWager() {
  $("final-category").textContent = state.finalCategory || "";
  const list = $("final-wager-list");
  list.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = p.name;
    li.appendChild(name);
    const status = document.createElement("span");
    if (state.finalWagerSubmitted && state.finalWagerSubmitted[p.id]) {
      status.className = "check";
      status.textContent = "✓ wagered";
    } else {
      status.className = "pending";
      status.textContent = "…";
    }
    li.appendChild(status);
    list.appendChild(li);
  }
}

function renderFinalPrompt() {
  $("final-category-2").textContent = state.finalCategory || "";
  const promptEl = $("final-prompt");
  const c = state.currentClue;
  promptEl.textContent = c?.prompt || "";
  const answering = state.phase === "FINAL_ANSWERING";
  $("final-answering-text").hidden = !answering;
  const fp = $("final-progress");
  if (answering) {
    fp.hidden = false;
    const bar = $("final-progress-bar");
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = "";
  } else {
    fp.hidden = true;
  }
}

function renderFinalReveal() {
  const r = state.finalReveal;
  if (!r) return;
  const player = state.players.find((p) => p.id === r.playerId);
  $("reveal-name").textContent = player ? player.name : "Player";
  $("reveal-transcript").textContent = r.transcript || "(no answer)";
  const result = $("reveal-result");
  if (r.correct === true) {
    result.textContent = "✓";
    result.className = "correct";
  } else if (r.correct === false) {
    result.textContent = "✗";
    result.className = "incorrect";
  } else {
    result.textContent = "";
    result.className = "";
  }
  $("reveal-wager").textContent = `Wager: $${r.wager}`;
  const ans = state.currentClue?.revealedAnswer;
  $("reveal-correct").textContent = ans ? `Correct: ${ans}` : "";
}

function renderGameOver() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  $("winner-banner").textContent = winner
    ? `${winner.name} wins with $${winner.score}!`
    : "Game Over";
  const list = $("final-scoreboard");
  list.innerHTML = "";
  sorted.forEach((p, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "winner";
    li.textContent = `${p.name} — $${p.score}`;
    list.appendChild(li);
  });
}

function renderScoreboard() {
  const sb = $("scoreboard");
  if (sb.children.length !== state.players.length) {
    sb.innerHTML = "";
    for (let i = 0; i < state.players.length; i++) {
      const card = document.createElement("div");
      card.className = "player-card";
      card.innerHTML = `
        <button class="kick-btn" title="Remove player" data-action="kickPlayer">×</button>
        <div class="mic" hidden>🎤</div>
        <div class="name"></div>
        <div class="score"></div>
      `;
      sb.appendChild(card);
    }
  }
  state.players.forEach((p, i) => {
    const card = sb.children[i];
    card.dataset.playerId = p.id;
    card.classList.toggle("disconnected", !p.connected);
    card.classList.toggle("picker", p.id === state.pickerId);
    card.querySelector(".name").textContent = p.name;
    const scoreEl = card.querySelector(".score");
    scoreEl.textContent = (p.score < 0 ? "-$" : "$") + Math.abs(p.score);
    scoreEl.classList.toggle("negative", p.score < 0);
    card.querySelector(".mic").hidden = state.buzzedPlayerId !== p.id;
  });
}

function renderFloatingControls() {
  const phase = state.phase;
  const openCtrl = $("open-controls");
  const resCtrl = $("resolved-controls");

  openCtrl.hidden = !(phase === "OPEN" || phase === "ANSWERING");

  // Override controls stay live whenever there's a lastJudgement, regardless
  // of phase. Auto-advance moves the game forward; the host can still flip
  // the ruling retroactively.
  const overrideC = resCtrl.querySelector('[data-action="overrideCorrect"]');
  const overrideI = resCtrl.querySelector('[data-action="overrideIncorrect"]');
  const advance = resCtrl.querySelector('[data-action="advance"]');

  const showOverride = !!state.lastJudgement;
  // Hide Continue except in cases where the user might want a manual nudge
  // (mostly disused now that ttsDone auto-advances).
  const showAdvance = phase === "RESOLVED" || phase === "ROUND_BREAK" || phase === "FINAL_REVEAL";
  resCtrl.hidden = !(showOverride || showAdvance);
  overrideC.hidden = !showOverride;
  overrideI.hidden = !showOverride;
  advance.hidden = !showAdvance;
  if (showOverride) {
    overrideC.disabled = state.lastJudgement.correct === true;
    overrideI.disabled = state.lastJudgement.correct === false;
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* === Wire up controls === */

$("start-btn").addEventListener("click", () => {
  if (state && state.phase === "LOBBY" && state.players.length >= 2) {
    send({ type: "host:start" });
  }
});

$("end-game-btn").addEventListener("click", () => {
  if (confirm("End game?")) send({ type: "host:endGame" });
});

$("restart-btn").addEventListener("click", () => {
  if (confirm("Restart game? Scores reset, players stay.")) {
    send({ type: "host:resetGame" });
  }
});

$("new-game-btn").addEventListener("click", () => {
  if (confirm("Load a fresh episode? Scores reset, players stay.")) {
    send({ type: "host:resetGame", reloadGame: true });
  }
});

document.addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  if (!action) return;
  switch (action) {
    case "pass":
      send({ type: "host:pass" });
      break;
    case "advance":
      send({ type: "host:advance" });
      break;
    case "revealNext":
      send({ type: "host:revealNextFinal" });
      break;
    case "overrideCorrect":
      send({ type: "host:override", correct: true });
      break;
    case "overrideIncorrect":
      send({ type: "host:override", correct: false });
      break;
    case "kickPlayer": {
      const card = target.closest(".player-card");
      const pid = card && card.dataset.playerId;
      if (!pid) break;
      const player = state && state.players.find((p) => p.id === pid);
      if (!player) break;
      if (confirm(`Remove ${player.name}?`)) {
        send({ type: "host:kickPlayer", playerId: pid });
      }
      break;
    }
  }
});

/* === Boot === */

loadInfo();
connect();
