const $ = id => document.getElementById(id);
const HOST_STORAGE = 'learning-analytics-host-v1';
const letters = 'ABCD';
let roomInfo = null;
let latestState = null;
let shownRankIndex = -1;
let eventSource = null;
let timerInterval = null;
let statePollInterval = null;
let serverOffset = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function setConnection(connected) {
  for (const id of ['hostConnection', 'hostConnectionQuestion']) {
    const element = $(id);
    element.classList.toggle('connected', connected);
    element.classList.toggle('disconnected', !connected);
    element.textContent = connected ? 'Connected' : 'Reconnecting…';
  }
}

function showView(stage) {
  $('hostLobby').classList.toggle('hidden', stage !== 'lobby');
  $('hostQuestion').classList.toggle('hidden', stage !== 'answer');
  $('hostRankings').classList.toggle('hidden', stage !== 'leaderboard');
  $('hostComplete').classList.toggle('hidden', stage !== 'done');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderLobby(state) {
  showView('lobby');
  $('roomCode').textContent = state.code;
  $('joinUrl').textContent = state.joinUrl;
  $('joinUrl').href = state.joinUrl;
  $('joinQr').src = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(state.joinUrl)}`;
  $('studentCount').textContent = String(state.joinedCount);
  $('studentList').replaceChildren();
  $('emptyRoster').classList.toggle('hidden', state.students.length > 0);
  for (const student of state.students) {
    const row = element('li', 'student-row');
    const team = state.teams.find(item => item.id === student.teamId);
    const dot = element('span', 'student-dot');
    dot.style.setProperty('--team-color', team?.color || '#67e5c6');
    dot.setAttribute('aria-hidden', 'true');
    row.append(dot, element('span', '', student.name), element('span', 'team-name', student.connected ? team?.name || '' : 'offline'));
    $('studentList').append(row);
  }
  $('startGame').disabled = state.joinedCount === 0;
  $('startHint').textContent = state.joinedCount === 0
    ? 'Waiting for students to join.'
    : `${state.joinedCount} ${state.joinedCount === 1 ? 'student is' : 'students are'} ready.`;
  $('hostMessage').textContent = '';
}

function renderDistribution(state, distributionId, correctId, explanationId, sourceId) {
  const question = state.question;
  $(distributionId).replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const item = state.distribution[index];
    const row = element('div', `distribution-row${index === question.answerIndex ? ' is-correct' : ''}`);
    row.setAttribute('aria-label', `${item.letter}: ${item.count} answers, ${item.percent} percent`);
    const barTrack = element('div', 'distribution-track');
    const bar = element('div', 'distribution-bar');
    bar.style.width = `${item.percent}%`;
    barTrack.append(bar);
    row.append(element('span', 'distribution-letter', item.letter), barTrack, element('span', 'distribution-value', `${item.count} · ${item.percent}%`));
    $(distributionId).append(row);
  }
  $(correctId).textContent = `Correct answer: ${letters[question.answerIndex]} · ${question.options[question.answerIndex]}`;
  $(explanationId).textContent = question.explanation;
  $(sourceId).textContent = question.source;
}

function renderResultSummary(state, prefix) {
  renderDistribution(
    state,
    `${prefix}DistributionList`,
    `${prefix}CorrectAnswer`,
    `${prefix}ExplanationText`,
    `${prefix}QuestionSource`,
  );
}

function renderQuestion(state) {
  showView(state.stage);
  const question = state.question;
  $('questionProgress').textContent = `Question ${state.index + 1} / ${state.totalQuestions}`;
  $('progressFill').style.width = `${((state.index + 1) / state.totalQuestions) * 100}%`;
  $('questionContext').textContent = question.context;
  $('questionTitle').textContent = question.prompt;
  $('hostRoundLabel').textContent = state.index < 5
    ? 'Round 1 · Understand learning data'
    : state.index < 11 ? 'Round 2 · Detect learning behavior' : 'Round 3 · Responsible AI decisions';
  $('phaseLabel').textContent = 'Answers open';
  $('answerChoices').replaceChildren();
  question.options.forEach((label, index) => {
    const choice = element('div', 'answer-option');
    choice.append(element('span', 'answer-letter', letters[index]), element('span', '', label));
    $('answerChoices').append(choice);
  });
  $('answerStatus').textContent = `${state.answeredCount} of ${state.joinedCount} answers received`;
  updateTimer();
}

function renderLeaderboard(state) {
  $('finalLeaderboard').replaceChildren();
  for (const team of state.leaderboard) {
    const row = element('li', 'leaderboard-row');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', team.name), element('span', '', `${team.correct} correct answers · ${team.studentCount} ${team.studentCount === 1 ? 'student' : 'students'}`));
    row.append(element('span', 'leaderboard-rank', String(team.rank)), identity, element('span', 'leaderboard-score', `${team.score.toLocaleString()} pts`));
    $('finalLeaderboard').append(row);
  }
}

function renderLeaderboards(state, teamListId, individualListId) {
  const teamList = $(teamListId);
  const individualList = $(individualListId);
  teamList.replaceChildren();
  for (const team of state.leaderboard) {
    const row = element('li', 'leaderboard-row');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', team.name), element('span', '', `${team.correct} correct answers · ${team.studentCount} ${team.studentCount === 1 ? 'student' : 'students'}`));
    row.append(element('span', 'leaderboard-rank', String(team.rank)), identity, element('span', 'leaderboard-score', `${team.score.toLocaleString()} pts`));
    teamList.append(row);
  }

  individualList.replaceChildren();
  for (const student of state.individualLeaderboard) {
    const row = element('li', 'leaderboard-row');
    if (state.player?.rank === student.rank) row.classList.add('is-current-player');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', student.name), element('span', '', `${student.teamName} · ${student.correct} correct`));
    row.append(element('span', 'leaderboard-rank', String(student.rank)), identity, element('span', 'leaderboard-score', `${student.score.toLocaleString()} pts`));
    individualList.append(row);
  }
}

function renderRankings(state) {
  showView('leaderboard');
  if (shownRankIndex !== state.index) {
    $('nextQuestion').disabled = false;
    shownRankIndex = state.index;
  }
  $('roundRankingLabel').textContent = `After question ${state.index + 1} / ${state.totalQuestions}`;
  $('nextQuestion').textContent = `Start question ${state.index + 2}`;
  $('rankingMessage').textContent = '';
  renderResultSummary(state, 'round');
  renderLeaderboards(state, 'roundTeamLeaderboard', 'roundIndividualLeaderboard');
}

function render(state) {
  latestState = state;
  serverOffset = state.serverNow - Date.now();
  if (state.stage === 'lobby') renderLobby(state);
  else if (state.stage === 'done') {
    showView('done');
    renderResultSummary(state, 'final');
    renderLeaderboards(state, 'finalLeaderboard', 'finalIndividualLeaderboard');
  } else if (state.stage === 'leaderboard') renderRankings(state);
  else renderQuestion(state);
  updateTimer();
}

function updateTimer() {
  if (!latestState || latestState.stage !== 'answer' || !latestState.deadline) return;
  const seconds = Math.max(0, Math.ceil((latestState.deadline - (Date.now() + serverOffset)) / 1000));
  $('hostTimer').textContent = String(seconds);
  $('hostTimer').classList.toggle('urgent', seconds <= 5);
}

function connectEvents() {
  eventSource?.close();
  if (statePollInterval) clearInterval(statePollInterval);
  const query = new URLSearchParams({ role: 'host', token: roomInfo.hostToken });
  eventSource = new EventSource(`/api/rooms/${roomInfo.code}/events?${query}`);
  eventSource.onopen = () => setConnection(true);
  eventSource.onerror = () => setConnection(false);
  eventSource.onmessage = event => {
    try { render(JSON.parse(event.data)); }
    catch { $('hostMessage').textContent = 'Received an unreadable room update. Reconnecting…'; }
  };
  statePollInterval = setInterval(async () => {
    try {
      const state = await api(`/api/rooms/${roomInfo.code}/state?role=host&token=${encodeURIComponent(roomInfo.hostToken)}`);
      render(state);
    } catch {
      setConnection(false);
    }
  }, 2000);
}

async function createRoom() {
  const result = await api('/api/rooms', { method: 'POST', body: '{}' });
  roomInfo = result;
  localStorage.setItem(HOST_STORAGE, JSON.stringify(roomInfo));
  render(await api(`/api/rooms/${roomInfo.code}/state?role=host&token=${encodeURIComponent(roomInfo.hostToken)}`));
  connectEvents();
}

async function bootstrap() {
  try {
    const stored = JSON.parse(localStorage.getItem(HOST_STORAGE) || 'null');
    if (stored?.code && stored?.hostToken) {
      roomInfo = stored;
      try {
        render(await api(`/api/rooms/${roomInfo.code}/state?role=host&token=${encodeURIComponent(roomInfo.hostToken)}`));
        connectEvents();
        return;
      } catch {
        localStorage.removeItem(HOST_STORAGE);
      }
    }
    await createRoom();
  } catch (error) {
    setConnection(false);
    $('hostMessage').textContent = error.message || 'Could not create a room. Refresh to try again.';
  }
}

$('startGame').addEventListener('click', async () => {
  $('startGame').disabled = true;
  $('hostMessage').textContent = '';
  try { await api(`/api/rooms/${roomInfo.code}/start`, { method: 'POST', body: JSON.stringify({ token: roomInfo.hostToken }) }); }
  catch (error) { $('hostMessage').textContent = error.message; $('startGame').disabled = latestState?.joinedCount === 0; }
});

$('restartGame').addEventListener('click', async () => {
  try { await api(`/api/rooms/${roomInfo.code}/restart`, { method: 'POST', body: JSON.stringify({ token: roomInfo.hostToken }) }); }
  catch (error) { $('hostMessage').textContent = error.message; }
});

$('nextQuestion').addEventListener('click', async () => {
  $('nextQuestion').disabled = true;
  $('rankingMessage').textContent = '';
  try {
    await api(`/api/rooms/${roomInfo.code}/next`, { method: 'POST', body: JSON.stringify({ token: roomInfo.hostToken }) });
  } catch (error) {
    $('rankingMessage').textContent = error.message;
    $('nextQuestion').disabled = false;
  }
});

$('fullscreenButton').addEventListener('click', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => {
  $('fullscreenButton').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
});
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key.toLowerCase() === 'f') $('fullscreenButton').click();
});

timerInterval = setInterval(updateTimer, 200);
bootstrap();
