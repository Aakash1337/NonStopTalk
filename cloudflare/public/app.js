const app = document.querySelector("#app");
const toast = document.querySelector("#toast");

let room = null;
let roomCode = "";
let socket = null;
let socketRoom = "";
let reconnectTimer = 0;
let reconnectDelay = 750;
let claimRefreshTimer = 0;
let clockOffset = 0;
let clockTimer = 0;
let controller = null;
let busy = false;
let routeGeneration = 0;

document.addEventListener("click", handleClick);
document.addEventListener("submit", handleSubmit);
window.addEventListener("popstate", loadRoute);
window.addEventListener("pagehide", shutdown);

loadRoute();

async function loadRoute() {
  const generation = ++routeGeneration;
  stopController();
  disconnectSocket();
  room = null;
  const match = location.pathname.match(/^\/room\/([A-Z2-9]{6})\/?$/i);
  if (!match) {
    roomCode = "";
    document.title = "NonStopTalk";
    renderLanding();
    return;
  }
  roomCode = match[1].toUpperCase();
  document.title = `${roomCode} · NonStopTalk`;
  app.innerHTML = `<section class="loading-card">Opening room ${escapeHTML(roomCode)}…</section>`;
  try {
    const payload = await api(`/api/rooms/${roomCode}/state`);
    if (generation !== routeGeneration) return;
    acceptRoom(payload.room);
  } catch (error) {
    if (generation !== routeGeneration) return;
    renderLanding(error.message === "Room not found." ? "That room does not exist." : error.message);
  }
}

function renderLanding(message = "") {
  app.innerHTML = `
    ${message ? notice(message, true) : ""}
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Keep talking</p>
        <h1>No pauses. No escape.</h1>
        <p class="lede">Draw a topic, survive the silence limit, and collect points for every second you keep the words moving.</p>
        <p class="hint">The online edition stores each room in its own Cloudflare Durable Object. The local Go edition still works independently.</p>
      </div>
      <div class="landing-actions">
        <form class="panel stack" data-create-room>
          <div class="panel-head"><h2>Create a room</h2><span class="tag">Host</span></div>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" placeholder="Optional for a display-only host"></label>
          <button class="button primary" type="submit">Create room</button>
        </form>
        <form class="panel stack" data-join-room>
          <div class="panel-head"><h2>Join a room</h2><span class="tag">Player</span></div>
          <label>Room code <input name="code" minlength="6" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123" required></label>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" required></label>
          <button class="button" type="submit">Join game</button>
        </form>
      </div>
    </section>`;
}

function renderRoom() {
  if (!room) return;
  reconcileController();
  const viewer = room.viewer;
  const current = room.players[room.currentPlayer];
  const header = `
    <section class="room-head">
      <div>
        <p class="eyebrow">Room code</p>
        <div class="room-code">${escapeHTML(room.code)}</div>
      </div>
      <div class="action-row">
        <button class="button ghost small" type="button" data-command="copy-room">Copy invite</button>
        <a class="button ghost small" href="/" data-home>Home</a>
      </div>
    </section>`;

  if (!viewer.isMember) {
    app.innerHTML = `${header}
      <section class="panel stack" style="max-width:34rem;margin:2rem auto">
        <p class="eyebrow">Join ${escapeHTML(room.code)}</p>
        <h1 style="font-size:clamp(2.2rem,8vw,4.5rem)">Take a seat.</h1>
        <p class="room-meta">${room.players.length} of 12 seats are currently filled.</p>
        ${room.phase === "setup" ? `<form class="stack" data-join-current-room>
          <label>Your name <input name="name" maxlength="40" autocomplete="nickname" required autofocus></label>
          <button class="button primary" type="submit">Join room</button>
        </form>` : `<div class="notice info">A game is already in progress. Ask the host to start a new game before joining.</div>`}
      </section>`;
    return;
  }

  const claim = viewer.canClaimHost
    ? `<div class="notice info">The host disconnected. <button class="button small" data-command="claim-host">Claim host controls</button></div>`
    : viewer.hostDisconnected
      ? `<div class="notice info">The host disconnected. Host controls can be claimed shortly.</div>`
      : "";
  const content = room.phase === "setup"
    ? renderSetup()
    : room.phase === "finished"
      ? renderWinner()
      : renderGame(current);
  app.innerHTML = `${header}${claim}${content}`;
  updateClock();
}

function renderSetup() {
  const viewer = room.viewer;
  const selectedPack = room.topicPacks.find((pack) => pack.id === room.settings.topicPack);
  return `
    <section class="room-grid">
      <div class="panel">
        <div class="section-head"><div><p class="eyebrow">Lobby</p><h2>Players</h2></div><span>${room.players.length}/12</span></div>
        <div class="player-list">${room.players.map(renderPlayer).join("") || `<p class="hint">No players yet.</p>`}</div>
        ${viewer.isHost ? `
          <form class="inline" data-room-action>
            <input type="hidden" name="type" value="add-player">
            <label>Local player <input name="name" maxlength="40" placeholder="Add someone on this screen"></label>
            <button class="button" type="submit">Add</button>
          </form>` : ""}
      </div>
      <aside class="panel">
        <div class="section-head"><div><p class="eyebrow">Scoreboard</p><h2>Starting line</h2></div></div>
        ${renderScores(false)}
        ${viewer.playerId ? `<form data-room-action><input type="hidden" name="type" value="leave"><button class="button ghost danger" type="submit">Leave room</button></form>` : ""}
      </aside>
      <div class="panel wide">
        <div class="section-head"><div><p class="eyebrow">Game setup</p><h2>${escapeHTML(selectedPack?.name || "Custom topics")}</h2></div><span>${room.topicCount} topics</span></div>
        ${viewer.isHost ? renderHostSettings() : renderSettingsSummary()}
      </div>
      ${viewer.isHost ? `
        <div class="panel wide">
          <div class="section-head"><div><p class="eyebrow">Topic editor</p><h2>Custom list</h2></div><span>One per line</span></div>
          <form class="stack" data-room-action>
            <input type="hidden" name="type" value="custom-topics">
            <textarea name="topics" rows="7" maxlength="20000">${escapeHTML(room.topics.join("\n"))}</textarea>
            <div class="action-row" style="justify-content:flex-start"><button class="button" type="submit">Use custom list</button></div>
          </form>
        </div>
        <div class="panel wide action-row">
          <div><p class="eyebrow">Ready?</p><h2>${room.settings.duration}s to survive · ${room.settings.silence}s silence limit</h2></div>
          <button class="button primary" type="button" data-command="start-game">Start game</button>
        </div>` : `<div class="panel wide"><p class="hint">Waiting for the host to start the game.</p></div>`}
      ${renderHistory()}
    </section>`;
}

function renderPlayer(player, index) {
  const viewer = room.viewer;
  const canRename = viewer.isHost || viewer.playerId === player.id;
  const isYou = viewer.playerId === player.id;
  return `<div class="player-row">
    <div style="min-width:0;flex:1">
      ${canRename ? `<form class="inline" data-room-action>
        <input type="hidden" name="type" value="rename-player">
        <input type="hidden" name="playerId" value="${escapeHTML(player.id)}">
        <input name="name" maxlength="40" value="${escapeHTML(player.name)}" aria-label="Rename ${escapeHTML(player.name)}">
        <button class="button small" type="submit">Save</button>
      </form>` : `<span class="player-name">${escapeHTML(player.name)}</span>`}
      <div class="hint"><span class="presence ${player.online ? "online" : ""}">●</span> ${player.online ? "online" : "offline"}${isYou ? ` · <span class="you">you</span>` : ""}</div>
    </div>
    ${viewer.isHost ? `<div class="player-tools">
      ${index > 0 ? actionButton("move-player", "↑", { playerId: player.id, offset: -1 }, `Move ${player.name} up`) : ""}
      ${index < room.players.length - 1 ? actionButton("move-player", "↓", { playerId: player.id, offset: 1 }, `Move ${player.name} down`) : ""}
      ${player.online && !isYou ? actionButton("transfer-host", "Make host", { playerId: player.id }, `Make ${player.name} the host`) : ""}
      ${actionButton("remove-player", "×", { playerId: player.id }, `Remove ${player.name}`, "danger")}
    </div>` : ""}
  </div>`;
}

function renderHostSettings() {
  return `<form class="settings" data-room-action>
    <input type="hidden" name="type" value="settings">
    <label>Talk time (seconds)<input name="duration" type="number" min="10" max="300" value="${room.settings.duration}"></label>
    <label>Silence limit<input name="silence" type="number" min="1" max="10" value="${room.settings.silence}"></label>
    <label>Rounds<input name="rounds" type="number" min="1" max="10" value="${room.settings.rounds}"></label>
    <label class="pack">Topic pack<select name="topicPack">${room.settings.topicPack === "custom" ? `<option value="custom" selected>Custom · your list</option>` : ""}${room.topicPacks.map((pack) => `<option value="${pack.id}" ${pack.id === room.settings.topicPack ? "selected" : ""}>${escapeHTML(pack.name)} · ${escapeHTML(pack.difficulty)}</option>`).join("")}</select></label>
    <button class="button" type="submit">Apply settings</button>
    <p class="hint wide">The free online edition uses classic scoring. The optional AI judge remains available in the local Go edition.</p>
  </form>`;
}

function renderSettingsSummary() {
  return `<div class="grid">
    <div><p class="hint">Talk time</p><strong>${room.settings.duration}s</strong></div>
    <div><p class="hint">Silence limit</p><strong>${room.settings.silence}s</strong></div>
    <div><p class="hint">Rounds</p><strong>${room.settings.rounds}</strong></div>
    <div><p class="hint">Scoring</p><strong>Classic</strong></div>
  </div>`;
}

function renderGame(current) {
  const turn = room.activeTurn;
  const viewer = room.viewer;
  const canStart = viewer.isHost || viewer.playerId === current?.id;
  if (!turn) {
    const last = room.lastTurn;
    return `<section class="room-grid">
      <div class="panel wide" style="text-align:center;padding:clamp(2rem,7vw,6rem)">
        ${last ? `<p class="eyebrow">Turn scored</p><div class="score-callout">${escapeHTML(last.playerName)} earned ${last.score} points</div><p class="hint">${last.spokenSeconds} of ${last.duration} seconds${last.completed ? ` · ${25}-point completion bonus` : ""}</p>` : `<p class="eyebrow">Round ${room.currentRound}</p><h1 style="max-width:none;font-size:clamp(2.5rem,8vw,6rem)">${escapeHTML(current?.name || "Next player")} is up.</h1>`}
        ${canStart ? `<button class="button primary" type="button" data-command="start-turn">${last ? "Next turn" : "Draw topic"}</button>` : `<p class="hint">Waiting for ${escapeHTML(current?.name || "the next player")} or the host.</p>`}
      </div>
      <aside class="panel wide"><div class="section-head"><h2>Scoreboard</h2><span>${room.completedTurns.length} turns</span></div>${renderScores(true)}</aside>
    </section>`;
  }

  const isDriver = viewer.isHost || viewer.playerId === turn.playerId;
  const remaining = remainingSeconds(turn);
  return `<section class="room-grid">
    <div class="turn-card">
      <div class="turn-meta"><span>Round ${turn.round} of ${room.settings.rounds}</span><span>${escapeHTML(turn.playerName)}${viewer.playerId === turn.playerId ? " (you)" : ""}</span></div>
      <p class="eyebrow" style="margin-top:2rem">Topic</p>
      <h1>${escapeHTML(turn.topic)}</h1>
      <div class="timer" data-timer>${remaining}</div>
      <div class="meter" aria-hidden="true"><span data-meter></span></div>
      <p class="hint" data-voice>${turn.begunAt === null ? `Silence limit: ${turn.silence}s` : `${escapeHTML(turn.playerName)} is speaking`}</p>
      ${isDriver ? renderTurnControls(turn) : `<p class="hint">The score arrives when the turn ends.</p>`}
    </div>
    <aside class="panel"><div class="section-head"><h2>Scoreboard</h2><span>${room.completedTurns.length} turns</span></div>${renderScores(true)}</aside>
  </section>`;
}

function renderTurnControls(turn) {
  if (turn.begunAt === null) {
    return `<div class="action-row">
      <button class="button primary" type="button" data-command="start-mic">Start with microphone</button>
      <button class="button" type="button" data-command="start-manual">Manual timer</button>
      <button class="button ghost" type="button" data-command="redraw">Redraw topic</button>
      ${room.viewer.isHost ? `<button class="button ghost" type="button" data-command="mark-complete">Mark complete</button>` : ""}
    </div>`;
  }
  const runningLocally = controller?.turnId === turn.id;
  return `<div class="action-row">
    ${runningLocally ? "" : `<button class="button" type="button" data-command="resume-mic">Resume microphone</button><button class="button" type="button" data-command="resume-manual">Resume manual</button>`}
    <button class="button ghost" type="button" data-command="end-turn">End turn</button>
    ${room.viewer.isHost ? `<button class="button ghost" type="button" data-command="mark-complete">Mark complete</button>` : ""}
  </div>`;
}

function renderWinner() {
  return `<section class="winner">
    <p class="eyebrow">Winner</p>
    <h1>${escapeHTML(room.winner?.name || "Game over")}</h1>
    <p class="score-callout">${room.winner?.score ?? 0} points</p>
    <div style="max-width:34rem;margin:2rem auto">${renderScores(true)}</div>
    ${room.viewer.isHost ? `<button class="button primary" type="button" data-command="reset">Play again</button>` : `<p class="hint">Waiting for the host to set up another game.</p>`}
  </section>`;
}

function renderScores(withTools) {
  return `<div class="score-list">${room.standings.map((player, index) => `<div class="score-row">
    <span><strong>${index + 1}. ${escapeHTML(player.name)}</strong>${room.viewer.playerId === player.id ? ` <span class="you">you</span>` : ""}</span>
    <span>${player.score} pts</span>
    ${withTools && room.viewer.isHost ? `<span>${actionButton("score", "−5", { playerId: player.id, delta: -5 }, `Remove 5 points from ${player.name}`)} ${actionButton("score", "+5", { playerId: player.id, delta: 5 }, `Add 5 points to ${player.name}`)}</span>` : ""}
  </div>`).join("")}</div>`;
}

function renderHistory() {
  if (!room.history.length) return "";
  return `<div class="panel wide"><div class="section-head"><h2>Game history</h2><span>${room.history.length}</span></div><div class="history">${[...room.history].reverse().map((record) => `<div class="history-item"><strong>${escapeHTML(record.standings[0]?.name || "Nobody")} won</strong> · ${record.turns} turns · ${new Date(record.finishedAt).toLocaleString()}</div>`).join("")}</div></div>`;
}

function actionButton(type, label, values, aria, extraClass = "") {
  return `<button class="button small icon ${extraClass}" type="button" data-command="action" data-action-type="${escapeHTML(type)}" data-action-values="${escapeHTML(JSON.stringify(values))}" aria-label="${escapeHTML(aria)}">${escapeHTML(label)}</button>`;
}

async function handleSubmit(event) {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  if (busy) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    setBusy(true);
    if (form.matches("[data-create-room]")) {
      const payload = await api("/api/rooms", { name: values.name }, "POST");
      navigate(`/room/${payload.room.code}`);
    } else if (form.matches("[data-join-room]")) {
      const code = String(values.code || "").trim().toUpperCase();
      if (!/^[A-Z2-9]{6}$/.test(code)) throw new Error("Enter a six-character room code.");
      await api(`/api/rooms/${code}/join`, { name: values.name }, "POST");
      navigate(`/room/${code}`);
    } else if (form.matches("[data-join-current-room]")) {
      const payload = await api(`/api/rooms/${roomCode}/join`, { name: values.name }, "POST");
      acceptRoom(payload.room);
    } else if (form.matches("[data-room-action]")) {
      await doAction(values);
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function handleClick(event) {
  const home = event.target.closest("[data-home]");
  if (home) {
    event.preventDefault();
    navigate("/");
    return;
  }
  const button = event.target.closest("[data-command]");
  if (!button || busy) return;
  const command = button.dataset.command;
  try {
    setBusy(true);
    if (command === "copy-room") {
      await navigator.clipboard.writeText(`${location.origin}/room/${room.code}`);
      showToast("Invite link copied.");
    } else if (command === "action") {
      await doAction({ type: button.dataset.actionType, ...JSON.parse(button.dataset.actionValues || "{}") });
    } else if (command === "start-game") {
      await doAction({ type: "start-game" });
    } else if (command === "start-turn") {
      await doAction({ type: "start-turn", afterTurnId: room.lastTurn?.id || "" });
    } else if (command === "start-manual" || command === "resume-manual") {
      await startManual(command === "start-manual");
    } else if (command === "start-mic" || command === "resume-mic") {
      await startMicrophone(command === "start-mic");
    } else if (command === "redraw") {
      await doAction({ type: "redraw-turn", turnId: room.activeTurn.id });
    } else if (command === "end-turn") {
      await finishTurn(false, false);
    } else if (command === "mark-complete") {
      await finishTurn(true, false, room.activeTurn.duration);
    } else if (command === "reset") {
      await doAction({ type: "reset" });
    } else if (command === "claim-host") {
      await doAction({ type: "claim-host" });
    }
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function startManual(notifyBegin) {
  const turn = room.activeTurn;
  if (!turn) return;
  if (notifyBegin && turn.begunAt === null) await doAction({ type: "begin-turn", turnId: turn.id });
  controller = { turnId: room.activeTurn.id, mode: "manual", submitting: false };
  updateClock();
}

async function startMicrophone(notifyBegin) {
  const turn = room.activeTurn;
  if (!turn) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone input is unavailable. Use the manual timer.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let context;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Audio monitoring is unavailable. Use the manual timer.");
    context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    if (notifyBegin && turn.begunAt === null) {
      await doAction({ type: "begin-turn", turnId: turn.id });
    }
    controller = {
      turnId: room.activeTurn.id,
      mode: "mic",
      submitting: false,
      stream,
      context,
      analyser,
      samples: new Uint8Array(analyser.fftSize),
      lastVoiceAt: performance.now(),
      raf: 0,
    };
    monitorMicrophone();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") await context.close().catch(() => {});
    throw error;
  }
}

function monitorMicrophone() {
  const active = controller;
  if (!active || active.mode !== "mic" || !room?.activeTurn || active.turnId !== room.activeTurn.id) return;
  active.analyser.getByteTimeDomainData(active.samples);
  let energy = 0;
  for (const sample of active.samples) {
    const centered = (sample - 128) / 128;
    energy += centered * centered;
  }
  const level = Math.sqrt(energy / active.samples.length);
  const normalized = Math.min(1, level * 8);
  const meter = document.querySelector("[data-meter]");
  if (meter) meter.style.width = `${Math.round(normalized * 100)}%`;
  if (level > 0.035) active.lastVoiceAt = performance.now();
  const silentFor = (performance.now() - active.lastVoiceAt) / 1000;
  const voice = document.querySelector("[data-voice]");
  if (voice) voice.textContent = silentFor > room.activeTurn.silence * 0.65 ? "Keep talking…" : "Voice detected";
  // Completion wins when the duration and silence thresholds are crossed in
  // the same animation frame.
  if (remainingSeconds(room.activeTurn) <= 0 && !active.submitting) {
    finishTurn(true, false, room.activeTurn.duration).catch((error) => showToast(error.message));
    return;
  }
  if (silentFor >= room.activeTurn.silence && !active.submitting) {
    finishTurn(false, true).catch((error) => showToast(error.message));
    return;
  }
  active.raf = requestAnimationFrame(monitorMicrophone);
}

async function finishTurn(completed, eliminated, forcedSpoken) {
  const turn = room?.activeTurn;
  if (!turn) return;
  if (controller?.submitting) return;
  if (controller) controller.submitting = true;
  const spokenSeconds = forcedSpoken ?? elapsedSeconds(turn);
  stopController();
  await doAction({ type: "submit-turn", turnId: turn.id, spokenSeconds, completed, eliminated });
}

function updateClock() {
  const turn = room?.activeTurn;
  const timer = document.querySelector("[data-timer]");
  if (!turn || !timer) return;
  const remaining = remainingSeconds(turn);
  timer.textContent = String(remaining);
  if (controller?.turnId === turn.id && remaining <= 0 && !controller.submitting) {
    finishTurn(true, false, turn.duration).catch((error) => showToast(error.message));
  }
}

function elapsedSeconds(turn) {
  if (turn.begunAt === null) return 0;
  return Math.max(0, Math.min(turn.duration, Math.floor((Date.now() + clockOffset - turn.begunAt) / 1000)));
}

function remainingSeconds(turn) {
  return Math.max(0, turn.duration - elapsedSeconds(turn));
}

async function doAction(action) {
  const code = roomCode;
  const generation = routeGeneration;
  const payload = await api(`/api/rooms/${code}/action`, action, "POST");
  if (code !== roomCode || generation !== routeGeneration) return;
  acceptRoom(payload.room);
}

function acceptRoom(next) {
  if (!next || next.code !== roomCode) return;
  // HTTP actions/state refreshes and WebSocket broadcasts race in normal use.
  // Never let an older HTTP snapshot roll the client back after a newer live
  // update has already rendered.
  if (room && next.version < room.version) return;
  room = next;
  clockOffset = room.serverNow - Date.now();
  renderRoom();
  if (room.viewer.isMember) connectSocket();
  if (!clockTimer) clockTimer = window.setInterval(updateClock, 200);
  clearTimeout(claimRefreshTimer);
  if (room.viewer.hostClaimWaitMs > 0) {
    claimRefreshTimer = window.setTimeout(refreshRoomState, room.viewer.hostClaimWaitMs + 150);
  }
}

async function refreshRoomState() {
  const code = roomCode;
  const generation = routeGeneration;
  if (!code) return;
  try {
    const payload = await api(`/api/rooms/${code}/state`);
    if (code !== roomCode || generation !== routeGeneration) return;
    acceptRoom(payload.room);
  } catch (error) {
    showToast(error.message);
  }
}

function reconcileController() {
  if (controller && (!room.activeTurn || room.activeTurn.id !== controller.turnId)) stopController();
}

function stopController() {
  if (!controller) return;
  if (controller.raf) cancelAnimationFrame(controller.raf);
  controller.stream?.getTracks().forEach((track) => track.stop());
  if (controller.context && controller.context.state !== "closed") controller.context.close().catch(() => {});
  controller = null;
}

function connectSocket() {
  if (!roomCode || !room?.viewer.isMember) return;
  if (socketRoom === roomCode && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  disconnectSocket();
  socketRoom = roomCode;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const liveSocket = new WebSocket(`${protocol}//${location.host}/api/rooms/${roomCode}/socket`);
  socket = liveSocket;
  liveSocket.addEventListener("open", () => {
    if (socket !== liveSocket) return;
    reconnectDelay = 750;
    liveSocket.send(JSON.stringify({ type: "sync" }));
  });
  liveSocket.addEventListener("message", (event) => {
    if (socket !== liveSocket) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "state" && payload.room?.code === roomCode) acceptRoom(payload.room);
    } catch {
      // Ignore malformed live messages and keep the room usable over HTTP.
    }
  });
  liveSocket.addEventListener("close", () => {
    if (socket !== liveSocket) return;
    socket = null;
    if (!room?.viewer.isMember || !roomCode) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      refreshRoomState().finally(connectSocket);
    }, reconnectDelay);
    reconnectDelay = Math.min(10_000, reconnectDelay * 1.7);
  });
}

function disconnectSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  const active = socket;
  socket = null;
  socketRoom = "";
  if (active && active.readyState < WebSocket.CLOSING) active.close(1000, "Navigating away");
}

async function api(path, body, method = "GET") {
  const options = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* A non-JSON edge error is handled below. */ }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function navigate(path) {
  history.pushState({}, "", path);
  loadRoute();
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) button.disabled = value;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function notice(message, error = false) {
  return `<div class="notice ${error ? "error" : ""}">${escapeHTML(message)}</div>`;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function shutdown() {
  stopController();
  disconnectSocket();
  clearInterval(clockTimer);
  clearTimeout(claimRefreshTimer);
  clockTimer = 0;
}
