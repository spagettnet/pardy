const LS_NAME = "pardy:name";
const LS_PID = "pardy:playerId";
const LS_TOKEN = "pardy:rejoinToken";

const els = {
  topbar: document.getElementById("topbar"),
  myName: document.getElementById("myName"),
  myScore: document.getElementById("myScore"),
  connDot: document.getElementById("connDot"),
  changeName: document.getElementById("changeName"),
  toast: document.getElementById("toast"),

  screens: {
    join: document.getElementById("screen-join"),
    LOBBY: document.getElementById("screen-lobby"),
    PICKING: document.getElementById("screen-picking"),
    INTERVIEW: document.getElementById("screen-interview"),
    BUILDING: document.getElementById("screen-building"),
    READING: document.getElementById("screen-reading"),
    OPEN: document.getElementById("screen-open"),
    ANSWERING: document.getElementById("screen-answering"),
    JUDGING: document.getElementById("screen-judging"),
    RESOLVED: document.getElementById("screen-resolved"),
    DD_WAGER: document.getElementById("screen-ddwager"),
    DD_ANSWERING: document.getElementById("screen-answering"),
    ROUND_BREAK: document.getElementById("screen-roundbreak"),
    FINAL_WAGER: document.getElementById("screen-finalwager"),
    FINAL_READING: document.getElementById("screen-finalreading"),
    FINAL_ANSWERING: document.getElementById("screen-finalanswering"),
    FINAL_REVEAL: document.getElementById("screen-finalreveal"),
    GAME_OVER: document.getElementById("screen-gameover"),
    KICKED: document.getElementById("screen-kicked"),
  },

  nameInput: document.getElementById("nameInput"),
  joinBtn: document.getElementById("joinBtn"),
  joinError: document.getElementById("joinError"),

  lobbyPlayers: document.getElementById("lobbyPlayers"),

  pickingHeader: document.getElementById("pickingHeader"),
  pickingSub: document.getElementById("pickingSub"),
  pickingPickerView: document.getElementById("pickingPickerView"),
  pickingOtherView: document.getElementById("pickingOtherView"),
  pickRecBtn: document.getElementById("pickRecBtn"),
  pickRecLabel: document.getElementById("pickRecLabel"),
  pickListening: document.getElementById("pickListening"),
  pickHint: document.getElementById("pickHint"),
  pickProcessing: document.getElementById("pickProcessing"),
  pickMicError: document.getElementById("pickMicError"),
  pickRetryMicBtn: document.getElementById("pickRetryMicBtn"),
  interviewSelf: document.getElementById("interviewSelf"),
  interviewSpectator: document.getElementById("interviewSpectator"),
  interviewWaitingFor: document.getElementById("interviewWaitingFor"),
  interviewRecBtn: document.getElementById("interviewRecBtn"),
  interviewRecLabel: document.getElementById("interviewRecLabel"),
  interviewListening: document.getElementById("interviewListening"),
  interviewProcessing: document.getElementById("interviewProcessing"),
  interviewMicError: document.getElementById("interviewMicError"),
  interviewRetryMicBtn: document.getElementById("interviewRetryMicBtn"),
  finalAnsweringActive: document.getElementById("finalAnsweringActive"),
  finalAnsweringWaiting: document.getElementById("finalAnsweringWaiting"),
  finalAnsweringSpectator: document.getElementById("finalAnsweringSpectator"),
  finalAnsweringCategory: document.getElementById("finalAnsweringCategory"),
  finalAnswerInput: document.getElementById("finalAnswerInput"),
  finalAnswerSubmitBtn: document.getElementById("finalAnswerSubmitBtn"),

  buzzBtn: document.getElementById("buzzBtn"),

  answeringSelf: document.getElementById("answeringSelf"),
  answeringOther: document.getElementById("answeringOther"),
  stopRecBtn: document.getElementById("stopRecBtn"),
  micError: document.getElementById("micError"),
  retryMicBtn: document.getElementById("retryMicBtn"),

  resolvedMsg: document.getElementById("resolvedMsg"),
  resolvedAnswer: document.getElementById("resolvedAnswer"),

  ddPickerView: document.getElementById("ddPickerView"),
  ddOtherView: document.getElementById("ddOtherView"),
  ddWagerInput: document.getElementById("ddWagerInput"),
  ddWagerBounds: document.getElementById("ddWagerBounds"),
  ddWagerBtn: document.getElementById("ddWagerBtn"),

  finalWagerActive: document.getElementById("finalWagerActive"),
  finalWagerWaiting: document.getElementById("finalWagerWaiting"),
  finalWagerSpectator: document.getElementById("finalWagerSpectator"),
  finalCategoryLabel: document.getElementById("finalCategoryLabel"),
  finalWagerInput: document.getElementById("finalWagerInput"),
  finalWagerBounds: document.getElementById("finalWagerBounds"),
  finalWagerBtn: document.getElementById("finalWagerBtn"),
  finalWagerStatus: document.getElementById("finalWagerStatus"),
  finalWagerStatusSpec: document.getElementById("finalWagerStatusSpec"),

  finalReadingCategory: document.getElementById("finalReadingCategory"),
  finalRevealBox: document.getElementById("finalRevealBox"),

  winnerName: document.getElementById("winnerName"),
  finalScoreboard: document.getElementById("finalScoreboard"),

  kickedReason: document.getElementById("kickedReason"),
};

let state = null;
let me = null;
let ws = null;
let connected = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let kicked = false;

let buzzedLocally = false;
let lastBuzzClueKey = null;
let lastWageredClueKey = null;
let lastFinalWagerSubmittedLocal = false;

let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let recMime = "";
let recAutoStopTimer = null;
let recordingInProgress = false;
let answerSubmittedForBuzzKey = null;
let micPermissionDenied = false;
let recPurpose = "answer"; // "answer" | "pick" | "interview"
let pickRecording = false;
let pickMicDenied = false;
let interviewRecording = false;
let interviewMicDenied = false;

function getName() {
  return localStorage.getItem(LS_NAME) || "";
}
function getPid() {
  return localStorage.getItem(LS_PID) || "";
}
function getToken() {
  return localStorage.getItem(LS_TOKEN) || "";
}

function saveIdentity(playerId, rejoinToken) {
  if (playerId) localStorage.setItem(LS_PID, playerId);
  if (rejoinToken) localStorage.setItem(LS_TOKEN, rejoinToken);
}

function clearIdentity() {
  localStorage.removeItem(LS_NAME);
  localStorage.removeItem(LS_PID);
  localStorage.removeItem(LS_TOKEN);
}

function showToast(msg, ms = 4000) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.add("hidden"), ms);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function connect() {
  if (kicked) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setConnDot(false);
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const url = wsScheme + "://" + location.host + "/ws?role=player";
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", () => {
    connected = true;
    reconnectAttempt = 0;
    setConnDot(true);
    const name = getName();
    if (name) {
      send({ type: "player:join", name, rejoinToken: getToken() || undefined });
    }
  });
  ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServer(m);
  });
  ws.addEventListener("close", () => {
    connected = false;
    setConnDot(false);
    scheduleReconnect();
  });
  ws.addEventListener("error", () => {
    try {
      ws.close();
    } catch {}
  });
}

function scheduleReconnect() {
  if (kicked) return;
  if (reconnectTimer) return;
  reconnectAttempt = Math.min(reconnectAttempt + 1, 8);
  const base = Math.min(8000, Math.pow(2, reconnectAttempt) * 250);
  const jitter = Math.random() * 250;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, base + jitter);
}

function setConnDot(isOn) {
  els.connDot.classList.toggle("connected", !!isOn);
  els.connDot.classList.toggle("disconnected", !isOn);
}

function handleServer(m) {
  switch (m.type) {
    case "joined":
      saveIdentity(m.playerId, m.rejoinToken);
      render();
      break;
    case "state":
      state = m.state;
      onStateChanged();
      render();
      break;
    case "youBuzzed":
      onYouBuzzed();
      break;
    case "error":
      showToast(m.message || "Error");
      break;
    case "kicked":
      kicked = true;
      try {
        ws && ws.close();
      } catch {}
      clearIdentity();
      els.kickedReason.textContent = m.reason || "";
      showScreen("KICKED");
      break;
    default:
      break;
  }
}

function clueKey(s) {
  if (!s || !s.currentClue) return null;
  const c = s.currentClue;
  return `${c.round}:${c.cat}:${c.idx}`;
}

function findMe() {
  const pid = getPid();
  if (!state || !pid) return null;
  return state.players.find((p) => p.id === pid) || null;
}

function onStateChanged() {
  me = findMe();
  const ck = clueKey(state);
  if (ck !== lastBuzzClueKey) {
    buzzedLocally = false;
    lastBuzzClueKey = ck;
    answerSubmittedForBuzzKey = null;
  }

  // If we've left answering phase, ensure recording is stopped.
  const phase = state.phase;
  const buzzedIsMe = me && state.buzzedPlayerId === me.id;
  const inAnsweringPhase = phase === "ANSWERING" || phase === "DD_ANSWERING";
  if (!inAnsweringPhase || !buzzedIsMe) {
    if (recordingInProgress) stopRecording(false);
  }

  // Reset finalWagerSubmittedLocal if game state lost it
  if (me && phase === "FINAL_WAGER") {
    if (state.finalWagerSubmitted && state.finalWagerSubmitted[me.id]) {
      lastFinalWagerSubmittedLocal = true;
    }
  } else if (phase !== "FINAL_WAGER") {
    lastFinalWagerSubmittedLocal = false;
  }
}

/* ---------------- Render ---------------- */

function showScreen(key) {
  for (const k in els.screens) {
    const node = els.screens[k];
    if (!node) continue;
    node.classList.add("hidden");
  }
  // join screen handled separately
  if (key === "JOIN") {
    els.screens.join.classList.remove("hidden");
    return;
  }
  const node = els.screens[key];
  if (node) node.classList.remove("hidden");
}

function render() {
  if (kicked) {
    els.topbar.classList.add("hidden");
    showScreen("KICKED");
    return;
  }

  const name = getName();
  if (!name) {
    els.topbar.classList.add("hidden");
    showScreen("JOIN");
    return;
  }

  if (!state) {
    // joined name set, but no state yet
    els.topbar.classList.remove("hidden");
    els.myName.textContent = name;
    els.myScore.textContent = "$0";
    showScreen("LOBBY");
    return;
  }

  els.topbar.classList.remove("hidden");
  me = findMe();
  els.myName.textContent = me ? me.name : name;
  const score = me ? me.score : 0;
  els.myScore.textContent = formatMoney(score);
  els.myScore.classList.toggle("negative", score < 0);

  const phase = state.phase;
  switch (phase) {
    case "INTERVIEW":
      renderInterview();
      showScreen("INTERVIEW");
      break;
    case "BUILDING":
      showScreen("BUILDING");
      break;
    case "LOBBY":
      renderLobby();
      showScreen("LOBBY");
      break;
    case "PICKING":
      renderPicking();
      showScreen("PICKING");
      break;
    case "READING":
      showScreen("READING");
      break;
    case "OPEN":
      renderOpen();
      showScreen("OPEN");
      break;
    case "ANSWERING":
    case "DD_ANSWERING":
      renderAnswering(phase);
      showScreen(phase);
      break;
    case "FINAL_ANSWERING":
      renderFinalAnswering();
      showScreen("FINAL_ANSWERING");
      break;
    case "JUDGING":
      showScreen("JUDGING");
      break;
    case "RESOLVED":
      renderResolved();
      showScreen("RESOLVED");
      break;
    case "DD_WAGER":
      renderDdWager();
      showScreen("DD_WAGER");
      break;
    case "ROUND_BREAK":
      showScreen("ROUND_BREAK");
      break;
    case "FINAL_WAGER":
      renderFinalWager();
      showScreen("FINAL_WAGER");
      break;
    case "FINAL_READING":
      renderFinalReading();
      showScreen("FINAL_READING");
      break;
    case "FINAL_REVEAL":
      renderFinalReveal();
      showScreen("FINAL_REVEAL");
      break;
    case "GAME_OVER":
      renderGameOver();
      showScreen("GAME_OVER");
      break;
    default:
      showScreen("LOBBY");
  }
}

function formatMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US")}`;
}

function renderLobby() {
  const html = state.players
    .map((p) => {
      const cls = me && p.id === me.id ? "chip me" : "chip" + (p.connected ? "" : " dim");
      return `<span class="${cls}">${escapeHtml(p.name)}</span>`;
    })
    .join("");
  els.lobbyPlayers.innerHTML = html;
}

function renderPicking() {
  if (!me) {
    els.pickingPickerView.classList.add("hidden");
    els.pickingOtherView.classList.remove("hidden");
    els.pickingHeader.textContent = "Picking…";
    els.pickingSub.textContent = "";
    return;
  }
  if (state.pickerId === me.id) {
    els.pickingPickerView.classList.remove("hidden");
    els.pickingOtherView.classList.add("hidden");
    if (pickRecording) {
      els.pickRecLabel.textContent = "Stop & submit";
      els.pickRecBtn.classList.add("recording");
      els.pickListening.classList.remove("hidden");
      els.pickHint.classList.add("hidden");
      els.pickProcessing.classList.add("hidden");
    } else {
      els.pickRecLabel.textContent = "Tap to talk";
      els.pickRecBtn.classList.remove("recording");
      els.pickListening.classList.add("hidden");
      els.pickHint.classList.remove("hidden");
    }
    els.pickMicError.classList.toggle("hidden", !pickMicDenied);
  } else {
    els.pickingPickerView.classList.add("hidden");
    els.pickingOtherView.classList.remove("hidden");
    const picker = state.players.find((p) => p.id === state.pickerId);
    els.pickingHeader.textContent = picker ? picker.name : "Someone";
    els.pickingSub.textContent = "is picking…";
    // If we leave picker role mid-recording, stop.
    if (pickRecording) stopPickRecording(false);
  }
}

function renderOpen() {
  const isBuzzed = !!state.buzzedPlayerId;
  if (buzzedLocally || isBuzzed) {
    els.buzzBtn.classList.add("locked");
    els.buzzBtn.classList.add("buzzed");
    els.buzzBtn.querySelector(".buzz-text").textContent = "BUZZED";
  } else {
    els.buzzBtn.classList.remove("locked");
    els.buzzBtn.classList.remove("buzzed");
    els.buzzBtn.querySelector(".buzz-text").textContent = "BUZZ";
  }
}

function renderAnswering(phase) {
  const buzzedIsMe = me && state.buzzedPlayerId === me.id;
  if (buzzedIsMe) {
    els.answeringSelf.classList.remove("hidden");
    els.answeringOther.classList.add("hidden");
    if (micPermissionDenied) {
      els.micError.classList.remove("hidden");
    } else {
      els.micError.classList.add("hidden");
    }
  } else {
    els.answeringSelf.classList.add("hidden");
    els.answeringOther.classList.remove("hidden");
    const bp = state.players.find((p) => p.id === state.buzzedPlayerId);
    const who = bp ? bp.name : "Someone";
    els.answeringOther.textContent = `${who} is answering…`;
  }
}

let finalAnswerSubmittedLocal = false;
let lastFinalKey = null;

function renderFinalAnswering() {
  if (!state || !me) return;
  // Reset local submitted flag if we re-entered FINAL_ANSWERING fresh
  const key = state.finalPrompt || state.finalCategory || "fa";
  if (key !== lastFinalKey) {
    lastFinalKey = key;
    finalAnswerSubmittedLocal = false;
    if (els.finalAnswerInput) els.finalAnswerInput.value = "";
  }
  // Only players with a wager submitted (i.e. positive score) participate
  const wagered = !!(state.finalWagerSubmitted && state.finalWagerSubmitted[me.id]);
  if (!wagered) {
    els.finalAnsweringActive.classList.add("hidden");
    els.finalAnsweringWaiting.classList.add("hidden");
    els.finalAnsweringSpectator.classList.remove("hidden");
    return;
  }
  if (finalAnswerSubmittedLocal) {
    els.finalAnsweringActive.classList.add("hidden");
    els.finalAnsweringSpectator.classList.add("hidden");
    els.finalAnsweringWaiting.classList.remove("hidden");
    return;
  }
  els.finalAnsweringActive.classList.remove("hidden");
  els.finalAnsweringSpectator.classList.add("hidden");
  els.finalAnsweringWaiting.classList.add("hidden");
  if (els.finalAnsweringCategory)
    els.finalAnsweringCategory.textContent = state.finalCategory || "";
}

function submitFinalAnswerText() {
  if (!state || state.phase !== "FINAL_ANSWERING") return;
  if (finalAnswerSubmittedLocal) return;
  const text = (els.finalAnswerInput?.value || "").trim();
  if (!text) {
    showToast("Type something first");
    return;
  }
  finalAnswerSubmittedLocal = true;
  send({ type: "player:finalAnswerText", text });
  render();
}

function renderResolved() {
  const j = state.lastJudgement;
  if (j && j.correct) {
    els.resolvedMsg.textContent = "✓ Correct!";
    els.resolvedMsg.className = "resolved-msg correct";
  } else if (j && !j.correct) {
    els.resolvedMsg.textContent = "✗ Wrong";
    els.resolvedMsg.className = "resolved-msg wrong";
  } else {
    els.resolvedMsg.textContent = "—";
    els.resolvedMsg.className = "resolved-msg";
  }
  const ans = state.currentClue && state.currentClue.revealedAnswer;
  els.resolvedAnswer.textContent = ans ? `Answer: ${ans}` : "";
}

function renderDdWager() {
  const isPicker = me && state.pickerId === me.id;
  if (isPicker) {
    els.ddPickerView.classList.remove("hidden");
    els.ddOtherView.classList.add("hidden");
    const roundFloor = state.round === 0 ? 1000 : 2000;
    const max = Math.max(me.score, roundFloor);
    els.ddWagerBounds.textContent = `Min $5 — Max ${formatMoney(max)}`;
    els.ddWagerInput.min = "5";
    els.ddWagerInput.max = String(max);
    if (!els.ddWagerInput.value) els.ddWagerInput.value = String(Math.min(max, 1000));
    els.ddWagerBtn.disabled = lastWageredClueKey === clueKey(state);
    els.ddWagerBtn.textContent = els.ddWagerBtn.disabled ? "Submitted" : "Wager";
  } else {
    els.ddPickerView.classList.add("hidden");
    els.ddOtherView.classList.remove("hidden");
    const picker = state.players.find((p) => p.id === state.pickerId);
    const who = picker ? picker.name : "Someone";
    els.ddOtherView.textContent = `Daily Double — ${who} is wagering…`;
  }
}

function renderFinalWager() {
  els.finalWagerActive.classList.add("hidden");
  els.finalWagerWaiting.classList.add("hidden");
  els.finalWagerSpectator.classList.add("hidden");
  if (!me) return;
  const submitted = !!(state.finalWagerSubmitted && state.finalWagerSubmitted[me.id]);
  const eligible = me.score > 0;
  if (eligible && !submitted) {
    els.finalWagerActive.classList.remove("hidden");
    els.finalCategoryLabel.textContent = state.finalCategory || "";
    const max = me.score;
    els.finalWagerBounds.textContent = `Min $0 — Max ${formatMoney(max)}`;
    els.finalWagerInput.min = "0";
    els.finalWagerInput.max = String(max);
    if (!els.finalWagerInput.value) els.finalWagerInput.value = "";
    els.finalWagerBtn.disabled = false;
    els.finalWagerBtn.textContent = "Submit wager";
  } else if (eligible && submitted) {
    els.finalWagerWaiting.classList.remove("hidden");
    els.finalWagerStatus.innerHTML = renderFinalWagerChips();
  } else {
    els.finalWagerSpectator.classList.remove("hidden");
    els.finalWagerStatusSpec.innerHTML = renderFinalWagerChips();
  }
}

function renderFinalWagerChips() {
  return state.players
    .filter((p) => p.score > 0)
    .map((p) => {
      const ok = !!(state.finalWagerSubmitted && state.finalWagerSubmitted[p.id]);
      const cls = "chip" + (ok ? "" : " dim");
      const check = ok ? ' <span class="chip-check">✓</span>' : "";
      return `<span class="${cls}">${escapeHtml(p.name)}${check}</span>`;
    })
    .join("");
}

function renderFinalReading() {
  els.finalReadingCategory.textContent = state.finalCategory || "";
}

function renderFinalReveal() {
  const r = state.finalReveal;
  if (!r) {
    els.finalRevealBox.innerHTML = '<div class="sub-msg">Waiting…</div>';
    return;
  }
  const player = state.players.find((p) => p.id === r.playerId);
  const name = player ? player.name : "Player";
  const verdict =
    r.correct === true
      ? '<div class="verdict correct">✓ Correct</div>'
      : r.correct === false
      ? '<div class="verdict wrong">✗ Wrong</div>'
      : "";
  const tx = r.transcript ? `<div class="transcript">"${escapeHtml(r.transcript)}"</div>` : "";
  els.finalRevealBox.innerHTML = `
    <div class="name">${escapeHtml(name)}</div>
    ${tx}
    ${verdict}
    <div class="wager">${formatMoney(r.wager || 0)}</div>
  `;
}

function renderGameOver() {
  const sorted = state.players.slice().sort((a, b) => b.score - a.score);
  const winner = sorted[0];
  els.winnerName.textContent = winner ? `Winner: ${winner.name}` : "";
  els.finalScoreboard.innerHTML = sorted
    .map(
      (p) => `
    <div class="scoreboard-row">
      <span>${escapeHtml(p.name)}</span>
      <span class="sb-score${p.score < 0 ? " negative" : ""}">${formatMoney(p.score)}</span>
    </div>
  `,
    )
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------------- Buzz ---------------- */

function pressBuzz(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (!state || state.phase !== "OPEN") return;
  if (buzzedLocally) return;
  if (state.buzzedPlayerId) return;
  buzzedLocally = true;
  if (navigator.vibrate) {
    try {
      navigator.vibrate(40);
    } catch {}
  }
  send({ type: "player:buzz" });
  els.buzzBtn.classList.add("pressed");
  els.buzzBtn.classList.add("locked");
  els.buzzBtn.querySelector(".buzz-text").textContent = "BUZZED";
  setTimeout(() => els.buzzBtn.classList.remove("pressed"), 150);
}

els.buzzBtn.addEventListener(
  "touchstart",
  (e) => {
    pressBuzz(e);
  },
  { passive: false },
);
els.buzzBtn.addEventListener("mousedown", (e) => {
  if (e.button === 0) pressBuzz(e);
});
els.buzzBtn.addEventListener("click", (e) => {
  e.preventDefault();
});

/* ---------------- Microphone ---------------- */

async function ensureStream() {
  if (mediaStream && mediaStream.active) return mediaStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    micPermissionDenied = true;
    render();
    return null;
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micPermissionDenied = false;
    return mediaStream;
  } catch (err) {
    micPermissionDenied = true;
    render();
    return null;
  }
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const mt of candidates) {
    try {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mt)) return mt;
    } catch {}
  }
  return "";
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function startRecording(purpose = "answer") {
  if (recordingInProgress) return;
  const stream = await ensureStream();
  if (!stream) {
    if (purpose === "pick") {
      pickMicDenied = true;
      render();
    }
    return;
  }
  recPurpose = purpose;
  const mt = pickMimeType();
  recMime = mt || "audio/webm";
  try {
    mediaRecorder = mt
      ? new MediaRecorder(stream, { mimeType: mt })
      : new MediaRecorder(stream);
  } catch (err) {
    showToast("Could not start recorder");
    return;
  }
  recChunks = [];
  recordingInProgress = true;
  mediaRecorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  });
  mediaRecorder.addEventListener("stop", onRecorderStop);
  try {
    mediaRecorder.start();
  } catch {
    recordingInProgress = false;
    showToast("Could not start recording");
    return;
  }
  if (recAutoStopTimer) clearTimeout(recAutoStopTimer);
  // Picks are terse, interviews are long-form.
  const stopAfter =
    purpose === "pick" ? 5000 : purpose === "interview" ? 60000 : 7000;
  recAutoStopTimer = setTimeout(() => stopRecording(true), stopAfter);
}

function stopRecording(submit) {
  if (recAutoStopTimer) {
    clearTimeout(recAutoStopTimer);
    recAutoStopTimer = null;
  }
  if (!mediaRecorder) {
    recordingInProgress = false;
    return;
  }
  mediaRecorder._submit = submit !== false;
  if (mediaRecorder.state === "recording" || mediaRecorder.state === "paused") {
    try {
      mediaRecorder.stop();
    } catch {}
  } else {
    recordingInProgress = false;
  }
}

async function onRecorderStop() {
  recordingInProgress = false;
  const submit = mediaRecorder ? mediaRecorder._submit !== false : false;
  const chunks = recChunks;
  const mime = recMime || "audio/webm";
  const purpose = recPurpose;
  recChunks = [];
  if (purpose === "interview") {
    interviewRecording = false;
    render();
    if (!submit || chunks.length === 0) return;
    try {
      const blob = new Blob(chunks, { type: mime });
      const buf = await blob.arrayBuffer();
      const b64 = bufToBase64(buf);
      send({ type: "player:interview", audioBase64: b64, mimeType: mime });
    } catch {
      showToast("Failed to submit interview");
    }
    return;
  }
  if (purpose === "pick") {
    pickRecording = false;
    render();
    if (!submit || chunks.length === 0) return;
    try {
      const blob = new Blob(chunks, { type: mime });
      const buf = await blob.arrayBuffer();
      const b64 = bufToBase64(buf);
      send({ type: "player:pickVoice", audioBase64: b64, mimeType: mime });
    } catch {
      showToast("Failed to submit pick");
    }
    return;
  }
  if (!submit || chunks.length === 0) return;
  if (answerSubmittedForBuzzKey === lastBuzzClueKey) return;
  try {
    const blob = new Blob(chunks, { type: mime });
    const buf = await blob.arrayBuffer();
    const b64 = bufToBase64(buf);
    answerSubmittedForBuzzKey = lastBuzzClueKey;
    send({ type: "player:answer", audioBase64: b64, mimeType: mime });
  } catch (err) {
    showToast("Failed to submit answer");
  }
}

async function startPickRecording() {
  if (pickRecording) return;
  pickRecording = true;
  render();
  await startRecording("pick");
  if (!recordingInProgress) {
    pickRecording = false;
    render();
  }
}

async function startInterviewRecording() {
  if (interviewRecording) return;
  interviewRecording = true;
  render();
  await startRecording("interview");
  if (!recordingInProgress) {
    interviewRecording = false;
    interviewMicDenied = true;
    render();
  }
}

function stopInterviewRecording(submit) {
  if (!interviewRecording) return;
  interviewRecording = false;
  if (submit !== false) {
    els.interviewProcessing.classList.remove("hidden");
    els.interviewListening.classList.add("hidden");
  }
  stopRecording(submit !== false);
  render();
}

function renderInterview() {
  if (!state || !me) return;
  const interview = state.interview || {};
  const isMe = interview.currentPlayerId === me.id;
  const submitted = !!(interview.submitted && interview.submitted[me.id]);
  if (isMe && !submitted) {
    els.interviewSelf.classList.remove("hidden");
    els.interviewSpectator.classList.add("hidden");
    if (interviewRecording) {
      els.interviewRecLabel.textContent = "Stop & submit";
      els.interviewRecBtn.classList.add("recording");
      els.interviewListening.classList.remove("hidden");
      els.interviewProcessing.classList.add("hidden");
    } else {
      els.interviewRecLabel.textContent = "Tap to talk";
      els.interviewRecBtn.classList.remove("recording");
      els.interviewListening.classList.add("hidden");
    }
    els.interviewMicError.classList.toggle("hidden", !interviewMicDenied);
  } else {
    els.interviewSelf.classList.add("hidden");
    els.interviewSpectator.classList.remove("hidden");
    const cur = state.players.find((p) => p.id === interview.currentPlayerId);
    els.interviewWaitingFor.textContent = submitted
      ? "You're done — waiting for others"
      : cur
        ? cur.name
        : "Someone";
    if (interviewRecording) stopInterviewRecording(false);
  }
}

function stopPickRecording(submit) {
  if (!pickRecording) return;
  pickRecording = false;
  if (submit !== false) {
    els.pickProcessing.classList.remove("hidden");
    els.pickListening.classList.add("hidden");
    els.pickHint.classList.add("hidden");
  }
  stopRecording(submit !== false);
  render();
}

function onYouBuzzed() {
  // Server confirms this phone has the floor. Auto-start recording for answer
  // phases. Interview/pick phases use explicit tap-to-talk — don't auto-fire.
  if (!state) return;
  if (state.phase === "INTERVIEW" || state.phase === "PICKING") {
    return;
  }
  startRecording();
}

els.stopRecBtn.addEventListener("click", () => {
  stopRecording(true);
});

els.retryMicBtn.addEventListener("click", async () => {
  micPermissionDenied = false;
  render();
  const s = await ensureStream();
  if (s && state && me && state.buzzedPlayerId === me.id) {
    startRecording();
  }
});

els.pickRecBtn.addEventListener("click", () => {
  if (!state || state.phase !== "PICKING" || !me || state.pickerId !== me.id) return;
  if (pickRecording) {
    stopPickRecording(true);
  } else {
    startPickRecording();
  }
});

els.pickRetryMicBtn.addEventListener("click", async () => {
  pickMicDenied = false;
  micPermissionDenied = false;
  els.pickMicError.classList.add("hidden");
  await ensureStream();
  render();
});

els.interviewRecBtn.addEventListener("click", () => {
  if (!state || state.phase !== "INTERVIEW" || !me) return;
  if (state.interview?.currentPlayerId !== me.id) return;
  if (interviewRecording) stopInterviewRecording(true);
  else startInterviewRecording();
});

els.interviewRetryMicBtn.addEventListener("click", async () => {
  interviewMicDenied = false;
  micPermissionDenied = false;
  els.interviewMicError.classList.add("hidden");
  await ensureStream();
  render();
});

/* ---------------- Wagers ---------------- */

els.ddWagerBtn.addEventListener("click", () => {
  if (!me || !state || state.phase !== "DD_WAGER") return;
  const raw = parseInt(els.ddWagerInput.value, 10);
  if (!Number.isFinite(raw)) {
    showToast("Enter a wager");
    return;
  }
  const roundFloor = state.round === 0 ? 1000 : 2000;
  const max = Math.max(me.score, roundFloor);
  const amount = Math.max(5, Math.min(max, raw));
  lastWageredClueKey = clueKey(state);
  send({ type: "player:wager", amount });
  els.ddWagerBtn.disabled = true;
  els.ddWagerBtn.textContent = "Submitted";
});

els.finalWagerBtn.addEventListener("click", () => {
  if (!me || !state || state.phase !== "FINAL_WAGER") return;
  const raw = parseInt(els.finalWagerInput.value, 10);
  if (!Number.isFinite(raw) || raw < 0) {
    showToast("Enter a wager");
    return;
  }
  const max = me.score;
  const amount = Math.max(0, Math.min(max, raw));
  lastFinalWagerSubmittedLocal = true;
  send({ type: "player:wager", amount });
  els.finalWagerBtn.disabled = true;
  els.finalWagerBtn.textContent = "Submitted";
});

if (els.finalAnswerSubmitBtn) {
  els.finalAnswerSubmitBtn.addEventListener("click", submitFinalAnswerText);
}
if (els.finalAnswerInput) {
  els.finalAnswerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitFinalAnswerText();
  });
}

/* ---------------- Join form ---------------- */

function attemptJoin() {
  const name = (els.nameInput.value || "").trim();
  if (!name) {
    els.joinError.textContent = "Please enter a name";
    return;
  }
  if (name.length > 20) {
    els.joinError.textContent = "Name too long";
    return;
  }
  els.joinError.textContent = "";
  localStorage.setItem(LS_NAME, name);
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: "player:join", name, rejoinToken: getToken() || undefined });
  } else {
    connect();
  }
  render();
}

els.joinBtn.addEventListener("click", attemptJoin);
els.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptJoin();
});

els.changeName.addEventListener("click", (e) => {
  e.preventDefault();
  if (!confirm("Clear your name and rejoin token?")) return;
  clearIdentity();
  state = null;
  me = null;
  try {
    ws && ws.close();
  } catch {}
  ws = null;
  render();
  connect();
});

/* ---------------- Init ---------------- */

(function init() {
  const name = getName();
  if (name) els.nameInput.value = name;
  render();
  connect();
})();

window.addEventListener("pageshow", () => {
  if (!connected && !kicked) connect();
});
