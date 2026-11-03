import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createGameService, GameError, TEAMS } from './game-service.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const questions = JSON.parse(await readFile(resolve(ROOT, 'questions.json'), 'utf8'));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

let game;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16_384) throw new GameError(413, 'Request is too large.');
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { throw new GameError(400, 'Invalid request data.'); }
}

function lanAddress() {
  const addresses = Object.values(os.networkInterfaces()).flatMap(items => items || [])
    .filter(item => item.family === 'IPv4' && !item.internal)
    .map(item => item.address);
  return addresses.find(address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) || addresses[0] || 'localhost';
}

function joinBase(req) {
  const isSecure = req.headers['x-forwarded-proto'] === 'https';
  const protocol = isSecure ? 'https' : 'http';
  const requestHost = String(req.headers.host || `localhost:${PORT}`);
  const isLocalHost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(requestHost.split(':')[0]);
  const host = isLocalHost ? lanAddress() : requestHost.split(':')[0];
  const port = isLocalHost && PORT !== 80 && PORT !== 443 ? `:${PORT}` : '';
  return `${protocol}://${host}${port}`;
}

function stateForClient(room, client) {
  return game.state(room.code, client.role === 'host'
    ? { role: 'host', token: client.token }
    : { role: 'student', playerId: client.playerId });
}

function pushState(room, client) {
  if (client.res.destroyed || client.res.writableEnded) return false;
  try {
    client.res.write(`data: ${JSON.stringify(stateForClient(room, client))}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function broadcast(room) {
  for (const client of room.clients) {
    if (!pushState(room, client)) room.clients.delete(client);
  }
}

game = createGameService({
  questions,
  answerSeconds: Number(process.env.ANSWER_SECONDS || 25),
  onChange: broadcast,
});

function subscribe(req, res, room, client) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  room.clients.add(client);
  if (client.role === 'student') game.setConnected(room.code, client.playerId, true);
  pushState(room, client);

  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 20_000);

  res.on('close', () => {
    clearInterval(heartbeat);
    room.clients.delete(client);
    if (client.role === 'student') game.setConnected(room.code, client.playerId, false);
  });
}

async function serveStatic(pathname, res) {
  const aliases = { '/': '/index.html', '/host': '/index.html', '/join': '/student.html' };
  const requested = aliases[pathname] || pathname;
  const file = resolve(PUBLIC_DIR, `.${requested}`);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) {
    json(res, 403, { error: 'Forbidden.' });
    return;
  }
  if (!existsSync(file)) {
    json(res, 404, { error: 'Page not found.' });
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    json(res, 200, { ok: true, questions: questions.length });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    json(res, 200, {
      teams: TEAMS,
      answerSeconds: Number(process.env.ANSWER_SECONDS || 25),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const room = game.createRoom('');
    room.joinUrl = `${joinBase(req)}/join?code=${room.code}`;
    json(res, 201, { code: room.code, hostToken: room.hostToken, joinUrl: room.joinUrl });
    return;
  }

  if (segments[0] !== 'api' || segments[1] !== 'rooms' || !segments[2]) {
    json(res, 404, { error: 'API route not found.' });
    return;
  }

  const code = segments[2];
  const action = segments[3] || '';

  if (req.method === 'POST' && action === 'join') {
    const player = game.joinRoom(code, await readBody(req));
    json(res, 201, { player: { id: player.id, name: player.name, teamId: player.teamId }, state: game.state(code, { role: 'student', playerId: player.id }) });
    return;
  }

  if (req.method === 'POST' && action === 'reconnect') {
    const { playerId } = await readBody(req);
    const player = game.reconnectPlayer(code, playerId);
    json(res, 200, { player: { id: player.id, name: player.name, teamId: player.teamId }, state: game.state(code, { role: 'student', playerId: player.id }) });
    return;
  }

  if (req.method === 'GET' && action === 'state') {
    const role = url.searchParams.get('role');
    const state = role === 'host'
      ? game.state(code, { role, token: url.searchParams.get('token') })
      : game.state(code, { role: 'student', playerId: url.searchParams.get('playerId') });
    json(res, 200, state);
    return;
  }

  if (req.method === 'GET' && action === 'events') {
    const role = url.searchParams.get('role');
    const client = role === 'host'
      ? { role, token: url.searchParams.get('token'), res }
      : { role: 'student', playerId: url.searchParams.get('playerId'), res };
    const room = game.getRoom(code);
    stateForClient(room, client);
    subscribe(req, res, room, client);
    return;
  }

  if (req.method === 'POST' && action === 'start') {
    const { token } = await readBody(req);
    game.startRoom(code, token);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && action === 'next') {
    const { token } = await readBody(req);
    game.startNextQuestion(code, token);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && action === 'restart') {
    const { token } = await readBody(req);
    game.restartRoom(code, token);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && action === 'answer') {
    const { playerId, choice } = await readBody(req);
    json(res, 200, game.submitAnswer(code, playerId, choice));
    return;
  }

  json(res, 404, { error: 'API route not found.' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error instanceof GameError ? error.status : 500;
    json(res, status, { error: error.message || 'Unexpected server error.' });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Learning Analytics Quiz ready on http://localhost:${PORT}`);
    console.log('Students on the same Wi-Fi can join using the address shown on the projector.');
  });
}

export { server, game };
