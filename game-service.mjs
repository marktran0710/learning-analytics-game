import { randomInt, randomUUID } from 'node:crypto';

export const TEAMS = [
  { id: 'team-1', name: 'Team 1', color: '#67e5c6' },
  { id: 'team-2', name: 'Team 2', color: '#70b8ff' },
  { id: 'team-3', name: 'Team 3', color: '#b69aff' },
  { id: 'team-4', name: 'Team 4', color: '#ffaeaf' },
  { id: 'team-5', name: 'Team 5', color: '#ffd36e' },
  { id: 'team-6', name: 'Team 6', color: '#98df7c' },
];

export class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createGameService({
  questions,
  answerSeconds = 25,
  clock = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  onChange = () => {},
} = {}) {
  if (!Array.isArray(questions) || questions.length !== 15) {
    throw new Error('The quiz must contain exactly 15 questions.');
  }

  const rooms = new Map();
  const answerMs = answerSeconds * 1000;

  function getRoom(code) {
    const room = rooms.get(String(code || '').replace(/\D/g, '').slice(0, 6));
    if (!room) throw new GameError(404, 'Room not found. Check the game code.');
    return room;
  }

  function notify(room) {
    onChange(room);
  }

  function clearRoomTimer(room) {
    if (room.timer !== null) cancel(room.timer);
    room.timer = null;
  }

  function newCode() {
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
    return code;
  }

  function createRoom(joinUrl) {
    const code = newCode();
    const room = {
      code,
      hostToken: randomUUID(),
      joinUrl,
      stage: 'lobby',
      index: -1,
      deadline: null,
      timer: null,
      players: new Map(),
      answers: new Map(),
      distribution: [0, 0, 0, 0],
      clients: new Set(),
      createdAt: clock(),
    };
    rooms.set(code, room);
    return room;
  }

  function requireHost(code, token) {
    const room = getRoom(code);
    if (!token || token !== room.hostToken) throw new GameError(403, 'Host access is required.');
    return room;
  }

  function startQuestion(room, index) {
    clearRoomTimer(room);
    room.index = index;
    room.stage = 'answer';
    room.deadline = clock() + answerMs;
    room.answers = new Map();
    room.distribution = [0, 0, 0, 0];
    const questionIndex = index;
    room.timer = schedule(() => {
      if (room.stage === 'answer' && room.index === questionIndex) finishQuestion(room);
    }, answerMs);
    notify(room);
  }

  function finishQuestion(room) {
    if (room.stage !== 'answer') return;
    clearRoomTimer(room);
    room.stage = room.index + 1 < questions.length ? 'leaderboard' : 'done';
    room.deadline = null;
    notify(room);
  }

  function joinRoom(code, { name, teamId }) {
    const room = getRoom(code);
    if (room.stage !== 'lobby') throw new GameError(409, 'This game has already started.');
    const cleanName = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
    if (cleanName.length < 1) throw new GameError(400, 'Enter your name to join.');
    if (!TEAMS.some(team => team.id === teamId)) throw new GameError(400, 'Choose a team to join.');
    if (room.players.size >= 150) throw new GameError(409, 'This room has reached its 150-student limit.');
    const player = {
      id: randomUUID(),
      name: cleanName,
      teamId,
      score: 0,
      correct: 0,
      connected: true,
    };
    room.players.set(player.id, player);
    notify(room);
    return player;
  }

  function reconnectPlayer(code, playerId) {
    const room = getRoom(code);
    const player = room.players.get(playerId);
    if (!player) throw new GameError(404, 'This student session was not found. Join again with the room code.');
    player.connected = true;
    notify(room);
    return player;
  }

  function setConnected(code, playerId, connected) {
    const room = getRoom(code);
    const player = room.players.get(playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    notify(room);
  }

  function startRoom(code, token) {
    const room = requireHost(code, token);
    if (room.stage !== 'lobby') throw new GameError(409, 'This game has already started.');
    if (room.players.size === 0) throw new GameError(409, 'Wait for at least one student to join.');
    startQuestion(room, 0);
    return room;
  }

  function startNextQuestion(code, token) {
    const room = requireHost(code, token);
    if (room.stage !== 'leaderboard' || room.index + 1 >= questions.length) {
      throw new GameError(409, 'The next question is not ready to start.');
    }
    startQuestion(room, room.index + 1);
    return room;
  }

  function restartRoom(code, token) {
    const room = requireHost(code, token);
    if (room.stage !== 'done') throw new GameError(409, 'The game can be restarted after the final leaderboard.');
    clearRoomTimer(room);
    for (const player of room.players.values()) {
      player.score = 0;
      player.correct = 0;
    }
    room.answers = new Map();
    room.distribution = [0, 0, 0, 0];
    room.index = -1;
    room.deadline = null;
    room.stage = 'lobby';
    notify(room);
    return room;
  }

  function submitAnswer(code, playerId, choice) {
    const room = getRoom(code);
    const player = room.players.get(playerId);
    if (!player) throw new GameError(403, 'Join this room before submitting an answer.');
    if (room.stage !== 'answer') throw new GameError(409, 'Answers are locked right now.');
    if (clock() >= room.deadline) {
      finishQuestion(room);
      throw new GameError(409, 'Time is up. The answer has been locked.');
    }
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) throw new GameError(400, 'Choose A, B, C, or D.');
    if (room.answers.has(playerId)) return { accepted: true, alreadySubmitted: true };

    const selectedAt = clock();
    const question = questions[room.index];
    const correct = choice === question.a;
    let points = 0;
    if (correct) {
      const timeLeft = Math.max(0, room.deadline - selectedAt);
      points = 500 + Math.round(500 * timeLeft / answerMs);
      player.score += points;
      player.correct += 1;
    }
    room.answers.set(playerId, { choice, correct, points, selectedAt });
    room.distribution[choice] += 1;
    notify(room);
    return { accepted: true, alreadySubmitted: false, correct, points };
  }

  function leaderboard(room) {
    return TEAMS.map(team => {
      const members = [...room.players.values()].filter(player => player.teamId === team.id);
      return {
        ...team,
        studentCount: members.length,
        score: members.reduce((sum, player) => sum + player.score, 0),
        correct: members.reduce((sum, player) => sum + player.correct, 0),
        members: members.map(player => ({ name: player.name, score: player.score, correct: player.correct })),
      };
    }).filter(team => team.studentCount > 0)
      .sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name))
      .map((team, index) => ({ ...team, rank: index + 1 }));
  }

  function rankedPlayers(room) {
    return [...room.players.values()]
      .sort((a, b) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name))
  }

  function individualLeaderboard(players) {
    return players.map((player, index) => ({
        rank: index + 1,
        name: player.name,
        teamId: player.teamId,
        teamName: TEAMS.find(team => team.id === player.teamId)?.name,
        score: player.score,
        correct: player.correct,
      }));
  }

  function state(code, { role, token, playerId } = {}) {
    const room = getRoom(code);
    const isHost = role === 'host';
    if (isHost && token !== room.hostToken) throw new GameError(403, 'Host access is required.');
    const player = playerId ? room.players.get(playerId) : null;
    if (!isHost && !player) throw new GameError(403, 'Join this room before viewing its student screen.');
    const current = room.index >= 0 && room.index < questions.length ? questions[room.index] : null;
    const ownAnswer = player ? room.answers.get(player.id) : null;
    const showLeaderboard = ['leaderboard', 'done'].includes(room.stage);
    const showResults = showLeaderboard;
    const ranked = showLeaderboard ? rankedPlayers(room) : null;
    const roomTeams = TEAMS.map(team => {
      const members = [...room.players.values()].filter(item => item.teamId === team.id);
      return {
        ...team,
        studentCount: members.length,
        connectedCount: members.filter(item => item.connected).length,
        score: members.reduce((sum, item) => sum + item.score, 0),
      };
    });
    const result = {
      code: room.code,
      stage: room.stage,
      index: room.index,
      totalQuestions: questions.length,
      serverNow: clock(),
      deadline: room.deadline,
      answerSeconds,
      joinUrl: room.joinUrl,
      joinedCount: room.players.size,
      answeredCount: room.answers.size,
      teams: roomTeams,
      question: current ? {
        context: current.c,
        prompt: current.q,
        options: current.o,
        source: current.s,
        ...(showResults ? { answerIndex: current.a, explanation: current.e } : {}),
      } : null,
      distribution: showResults ? room.distribution.map((count, index) => ({
        letter: 'ABCD'[index],
        count,
        percent: room.answers.size ? Math.round(count / room.answers.size * 100) : 0,
      })) : null,
      leaderboard: showLeaderboard ? leaderboard(room) : null,
      individualLeaderboard: ranked ? individualLeaderboard(ranked) : null,
      player: player ? {
        id: player.id,
        name: player.name,
        teamId: player.teamId,
        teamName: TEAMS.find(team => team.id === player.teamId)?.name,
        score: player.score,
        correct: player.correct,
        rank: ranked ? ranked.findIndex(item => item.id === player.id) + 1 : null,
        connected: player.connected,
        answerIndex: ownAnswer?.choice ?? null,
        answerCorrect: ownAnswer?.correct ?? null,
        answerLocked: room.stage !== 'answer' || !!ownAnswer,
      } : null,
    };
    if (isHost) {
      result.students = [...room.players.values()].map(item => ({
        name: item.name,
        teamId: item.teamId,
        teamName: TEAMS.find(team => team.id === item.teamId)?.name,
        connected: item.connected,
        score: item.score,
      }));
    }
    return result;
  }

  return {
    rooms,
    getRoom,
    createRoom,
    joinRoom,
    reconnectPlayer,
    setConnected,
    startRoom,
    startNextQuestion,
    restartRoom,
    submitAnswer,
    state,
  };
}
