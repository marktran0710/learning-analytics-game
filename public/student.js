const $ = id => document.getElementById(id);
const STUDENT_STORAGE = 'learning-analytics-student-v1';
const letters = 'ABCD';
let config = null;
let roomCode = '';
let playerId = '';
let selectedAnswer = null;
let displayedQuestion = -1;
let latestState = null;
let eventSource = null;
let statePollInterval = null;
let statePollInFlight = false;
let eventStreamConnected = false;
let pollingConnected = false;
let latestServerNow = 0;
let latestStateSignature = '';
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
  const status = $('studentConnection');
  status.classList.toggle('connected', connected);
  status.classList.toggle('disconnected', !connected);
  status.textContent = connected ? 'Connected' : 'Reconnecting…';
}

function showView(view) {
  $('studentJoin').classList.toggle('hidden', view !== 'join');
  $('studentWaiting').classList.toggle('hidden', view !== 'waiting');
  $('studentQuestion').classList.toggle('hidden', view !== 'question');
  $('studentRankings').classList.toggle('hidden', view !== 'rankings');
  $('studentComplete').classList.toggle('hidden', view !== 'complete');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderTeams() {
  const select = $('teamSelect');
  select.replaceChildren();
  for (const team of config.teams) {
    const option = element('option', '', team.name);
    option.value = team.id;
    select.append(option);
  }
}

function renderWaiting(state) {
  showView('waiting');
  $('waitingTeam').textContent = state.player.teamName;
  $('waitingName').textContent = state.player.name;
  $('waitingCode').textContent = `Room ${state.code}`;
}

function updateStudentTimer() {
  if (!latestState || latestState.stage !== 'answer' || !latestState.deadline) return;
  const seconds = Math.max(0, Math.ceil((latestState.deadline - (Date.now() + serverOffset)) / 1000));
  $('studentTimer').textContent = String(seconds);
  $('studentTimer').classList.toggle('urgent', seconds <= 5);
  if (seconds === 0 && !latestState.player.answerLocked) {
    $('submitAnswer').disabled = true;
    $('studentAnswerStatus').textContent = 'Time is up. Results are loading…';
  }
}

function renderAnswers(state) {
  const question = state.question;
  const selected = state.player.answerIndex ?? selectedAnswer;
  const locked = state.player.answerLocked;
  $('studentAnswers').replaceChildren();
  question.options.forEach((label, index) => {
    const button = element('button', 'student-answer-option');
    button.type = 'button';
    button.disabled = locked;
    if (selected === index) button.classList.add('is-selected');
    button.append(element('span', 'answer-letter', letters[index]), element('span', '', label));
    button.addEventListener('click', () => {
      if (state.stage !== 'answer' || state.player.answerLocked) return;
      selectedAnswer = index;
      renderAnswers(state);
      $('submitAnswer').disabled = false;
    });
    $('studentAnswers').append(button);
  });
  $('submitAnswer').disabled = state.player.answerLocked || selected === null || selected === undefined;
  $('submitAnswer').textContent = state.player.answerLocked ? 'Answer locked' : 'Submit answer';
  $('studentAnswerStatus').textContent = state.player.answerLocked
    ? 'Answer locked · waiting for the class results'
    : selected === null || selected === undefined ? 'Choose one answer, then submit.' : 'Answer selected. Submit when you are ready.';
}

function renderQuestion(state) {
  showView('question');
  if (displayedQuestion !== state.index) {
    displayedQuestion = state.index;
    selectedAnswer = null;
  }
  $('studentProgress').textContent = `Question ${state.index + 1} / ${state.totalQuestions}`;
  $('studentProgressFill').style.width = `${((state.index + 1) / state.totalQuestions) * 100}%`;
  $('studentContext').textContent = state.question.context;
  $('studentQuestionTitle').textContent = state.question.prompt;
  renderAnswers(state);
  updateStudentTimer();
}

function renderLeaderboard(state) {
  const list = $('studentLeaderboard');
  list.replaceChildren();
  for (const team of state.leaderboard) {
    const row = element('li', 'leaderboard-row');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', team.name), element('span', '', `${team.correct} correct · ${team.studentCount} ${team.studentCount === 1 ? 'student' : 'students'}`));
    row.append(element('span', 'leaderboard-rank', String(team.rank)), identity, element('span', 'leaderboard-score', `${team.score.toLocaleString()} pts`));
    list.append(row);
  }
}

function renderLeaderboardLists(state, teamListId, individualListId) {
  const teamList = $(teamListId);
  const individualList = $(individualListId);
  teamList.replaceChildren();
  for (const team of state.leaderboard) {
    const row = element('li', 'leaderboard-row');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', team.name), element('span', '', `${team.correct} correct · ${team.studentCount} ${team.studentCount === 1 ? 'student' : 'students'}`));
    row.append(element('span', 'leaderboard-rank', String(team.rank)), identity, element('span', 'leaderboard-score', `${team.score.toLocaleString()} pts`));
    teamList.append(row);
  }

  individualList.replaceChildren();
  for (const student of state.individualLeaderboard) {
    const row = element('li', 'leaderboard-row');
    if (state.player.rank === student.rank) row.classList.add('is-current-player');
    const identity = element('div', 'leaderboard-team');
    identity.append(element('strong', '', student.name), element('span', '', `${student.teamName} · ${student.correct} correct`));
    row.append(element('span', 'leaderboard-rank', String(student.rank)), identity, element('span', 'leaderboard-score', `${student.score.toLocaleString()} pts`));
    individualList.append(row);
  }
}

function renderStudentResultSummary(state, distributionId, answerId, explanationId) {
  const list = $(distributionId);
  list.replaceChildren();
  for (let index = 0; index < 4; index += 1) {
    const item = state.distribution[index];
    const row = element('div', `distribution-row${index === state.question.answerIndex ? ' is-correct' : ''}`);
    row.setAttribute('aria-label', `${item.letter}: ${item.count} answers, ${item.percent} percent`);
    const track = element('div', 'distribution-track');
    const bar = element('div', 'distribution-bar');
    bar.style.width = `${item.percent}%`;
    track.append(bar);
    row.append(element('span', 'distribution-letter', item.letter), track, element('span', 'distribution-value', `${item.count} · ${item.percent}%`));
    list.append(row);
  }
  $(answerId).textContent = `Correct answer: ${letters[state.question.answerIndex]} · ${state.question.options[state.question.answerIndex]}`;
  $(explanationId).textContent = state.question.explanation;
}

function renderRankings(state) {
  showView('rankings');
  $('studentRoundLabel').textContent = `After question ${state.index + 1} / ${state.totalQuestions}`;
  $('studentRoundScore').textContent = `Your rank: #${state.player.rank} · ${state.player.score.toLocaleString()} points · ${state.player.correct} correct`;
  renderStudentResultSummary(state, 'studentRoundDistributionList', 'studentRoundCorrectAnswer', 'studentRoundExplanation');
  renderLeaderboardLists(state, 'studentRoundTeamLeaderboard', 'studentRoundIndividualLeaderboard');
}

function renderComplete(state) {
  showView('complete');
  $('studentFinalTeam').textContent = state.player.teamName;
  $('studentFinalScore').textContent = `Rank #${state.player.rank} · ${state.player.score.toLocaleString()} points · ${state.player.correct} correct answers`;
  renderStudentResultSummary(state, 'studentFinalDistributionList', 'studentFinalCorrectAnswer', 'studentFinalExplanation');
  renderLeaderboardLists(state, 'studentLeaderboard', 'studentFinalIndividualLeaderboard');
}

function render(state) {
  if (state.serverNow < latestServerNow) return;
  latestServerNow = state.serverNow;
  latestState = state;
  serverOffset = state.serverNow - Date.now();
  const signature = JSON.stringify({ ...state, serverNow: undefined });
  if (signature === latestStateSignature) {
    updateStudentTimer();
    return;
  }
  latestStateSignature = signature;
  if (state.stage === 'lobby') renderWaiting(state);
  else if (state.stage === 'done') renderComplete(state);
  else if (state.stage === 'leaderboard') renderRankings(state);
  else renderQuestion(state);
}

async function pollRoomState() {
  if (!roomCode || !playerId || statePollInFlight) return;
  statePollInFlight = true;
  try {
    const state = await api(`/api/rooms/${roomCode}/state?role=student&playerId=${encodeURIComponent(playerId)}`);
    pollingConnected = true;
    if (!eventStreamConnected) setConnection(true);
    render(state);
  } catch {
    pollingConnected = false;
    if (!eventStreamConnected) setConnection(false);
  } finally {
    statePollInFlight = false;
  }
}

function connectEvents() {
  eventSource?.close();
  if (statePollInterval) clearInterval(statePollInterval);
  const query = new URLSearchParams({ role: 'student', playerId });
  eventSource = new EventSource(`/api/rooms/${roomCode}/events?${query}`);
  eventSource.onopen = () => {
    eventStreamConnected = true;
    setConnection(true);
  };
  eventSource.onerror = () => {
    eventStreamConnected = false;
    if (!pollingConnected) setConnection(false);
  };
  eventSource.onmessage = event => {
    try { render(JSON.parse(event.data)); }
    catch { $('joinError').textContent = 'Received an unreadable room update. Reconnecting…'; }
  };
  pollRoomState();
  statePollInterval = setInterval(pollRoomState, 2000);
}

function storeSession(player) {
  playerId = player.id;
  roomCode = $('codeInput').value.replace(/\D/g, '').slice(0, 6) || roomCode;
  localStorage.setItem(STUDENT_STORAGE, JSON.stringify({ code: roomCode, playerId }));
}

async function joinRoom(event) {
  event.preventDefault();
  $('joinError').textContent = '';
  const name = $('nameInput').value.trim();
  roomCode = $('codeInput').value.replace(/\D/g, '').slice(0, 6);
  if (roomCode.length !== 6) {
    $('joinError').textContent = 'Enter the six-digit room code shown on the projector.';
    return;
  }
  try {
    const response = await api(`/api/rooms/${roomCode}/join`, {
      method: 'POST',
      body: JSON.stringify({ name, teamId: $('teamSelect').value }),
    });
    storeSession(response.player);
    render(response.state);
    connectEvents();
  } catch (error) {
    $('joinError').textContent = error.message;
  }
}

async function resumeSession() {
  const queryCode = new URLSearchParams(location.search).get('code')?.replace(/\D/g, '').slice(0, 6) || '';
  const stored = JSON.parse(localStorage.getItem(STUDENT_STORAGE) || 'null');
  const session = stored?.playerId && stored?.code && (!queryCode || queryCode === stored.code) ? stored : null;
  if (!session) {
    if (queryCode) $('codeInput').value = queryCode;
    return;
  }
  roomCode = session.code;
  try {
    const response = await api(`/api/rooms/${roomCode}/reconnect`, {
      method: 'POST',
      body: JSON.stringify({ playerId: session.playerId }),
    });
    playerId = response.player.id;
    $('nameInput').value = response.player.name;
    $('codeInput').value = roomCode;
    render(response.state);
    connectEvents();
  } catch {
    localStorage.removeItem(STUDENT_STORAGE);
    if (queryCode) $('codeInput').value = queryCode;
  }
}

$('joinForm').addEventListener('submit', joinRoom);
$('codeInput').addEventListener('input', () => { $('codeInput').value = $('codeInput').value.replace(/\D/g, '').slice(0, 6); });
$('submitAnswer').addEventListener('click', async () => {
  if (selectedAnswer === null || !latestState || latestState.stage !== 'answer') return;
  $('submitAnswer').disabled = true;
  try {
    await api(`/api/rooms/${roomCode}/answer`, {
      method: 'POST',
      body: JSON.stringify({ playerId, choice: selectedAnswer }),
    });
    const current = await api(`/api/rooms/${roomCode}/state?role=student&playerId=${encodeURIComponent(playerId)}`);
    render(current);
  } catch (error) {
    $('studentAnswerStatus').textContent = error.message;
    $('submitAnswer').disabled = true;
  }
});

async function bootstrap() {
  try {
    config = await api('/api/config');
    renderTeams();
    const queryCode = new URLSearchParams(location.search).get('code')?.replace(/\D/g, '').slice(0, 6) || '';
    if (queryCode) $('codeInput').value = queryCode;
    await resumeSession();
  } catch (error) {
    $('joinError').textContent = error.message || 'The quiz server is unavailable.';
    setConnection(false);
  }
}

setInterval(updateStudentTimer, 200);
bootstrap();
