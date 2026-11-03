import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGameService, TEAMS } from '../game-service.mjs';

const questions = JSON.parse(await readFile(new URL('../questions.json', import.meta.url), 'utf8'));

function createHarness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const service = createGameService({
    questions,
    clock: () => now,
    schedule(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    cancel(id) { timers.delete(id); },
  });
  return {
    service,
    advance(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

function makeRoom(service) {
  const room = service.createRoom('http://localhost:3000/join');
  const student = service.joinRoom(room.code, { name: 'Alex', teamId: TEAMS[0].id });
  return { room, student };
}

test('host starts a room and student answer is locked and revealed after 25 seconds', () => {
  const { service, advance } = createHarness();
  const { room, student } = makeRoom(service);
  service.startRoom(room.code, room.hostToken);

  let studentState = service.state(room.code, { role: 'student', playerId: student.id });
  assert.equal(studentState.stage, 'answer');
  assert.equal(studentState.deadline, 25_000);
  assert.equal(studentState.question.answerIndex, undefined);

  assert.equal(service.submitAnswer(room.code, student.id, questions[0].a).accepted, true);
  assert.equal(service.submitAnswer(room.code, student.id, questions[0].a).alreadySubmitted, true);
  advance(25_000);

  studentState = service.state(room.code, { role: 'student', playerId: student.id });
  assert.equal(studentState.stage, 'reveal');
  assert.equal(studentState.question.answerIndex, questions[0].a);
  assert.equal(studentState.player.answerCorrect, true);
  assert.equal(studentState.distribution[questions[0].a].count, 1);
  assert.ok(studentState.player.score >= 500);
});

test('late answers are rejected and the reveal automatically advances', () => {
  const { service, advance } = createHarness();
  const { room, student } = makeRoom(service);
  service.startRoom(room.code, room.hostToken);
  advance(25_001);

  assert.throws(() => service.submitAnswer(room.code, student.id, 0), /Answers are locked|Time is up/);
  assert.equal(service.state(room.code, { role: 'host', token: room.hostToken }).stage, 'reveal');
  advance(5_000);
  assert.equal(service.state(room.code, { role: 'host', token: room.hostToken }).index, 1);
  assert.equal(service.state(room.code, { role: 'host', token: room.hostToken }).stage, 'answer');
});

test('all 15 questions advance automatically to a team leaderboard and can restart', () => {
  const { service, advance } = createHarness();
  const { room } = makeRoom(service);
  service.startRoom(room.code, room.hostToken);

  for (let index = 0; index < questions.length; index += 1) {
    assert.equal(service.state(room.code, { role: 'host', token: room.hostToken }).index, index);
    advance(30_000);
  }

  let state = service.state(room.code, { role: 'host', token: room.hostToken });
  assert.equal(state.stage, 'done');
  assert.equal(state.leaderboard.length, 1);
  assert.equal(state.leaderboard[0].name, TEAMS[0].name);
  service.restartRoom(room.code, room.hostToken);
  state = service.state(room.code, { role: 'host', token: room.hostToken });
  assert.equal(state.stage, 'lobby');
  assert.equal(state.index, -1);
  assert.equal(state.joinedCount, 1);
});
