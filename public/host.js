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
  "interview-screen",
  "building-screen",
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
    case "boardProgress":
      handleBoardProgress(msg);
      break;
    default:
      break;
  }
}

function handleBoardProgress(msg) {
  const phaseEl = $("building-phase");
  const detailEl = $("building-detail");
  if (phaseEl && msg.phase) phaseEl.textContent = msg.phase;
  if (detailEl) detailEl.textContent = msg.detail || "";

  const bar = $("building-progress-bar");
  if (typeof msg.total === "number" && msg.total > 0) {
    const pct = Math.round(((msg.done || 0) / msg.total) * 100);
    $("building-progress-fill").style.width = pct + "%";
    $("building-progress-label").textContent = `${msg.done ?? 0} / ${msg.total}`;
    bar.hidden = false;
  } else if (msg.phase && msg.phase.startsWith("Done")) {
    $("building-progress-fill").style.width = "100%";
  } else {
    bar.hidden = true;
  }

  // Stream events into the rolling list
  const list = $("building-events");
  if (list && msg.detail) {
    const li = document.createElement("li");
    if (msg.detail.startsWith("✓")) li.className = "ok";
    if (msg.detail.startsWith("✗")) li.className = "err";
    li.textContent = msg.detail;
    list.insertBefore(li, list.firstChild);
    while (list.children.length > 30) list.removeChild(list.lastChild);
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
  custom: "Saved Custom",
};
const TIER_ORDER = ["custom", "kids", "teen", "celebrity", "college", "tournament", "regular"];

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

/* === Episode browser === */

let epSearchTimer = null;
async function refreshEpisodeResults() {
  const q = document.getElementById("ep-search-input").value.trim();
  const tier = document.getElementById("ep-tier-select").value;
  const year = document.getElementById("ep-year-select").value;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (tier) params.set("tier", tier);
  if (year) params.set("year", year);
  params.set("limit", "60");
  const res = await fetch("/api/episodes?" + params);
  const json = await res.json();
  const ul = document.getElementById("ep-results");
  ul.innerHTML = "";
  if (!json.results || json.results.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "no matches";
    ul.appendChild(li);
    return;
  }
  for (const ep of json.results) {
    const li = document.createElement("li");
    li.dataset.airDate = ep.airDate;
    const date = document.createElement("span");
    date.className = "ep-date";
    date.textContent = ep.title.split("—")[0].trim() + " · " + ep.airDate;
    li.appendChild(date);
    if (ep.categories && ep.categories.length) {
      const cats = document.createElement("div");
      cats.className = "ep-cats";
      cats.textContent = ep.categories.slice(0, 4).join(" • ");
      li.appendChild(cats);
    }
    li.addEventListener("click", () => {
      send({ type: "host:resetGame", reloadGame: true, airDate: ep.airDate });
    });
    ul.appendChild(li);
  }
}

function debouncedSearch() {
  clearTimeout(epSearchTimer);
  epSearchTimer = setTimeout(refreshEpisodeResults, 200);
}

function populateYearSelect() {
  const sel = document.getElementById("ep-year-select");
  if (!sel) return;
  for (let y = 2025; y >= 1984; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const mix = document.getElementById("tier-mix-btn");
  const reroll = document.getElementById("tier-reroll-btn");
  const customBoard = document.getElementById("custom-board-btn");
  if (mix) mix.addEventListener("click", () => {
    send({ type: "host:resetGame", reloadGame: true });
  });
  if (customBoard) customBoard.addEventListener("click", () => {
    if (!state || !state.players || state.players.length === 0) {
      alert("Need at least one player joined first.");
      return;
    }
    if (confirm(`Start interviews for ${state.players.length} player(s)? Each will be asked what they're good at.`)) {
      send({ type: "host:startInterview" });
    }
  });
  populateYearSelect();
  const epInput = document.getElementById("ep-search-input");
  const epTier = document.getElementById("ep-tier-select");
  const epYear = document.getElementById("ep-year-select");
  if (epInput) epInput.addEventListener("input", debouncedSearch);
  if (epTier) epTier.addEventListener("change", refreshEpisodeResults);
  if (epYear) epYear.addEventListener("change", refreshEpisodeResults);
  // Lazy-load when the user expands the picker for the first time.
  const epDetails = document.getElementById("episode-browser");
  if (epDetails) {
    epDetails.addEventListener("toggle", () => {
      if (epDetails.open) refreshEpisodeResults();
    }, { once: false });
  }

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
  } else if (phase === "INTERVIEW") {
    showScreen("interview-screen");
    renderInterview();
  } else if (phase === "BUILDING") {
    showScreen("building-screen");
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

function renderInterview() {
  const interview = state.interview || {};
  const currentId = interview.currentPlayerId;
  const submitted = interview.submitted || {};
  const current = state.players.find((p) => p.id === currentId);
  const nameEl = $("interview-current-name");
  if (nameEl) nameEl.textContent = current ? current.name : "...";
  const roster = $("interview-roster");
  if (!roster) return;
  roster.innerHTML = "";
  for (const p of state.players) {
    const li = document.createElement("li");
    if (p.id === currentId) li.classList.add("current");
    const name = document.createElement("span");
    name.textContent = p.name;
    li.appendChild(name);
    const status = document.createElement("span");
    if (submitted[p.id]) {
      status.className = "check";
      status.textContent = "✓ done";
    } else if (p.id === currentId) {
      status.className = "pending";
      status.textContent = "recording…";
    } else {
      status.className = "pending";
      status.textContent = "waiting";
    }
    li.appendChild(status);
    roster.appendChild(li);
  }
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

function runClueZoom(clueRef, overlay) {
  // Find the originating board cell.
  const board = $("board");
  if (!board) return;
  const idx = 6 + clueRef.idx * 6 + clueRef.cat;
  const cell = board.children[idx];
  if (!cell) return;

  const cellRect = cell.getBoundingClientRect();
  const card = $("clue-card");
  if (!card) return;
  const cardRect = card.getBoundingClientRect();
  const dx = cellRect.left - cardRect.left;
  const dy = cellRect.top - cardRect.top;
  const sx = cellRect.width / cardRect.width;
  const sy = cellRect.height / cardRect.height;

  // Start from the cell's position+scale, flash a "selected" highlight on the cell,
  // then animate to identity (full overlay).
  card.style.transformOrigin = "top left";
  card.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  card.style.opacity = "0.0";
  cell.classList.add("just-picked");
  // Force reflow so the transition sees the start state.
  void card.offsetWidth;
  card.style.transition = "transform 420ms cubic-bezier(0.2, 0.7, 0.3, 1), opacity 200ms ease-out";
  card.style.transform = "translate(0, 0) scale(1, 1)";
  card.style.opacity = "1";
  setTimeout(() => {
    card.style.transition = "";
    card.style.transform = "";
    card.style.opacity = "";
    cell.classList.remove("just-picked");
  }, 480);
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

  const wasHidden = overlay.hidden;
  overlay.hidden = false;
  const c = state.currentClue;

  // Animate from the picked board cell to full overlay (FLIP-style) the
  // first frame the overlay appears for a new clue.
  if (wasHidden && phaseChanged) {
    runClueZoom(c, overlay);
  }

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
  promptEl.textContent = state.finalPrompt || "";
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
        <div class="score" data-action="editScore" title="Click to edit"></div>
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
    // Don't clobber the input while the host is editing the score
    if (!scoreEl.querySelector("input")) {
      scoreEl.textContent = (p.score < 0 ? "-$" : "$") + Math.abs(p.score);
      scoreEl.classList.toggle("negative", p.score < 0);
    }
    card.querySelector(".mic").hidden = state.buzzedPlayerId !== p.id;
  });
}

function startScoreEdit(scoreEl, playerId) {
  if (scoreEl.querySelector("input")) return;
  const player = state?.players.find((p) => p.id === playerId);
  if (!player) return;
  const original = player.score;
  scoreEl.textContent = "";
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(original);
  input.className = "score-edit";
  scoreEl.appendChild(input);
  input.focus();
  input.select();
  let finished = false;
  const commit = () => {
    if (finished) return;
    finished = true;
    const v = parseInt(input.value, 10);
    if (Number.isFinite(v) && v !== original) {
      send({ type: "host:setScore", playerId, score: v });
    }
    scoreEl.textContent =
      (player.score < 0 ? "-$" : "$") + Math.abs(player.score);
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    scoreEl.textContent =
      (original < 0 ? "-$" : "$") + Math.abs(original);
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      scoreEl.blur();
    }
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
    case "editScore": {
      const card = target.closest(".player-card");
      const pid = card && card.dataset.playerId;
      const scoreEl = card && card.querySelector(".score");
      if (pid && scoreEl) startScoreEdit(scoreEl, pid);
      break;
    }
    case "skipInterview":
      send({ type: "host:skipInterviewPlayer" });
      break;
    case "cancelInterview":
      if (confirm("Cancel custom-board build?")) {
        send({ type: "host:cancelInterview" });
      }
      break;
  }
});

/* === Boot === */

loadInfo();
connect();
