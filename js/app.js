"use strict";

/* ================================================================== *
 * ПАТИ-ИГРЫ — хаб. MVP: каркас комнат + «100 к 1».
 *
 * Данные в БД (узел /party, отдельно от «Шпиона»):
 *   /party/rooms/{CODE}
 *     host, hostSince, status: "lobby"|"feud"|"roundend"
 *     settings: { allowHot }
 *     createdAt, updatedAt, lastQid
 *     players/{pid}: { name, online, joinedAt, lastSeen }
 *     scores/{pid}: <очки>
 *     round: {                       // партия 100 к 1
 *       roundId, qid, pack, q, h1, h2, slots, hintLevel,
 *       order:[pid...], turnIdx, turn,
 *       revealed: { "<i>": {t,p,by,byName} },   // вскрытые ячейки
 *       passes: { pid:true },
 *       pending: { pid, name, text, pass, ts } | null,   // ход ждёт разбора хостом
 *       feedback: { name, text, res, pts, ts },
 *       done, board:[{t,p,by,byName}]            // полное табло — только в конце
 *     }
 *
 * ANTI-PEEK: полные ответы табло держит ТОЛЬКО хост (память + localStorage).
 * В БД до вскрытия ячейки её текста/очков нет. Матчинг догадок делает хост.
 * ================================================================== */

/* ---------- Firebase ---------- */
let db = null;
let initError = "";
try { firebase.initializeApp(firebaseConfig); db = firebase.database(); }
catch (e) { initError = "Firebase не настроен, проверь js/firebase-config.js."; }

const ROOT = "party";
const HOST_TIMEOUT = 15 * 60 * 1000;     // 15 мин — потом передаём ведущего
const ROOM_MAX_AGE = 5 * 60 * 60 * 1000; // 5 ч без активности
const ROOM_EMPTY_AGE = 30 * 60 * 1000;   // 30 мин для пустой комнаты
const RESUME_MAX_AGE = 3 * 60 * 60 * 1000;
const MATCH_THRESHOLD = 3;

/* ---------- Идентичность ---------- */
const LS = { pid: "party_pid", name: "party_name", room: "party_room", secret: "party_secret" };
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
const myId = localStorage.getItem(LS.pid) || (function () { const id = uid(); localStorage.setItem(LS.pid, id); return id; })();
let myName = localStorage.getItem(LS.name) || "";

/* ---------- Состояние сессии ---------- */
let roomRef = null, roomListener = null, connListener = null, heartbeat = null, reactionListener = null;
let currentCode = null, isHost = false, currentRoom = null;
let allowHot = false, selectedGame = "feud";
let hostSecret = null;           // { code, roundId, qid, answers:[{t,p,keys}] }
let lastProcessedTs = 0;         // защита от повторного разбора pending

/* ---------- Утилиты ---------- */
const $ = (id) => document.getElementById(id);
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() { let c = ""; for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]; return c; }
function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function ts() { return firebase.database.ServerValue.TIMESTAMP; }
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
  const home = id === "screen-home";
  const h = $("hango-btn"); if (h) h.classList.toggle("hidden", home);
  const rf = $("react-fab"); if (rf) rf.classList.toggle("hidden", home);
  if (home) { const rm = $("react-menu"); if (rm) rm.classList.add("hidden"); }
}
function saveSecret(s) { hostSecret = s; try { localStorage.setItem(LS.secret, JSON.stringify(s)); } catch (e) {} }
function loadSecret() { if (hostSecret) return hostSecret; try { return JSON.parse(localStorage.getItem(LS.secret)); } catch (e) { return null; } }

/* ---------- Матчинг догадок «по смыслу» ---------- */
function norm(s) {
  return (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9 ]/gi, " ").replace(/\s+/g, " ").trim();
}
// Стоп-слова: служебные, не несут смысла для матчинга.
const STOP = new Set(["и","в","во","на","с","со","у","за","по","от","до","же","ли","а","но","то","что","как","не","ну","это","бы","из","о","об","для","при","про","мне","мой","моя","его","её","их","там","тут","вот"]);
// Значимые токены строки (слова 3+ букв без стоп-слов).
function tokens(str) { return norm(str).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)); }
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
  }
  return d[m][n];
}
// Совпадение двух слов: точное, по основе (общий префикс) или с опечаткой (Левенштейн).
// Для коротких слов (3+) допускаем 1 правку — ловит склонения (еду↔еда, коту↔кот).
function wordMatch(g, t) {
  if (g === t) return true;
  const mn = Math.min(g.length, t.length);
  if (mn >= 4 && (g.startsWith(t) || t.startsWith(g))) return true;
  if (mn >= 3 && lev(g, t) <= 1) return true;
  if (mn >= 7 && lev(g, t) <= 2 && (g.startsWith(t.slice(0, 4)) || t.startsWith(g.slice(0, 4)))) return true;
  return false;
}
// Значимые токены ответа: слова из его текста + все ключи-синонимы (парафразы).
function answerTokens(a) {
  const s = new Set();
  tokens(a.t).forEach((t) => s.add(t));
  (a.keys || []).forEach((k) => tokens(k).forEach((t) => s.add(t)));
  return s;
}
// Матчинг «по смыслу»: пересечение значимых токенов догадки и ответа.
// «Вообще другое» не пересекается ни с чем → мимо. Возвращает индекс лучшего
// ещё не вскрытого ответа (порог MATCH_THRESHOLD), либо -1.
function matchGuess(guess, answers, revealedSet) {
  const gw = tokens(guess);
  if (!gw.length) return -1;
  let best = -1, bestScore = MATCH_THRESHOLD - 1;
  answers.forEach((a, idx) => {
    if (revealedSet.has(idx)) return;
    const toks = answerTokens(a);
    let score = 0;
    gw.forEach((g) => {
      let hit = false;
      toks.forEach((t) => { if (!hit && wordMatch(g, t)) hit = true; });
      if (hit) score += g.length;
    });
    if (score > bestScore) { bestScore = score; best = idx; }
  });
  return best;
}

/* ---------- Присутствие ---------- */
function attachPresence() {
  if (connListener) db.ref(".info/connected").off("value", connListener);
  connListener = db.ref(".info/connected").on("value", (snap) => {
    if (snap.val() === true && roomRef && currentCode) {
      const meRef = roomRef.child("players/" + myId);
      meRef.child("online").onDisconnect().set(false);
      meRef.child("lastSeen").onDisconnect().set(ts());
      meRef.update({ name: myName, online: true, lastSeen: ts() });
    }
  });
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (roomRef) roomRef.child("players/" + myId + "/lastSeen").set(ts());
  }, 25000);
}

/* ---------- Вход / выход / подписка ---------- */
function enterRoom(code, asHost) {
  currentCode = code; isHost = asHost; roomRef = db.ref(ROOT + "/rooms/" + code);
  localStorage.setItem(LS.room, JSON.stringify({ code }));
  attachPresence();
  roomListener = roomRef.on("value", (snap) => {
    const room = snap.val();
    if (!room) { leaveToHome(); return; }
    render(room);
  });
  reactionListener = roomRef.child("reactions").on("child_added", (snap) => {
    const r = snap.val();
    if (r && r.e && Date.now() - (r.ts || 0) < 6000) spawnReaction(r.e);
  });
}
function detachRoom() {
  if (roomRef && roomListener) roomRef.off("value", roomListener);
  if (roomRef && reactionListener) roomRef.child("reactions").off("child_added", reactionListener);
  if (connListener) db.ref(".info/connected").off("value", connListener);
  if (heartbeat) clearInterval(heartbeat);
  reactionListener = roomListener = connListener = roomRef = currentCode = null; isHost = false;
}
function leaveToHome() { detachRoom(); localStorage.removeItem(LS.room); showScreen("screen-home"); }

/* ---------- Рендер ---------- */
function render(room) {
  currentRoom = room;
  $("hango-count").textContent = room.hango || 0;
  isHost = room.host === myId;
  maybeTakeHost(room);
  if (isHost) processPending(room);   // хост разбирает ход текущего игрока

  document.querySelectorAll(".js-leave").forEach((b) => { b.textContent = isHost ? "Закрыть комнату" : "Выйти"; });

  if (room.status === "lobby") { renderLobby(room); showScreen("screen-lobby"); }
  else if (room.status === "feud") { renderFeud(room); showScreen("screen-feud"); }
  else if (room.status === "roundend") { renderRoundEnd(room); showScreen("screen-roundend"); }
}

function playerList(room) {
  return Object.entries(room.players || {}).map(([id, p]) => ({
    id, name: p.name, online: p.online !== false, joinedAt: p.joinedAt || 0, lastSeen: p.lastSeen || 0,
  }));
}
function onlineList(room) { return playerList(room).filter((p) => p.online); }

/* ---------- Передача ведущего ---------- */
function maybeTakeHost(room) {
  const players = room.players || {};
  const hostP = players[room.host];
  const now = Date.now();
  const stale = !hostP || (hostP.online === false && now - (hostP.lastSeen || 0) > HOST_TIMEOUT);
  if (!stale) return;
  const online = onlineList(room).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!online.length || online[0].id !== myId) return;
  roomRef.child("host").transaction(() => myId);
  roomRef.child("hostSince").set(ts());
}

/* ---------- Лобби ---------- */
function renderLobby(room) {
  const list = playerList(room).sort((a, b) => a.joinedAt - b.joinedAt);
  $("lobby-code").textContent = currentCode;
  $("lobby-count").textContent = onlineList(room).length + " / " + list.length;

  const ul = $("lobby-players"); ul.innerHTML = "";
  list.forEach((p) => {
    const li = document.createElement("li");
    if (!p.online) li.classList.add("offline");
    const dot = document.createElement("span"); dot.className = "dot" + (p.online ? "" : " off"); li.appendChild(dot);
    const name = document.createElement("span"); name.className = "p-name";
    name.textContent = p.name + (p.id === myId ? " (ты)" : ""); li.appendChild(name);
    if (p.id === room.host) { const t = document.createElement("span"); t.className = "tag"; t.textContent = "ведущий"; li.appendChild(t); }
    if (isHost && p.id !== myId) {
      const k = document.createElement("button"); k.className = "kick"; k.textContent = "✕"; k.title = "Выгнать";
      k.addEventListener("click", () => kickPlayer(p.id)); li.appendChild(k);
    }
    ul.appendChild(li);
  });

  const hc = $("host-controls"), wait = $("lobby-wait");
  if (isHost) {
    hc.classList.remove("hidden"); wait.classList.add("hidden");
    const enough = onlineList(room).length >= 2;
    $("btn-start").disabled = !enough;
    $("lobby-hint").textContent = enough ? "" : "Нужно минимум 2 онлайн-игрока.";
    $("chk-hot").checked = !!(room.settings && room.settings.allowHot);
  } else { hc.classList.add("hidden"); wait.classList.remove("hidden"); }
}

/* ---------- 100 к 1: рендер игры ---------- */
function renderFeud(room) {
  const r = room.round || {};
  const players = room.players || {};
  $("feud-q").textContent = r.q || "";
  const hintTxt = (r.hintLevel >= 2 && r.h2) ? "Подсказка: " + r.h2 : (r.h1 ? "Подсказка: " + r.h1 : "");
  const hintEl = $("feud-hint"); hintEl.textContent = hintTxt; hintEl.classList.toggle("hidden", !hintTxt);

  // Табло: вскрытые ячейки + закрытые заглушки.
  const revealed = r.revealed || {};
  const board = $("feud-board"); board.innerHTML = "";
  for (let i = 0; i < (r.slots || 0); i++) {
    const li = document.createElement("li");
    const num = document.createElement("span"); num.className = "slot-num"; num.textContent = i + 1; li.appendChild(num);
    const cell = revealed[i];
    const txt = document.createElement("span"); txt.className = "slot-text";
    if (cell) {
      li.classList.add("open");
      txt.innerHTML = escapeHtml(cell.t) + '<span class="slot-by">' + escapeHtml(cell.byName || "") + "</span>";
      const pts = document.createElement("span"); pts.className = "slot-pts"; pts.textContent = cell.p;
      li.appendChild(txt); li.appendChild(pts);
    } else {
      txt.className = "slot-text closed"; txt.textContent = "• • • • •";
      li.appendChild(txt);
    }
    board.appendChild(li);
  }

  // Чей ход + поле ввода.
  const turnP = players[r.turn];
  const myTurn = r.turn === myId && turnP && turnP.online !== false;
  $("feud-input-area").classList.toggle("hidden", !myTurn);
  const waitEl = $("feud-turn-wait");
  if (myTurn) {
    $("feud-turn").textContent = "Твой ход";
    waitEl.classList.add("hidden");
    const g = $("feud-guess"); if (document.activeElement !== g) g.value = "";
  } else {
    waitEl.classList.remove("hidden");
    waitEl.innerHTML = "Ходит <b>" + escapeHtml(turnP ? turnP.name : "") + "</b>" + (turnP && turnP.online === false ? " (не в сети)" : "");
  }

  // Фидбек по последнему ходу.
  const fb = r.feedback, fbEl = $("feud-feedback");
  if (fb) {
    fbEl.className = "feedback " + (fb.res === "hit" ? "hit" : "miss");
    fbEl.textContent = fb.res === "hit"
      ? fb.name + ": «" + fb.text + "» +" + fb.pts
      : fb.name + ": «" + fb.text + "» мимо";
  } else { fbEl.textContent = ""; fbEl.className = "feedback"; }

  // Панель ведущего.
  const hostStrip = $("feud-host");
  if (isHost) {
    hostStrip.classList.remove("hidden");
    $("btn-hint").classList.toggle("hidden", r.hintLevel >= 2 || !r.h2);
    const turnOffline = turnP && turnP.online === false;
    $("btn-skip").classList.toggle("hidden", !turnOffline);
  } else hostStrip.classList.add("hidden");

  renderScores(room, "feud-scores", true);
}

/* ---------- Итог раунда ---------- */
function renderRoundEnd(room) {
  const r = room.round || {};
  $("re-q").textContent = r.q || "";
  const board = $("re-board"); board.innerHTML = "";
  (r.board || []).forEach((cell, i) => {
    const li = document.createElement("li");
    if (cell.by) li.classList.add("open"); else li.classList.add("miss-open");
    const num = document.createElement("span"); num.className = "slot-num"; num.textContent = i + 1; li.appendChild(num);
    const txt = document.createElement("span"); txt.className = "slot-text";
    txt.innerHTML = escapeHtml(cell.t) + (cell.byName ? '<span class="slot-by">' + escapeHtml(cell.byName) + "</span>" : "");
    const pts = document.createElement("span"); pts.className = "slot-pts"; pts.textContent = cell.p;
    li.appendChild(txt); li.appendChild(pts); board.appendChild(li);
  });
  renderScores(room, "re-scores", false);
  if (isHost) { $("re-host").classList.remove("hidden"); $("re-wait").classList.add("hidden"); }
  else { $("re-host").classList.add("hidden"); $("re-wait").classList.remove("hidden"); }
}

/* ---------- Табло счёта ---------- */
function renderScores(room, elId, mini) {
  const players = room.players || {}, scores = room.scores || {};
  const rows = Object.entries(players).map(([id, p]) => ({ id, name: p.name, score: scores[id] || 0, online: p.online !== false }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const max = rows.length ? rows[0].score : 0;
  const el = $(elId); el.innerHTML = "";
  if (!mini) { const t = document.createElement("div"); t.className = "board-title"; t.textContent = "Счёт"; el.appendChild(t); }
  rows.forEach((r, i) => {
    const row = document.createElement("div"); row.className = "board-row";
    if (max > 0 && r.score === max) row.classList.add("lead");
    if (!r.online) row.classList.add("off");
    const left = document.createElement("div"); left.className = "b-name";
    const rank = document.createElement("span"); rank.className = "b-rank"; rank.textContent = i + 1;
    const name = document.createElement("span"); name.textContent = r.name + (r.id === myId ? " (ты)" : "");
    left.appendChild(rank); left.appendChild(name);
    if (!r.online) { const off = document.createElement("span"); off.className = "b-off"; off.textContent = "не в сети"; left.appendChild(off); }
    const sc = document.createElement("span"); sc.className = "b-score"; sc.textContent = r.score;
    row.appendChild(left); row.appendChild(sc); el.appendChild(row);
  });
}

function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* ================================================================== *
 * ДЕЙСТВИЯ ВЕДУЩЕГО
 * ================================================================== */
function pickQuestion(room) {
  const hot = !!(room.settings && room.settings.allowHot);
  const pool = QUESTIONS.filter((q) => hot || q.tag !== "hot");
  const last = room.lastQid;
  let cand = pool.filter((q) => q.id !== last);
  if (!cand.length) cand = pool;
  return cand[randInt(cand.length)];
}

function startRound() {
  if (!roomRef || !currentRoom) return;
  const online = onlineList(currentRoom);
  if (online.length < 2) { $("lobby-hint").textContent = "Нужно минимум 2 онлайн-игрока."; return; }

  const q = pickQuestion(currentRoom);
  const answers = q.answers.map((a) => ({ t: a.t, p: a.p, keys: a.keys || [] }));
  const roundId = Date.now();
  saveSecret({ code: currentCode, roundId, qid: q.id, answers });

  const order = shuffle(online.map((p) => p.id));
  roomRef.update({
    status: "feud",
    lastQid: q.id,
    round: {
      roundId, qid: q.id, pack: q.pack, q: q.q, h1: q.h1 || "", h2: q.h2 || "",
      slots: answers.length, hintLevel: 1,
      order, turnIdx: 0, turn: order[0],
      revealed: {}, passes: {}, pending: null, feedback: null, done: false,
    },
    updatedAt: ts(),
  });
}

// Хост разбирает pending-ход (догадку или пас) текущего игрока.
function processPending(room) {
  const r = room.round; if (!r || r.done) return;
  const pend = r.pending; if (!pend || !pend.ts || pend.ts === lastProcessedTs) return;
  const secret = loadSecret();
  if (!secret || secret.roundId !== r.roundId) return; // хост сменился/потерял табло
  lastProcessedTs = pend.ts;

  const revealed = Object.assign({}, r.revealed || {});
  const revealedSet = new Set(Object.keys(revealed).map(Number));
  const updates = {};
  let feedback = null;

  if (!pend.pass) {
    const idx = matchGuess(pend.text, secret.answers, revealedSet);
    if (idx >= 0) {
      const ans = secret.answers[idx];
      revealed[idx] = { t: ans.t, p: ans.p, by: pend.pid, byName: pend.name };
      revealedSet.add(idx);
      updates["round/revealed/" + idx] = revealed[idx];
      updates["scores/" + pend.pid] = (room.scores && room.scores[pend.pid] || 0) + ans.p;
      feedback = { name: pend.name, text: pend.text, res: "hit", pts: ans.p, ts: pend.ts };
    } else {
      feedback = { name: pend.name, text: pend.text, res: "miss", pts: 0, ts: pend.ts };
    }
  } else {
    updates["round/passes/" + pend.pid] = true;
    feedback = { name: pend.name, text: "пас", res: "miss", pts: 0, ts: pend.ts };
  }

  updates["round/pending"] = null;
  updates["round/feedback"] = feedback;
  updates["updatedAt"] = ts();

  // Все ячейки вскрыты — раунд завершён.
  if (revealedSet.size >= secret.answers.length) { finishRound(room, revealed); return; }

  // Следующий ход (пропуская офлайн и спасовавших).
  const passes = Object.assign({}, r.passes || {});
  if (pend.pass) passes[pend.pid] = true;
  const next = nextTurn(room, r, passes);
  if (next == null) { finishRound(room, revealed); return; }
  updates["round/turnIdx"] = next.idx; updates["round/turn"] = next.pid;
  roomRef.update(updates);
}

// Индекс следующего активного игрока в order, либо null если играть некому.
function nextTurn(room, r, passes) {
  const players = room.players || {};
  const order = r.order || [];
  for (let step = 1; step <= order.length; step++) {
    const idx = (r.turnIdx + step) % order.length;
    const pid = order[idx];
    const p = players[pid];
    if (p && p.online !== false && !passes[pid]) return { idx, pid };
  }
  return null;
}

// Завершение раунда: раскрываем полное табло (из секрета хоста).
function finishRound(room, revealed) {
  const secret = loadSecret();
  const r = room.round || {};
  revealed = revealed || r.revealed || {};
  let board;
  if (secret && secret.roundId === r.roundId) {
    board = secret.answers.map((a, i) => {
      const cell = revealed[i];
      return cell ? { t: a.t, p: a.p, by: cell.by, byName: cell.byName } : { t: a.t, p: a.p };
    });
  } else {
    board = Object.keys(revealed).map((i) => revealed[i]); // фолбэк без секрета
  }
  roomRef.update({ status: "roundend", "round/done": true, "round/board": board, "round/pending": null, updatedAt: ts() });
}

function hostRevealHint() { if (roomRef) roomRef.child("round/hintLevel").set(2); }
function hostSkipTurn() {
  if (!roomRef || !currentRoom) return;
  const r = currentRoom.round; if (!r) return;
  const passes = Object.assign({}, r.passes || {});
  const next = nextTurn(currentRoom, r, passes);
  if (next == null) { finishRound(currentRoom, r.revealed || {}); return; }
  roomRef.update({ "round/turnIdx": next.idx, "round/turn": next.pid, updatedAt: ts() });
}
function hostEndRound() { if (currentRoom) finishRound(currentRoom, (currentRoom.round || {}).revealed || {}); }
function hostNextRound() { startRound(); }
function hostToLobby() { if (roomRef) roomRef.update({ status: "lobby", round: null, updatedAt: ts() }); }

/* ================================================================== *
 * ДЕЙСТВИЯ ИГРОКА (ход пишется в pending, разбирает хост)
 * ================================================================== */
function submitGuess() {
  if (!roomRef || !currentRoom) return;
  const r = currentRoom.round; if (!r || r.turn !== myId) return;
  const text = $("feud-guess").value.trim();
  if (!text) return;
  $("feud-guess").value = "";
  roomRef.child("round/pending").set({ pid: myId, name: myName, text, pass: false, ts: Date.now() });
}
function passTurn() {
  if (!roomRef || !currentRoom) return;
  const r = currentRoom.round; if (!r || r.turn !== myId) return;
  roomRef.child("round/pending").set({ pid: myId, name: myName, text: "", pass: true, ts: Date.now() });
}

/* ================================================================== *
 * СОЗДАНИЕ / ВХОД / ВЫХОД / КИК
 * ================================================================== */
function readName() { return $("input-name").value.trim(); }
function homeError(msg) { const el = $("home-error"); el.textContent = msg; }

function meObject() { return { name: myName, online: true, joinedAt: ts(), lastSeen: ts() }; }

function createGame() {
  if (!db) return homeError("Firebase не настроен.");
  const name = readName(); if (!name) return homeError("Введи имя.");
  myName = name; localStorage.setItem(LS.name, name);
  createWithFreeCode(6);
}
function createWithFreeCode(tries) {
  const code = makeCode(), ref = db.ref(ROOT + "/rooms/" + code);
  ref.once("value").then((snap) => {
    if (snap.exists()) { if (tries > 0) return createWithFreeCode(tries - 1); return homeError("Не вышло создать, попробуй ещё."); }
    ref.set({
      host: myId, hostSince: ts(), status: "lobby", settings: { allowHot: false },
      createdAt: ts(), updatedAt: ts(),
      players: { [myId]: meObject() },
    }).then(() => enterRoom(code, true)).catch(() => homeError("Не удалось создать комнату."));
  }).catch(() => homeError("Ошибка подключения к Firebase."));
}
function joinGame() {
  if (!db) return homeError("Firebase не настроен.");
  const name = readName(); if (!name) return homeError("Введи имя.");
  const code = $("input-code").value.trim().toUpperCase();
  if (code.length !== 4) return homeError("Код из 4 символов.");
  myName = name; localStorage.setItem(LS.name, name);
  const ref = db.ref(ROOT + "/rooms/" + code);
  ref.once("value").then((snap) => {
    if (!snap.exists()) return homeError("Комната не найдена.");
    ref.child("players/" + myId).once("value").then((ps) => {
      const exists = ps.exists();
      const upd = exists ? { name: myName, online: true, lastSeen: ts() } : meObject();
      ref.child("players/" + myId).update(upd).then(() => { enterRoom(code, snap.val().host === myId); ref.child("updatedAt").set(ts()); });
    });
  }).catch(() => homeError("Ошибка подключения к Firebase."));
}
function leaveGame() {
  if (!roomRef) return leaveToHome();
  if (isHost) roomRef.remove().finally(leaveToHome);
  else roomRef.child("players/" + myId).remove().finally(leaveToHome);
  localStorage.removeItem(LS.secret);
}
function kickPlayer(pid) {
  if (!roomRef || !isHost) return;
  const updates = {}; updates["players/" + pid] = null; updates["scores/" + pid] = null; updates["updatedAt"] = ts();
  roomRef.update(updates);
}

/* ---------- Автоочистка + автовосстановление ---------- */
function cleanupOldRooms() {
  if (!db) return;
  const now = Date.now();
  db.ref(ROOT + "/rooms").once("value").then((snap) => {
    const rooms = snap.val() || {};
    Object.entries(rooms).forEach(([code, r]) => {
      const age = now - (r.updatedAt || r.createdAt || 0);
      const noPlayers = !r.players || Object.keys(r.players).length === 0;
      if (age > ROOM_MAX_AGE || (noPlayers && age > ROOM_EMPTY_AGE)) db.ref(ROOT + "/rooms/" + code).remove();
    });
  }).catch(() => {});
}
function tryResume() {
  let saved; try { saved = JSON.parse(localStorage.getItem(LS.room)); } catch (e) { saved = null; }
  if (!saved || !saved.code || !myName || !db) return;
  db.ref(ROOT + "/rooms/" + saved.code).once("value").then((snap) => {
    const room = snap.val();
    const age = room ? Date.now() - (room.updatedAt || room.createdAt || 0) : Infinity;
    if (!room || age > RESUME_MAX_AGE) { localStorage.removeItem(LS.room); return; }
    const meRef = db.ref(ROOT + "/rooms/" + saved.code + "/players/" + myId);
    meRef.once("value").then((ps) => {
      const upd = ps.exists() ? { online: true, lastSeen: ts() } : meObject();
      meRef.update(upd);
    });
    enterRoom(saved.code, room.host === myId);
  });
}

/* ---------- Реакции (эфемерные, синхрон через /reactions) ---------- */
function sendReaction(e) {
  if (!roomRef || !e) return;
  const ref = roomRef.child("reactions").push({ e, ts: Date.now() });
  setTimeout(() => ref.remove(), 5000);
}
function spawnReaction(e) {
  const layer = $("reaction-layer"); if (!layer) return;
  // Якорь — видимое игровое поле (табло), иначе центр активного экрана.
  let anchor = null;
  if (!$("screen-feud").classList.contains("hidden")) anchor = $("feud-board");
  else if (!$("screen-roundend").classList.contains("hidden")) anchor = $("re-board");
  else anchor = document.querySelector(".screen:not(.hidden) .wrap");
  let rect = anchor && anchor.getBoundingClientRect();
  if (!rect || !rect.width) rect = { left: window.innerWidth / 2 - 120, width: 240, bottom: window.innerHeight * 0.6, height: 200 };
  const el = document.createElement("span");
  el.className = "reaction-pop";
  el.textContent = e;
  el.style.left = (rect.left + 16 + Math.random() * Math.max(20, rect.width - 32)) + "px";
  el.style.top = (rect.bottom - 24 - Math.random() * Math.min(140, rect.height * 0.5)) + "px";
  el.style.setProperty("--dx", (Math.random() * 60 - 30) + "px");
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

/* ---------- UI ---------- */
function bindUI() {
  $("input-name").value = myName;
  if (initError) homeError(initError);
  $("input-name").addEventListener("input", (e) => { myName = e.target.value.trim(); localStorage.setItem(LS.name, e.target.value); });
  $("btn-create").addEventListener("click", createGame);
  $("btn-join").addEventListener("click", joinGame);
  document.querySelectorAll(".js-leave").forEach((b) => b.addEventListener("click", leaveGame));

  $("input-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  $("btn-copy").addEventListener("click", () => {
    if (navigator.clipboard && currentCode) navigator.clipboard.writeText(currentCode).catch(() => {});
    const b = $("btn-copy"), t = b.textContent; b.textContent = "Скопировано"; setTimeout(() => (b.textContent = t), 1200);
  });

  document.querySelectorAll("#seg-game .seg-btn").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return; selectedGame = b.dataset.value;
    document.querySelectorAll("#seg-game .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
  }));
  $("chk-hot").addEventListener("change", (e) => { if (roomRef && isHost) roomRef.child("settings/allowHot").set(e.target.checked); });
  $("btn-start").addEventListener("click", startRound);

  $("btn-guess").addEventListener("click", submitGuess);
  $("feud-guess").addEventListener("keydown", (e) => { if (e.key === "Enter") submitGuess(); });
  $("btn-pass").addEventListener("click", passTurn);
  $("btn-hint").addEventListener("click", hostRevealHint);
  $("btn-skip").addEventListener("click", hostSkipTurn);
  $("btn-end-round").addEventListener("click", hostEndRound);
  $("btn-next-round").addEventListener("click", hostNextRound);
  $("btn-to-lobby").addEventListener("click", hostToLobby);

  // Плавающая кнопка — общий счётчик комнаты (синхрон через Firebase, привязан к коду)
  $("hango-btn").addEventListener("click", () => {
    if (roomRef) roomRef.child("hango").transaction((v) => (v || 0) + 1);
  });

  // Реакции: меню в правом углу, эмодзи всплывают у всех
  const reactFab = $("react-fab"), reactMenu = $("react-menu");
  reactFab.addEventListener("click", (ev) => { ev.stopPropagation(); reactMenu.classList.toggle("hidden"); });
  document.querySelectorAll("#react-menu .react-emoji").forEach((b) =>
    b.addEventListener("click", () => sendReaction(b.textContent)));
  document.addEventListener("click", (ev) => {
    if (!reactMenu.classList.contains("hidden") && !reactMenu.contains(ev.target) && ev.target !== reactFab)
      reactMenu.classList.add("hidden");
  });
}

bindUI();
cleanupOldRooms();
tryResume();
