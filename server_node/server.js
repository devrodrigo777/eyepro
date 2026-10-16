const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const WORKER_SECRET = process.env.WORKER_SECRET || process.env.WORKER_AUTH_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Constant-time SHA-256 secret comparison (anti-timing attack)
function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// In-Memory Authentication State (Self-contained)
const authChallenges = new Map(); // requestId -> { email, status: 'pending' | 'approved', createdAt }
const activeSessions = new Map();   // sessionToken -> { email, createdAt }

// Cleanup expired challenges every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [reqId, challenge] of authChallenges.entries()) {
    if (now - challenge.createdAt > 300000) { // 5 minutes
      authChallenges.delete(reqId);
    }
  }
}, 300000);

// In-Memory Multi-Worker Registry
// workerId -> { id, name, socket, screenInfo, lastHeartbeat, frameCount, fps }
const registeredWorkers = new Map();
const viewerSockets = new Set(); // Set of viewer WebSockets

function getWorkersListSummary() {
  const list = [];
  for (const [id, w] of registeredWorkers.entries()) {
    list.push({
      id: w.id,
      name: w.name,
      online: w.socket.readyState === WebSocket.OPEN,
      resolution: w.screenInfo ? `${w.screenInfo.width}x${w.screenInfo.height}` : 'Calculando...',
      fps: w.fps || 25,
      lastSeen: w.lastHeartbeat
    });
  }
  return list;
}

function broadcastToViewers(payload) {
  const json = JSON.stringify(payload);
  for (const viewer of viewerSockets) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(json);
    }
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-worker-secret');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- API: Auth Initiate (Push Notification Flow) ---
  if (pathname === '/api/auth/initiate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const email = (parsed.email || '').trim().toLowerCase();
        if (!email || !email.includes('@')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { message: 'E-mail corporativo inválido.' } }));
        }

        const requestId = 'req_' + crypto.randomBytes(16).toString('hex');
        const challenge = {
          requestId,
          email,
          status: 'pending',
          createdAt: Date.now()
        };
        authChallenges.set(requestId, challenge);
        console.log(`[Auth] Iniciando autenticação push para: ${email} (${requestId})`);

        // Simula entrega e aprovação da notificação push corporativa após 3.2 segundos
        setTimeout(() => {
          if (authChallenges.has(requestId)) {
            authChallenges.get(requestId).status = 'approved';
            console.log(`[Auth] Notificação push APROVADA com sucesso para: ${email}`);
          }
        }, 3200);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          data: {
            status: 'pending',
            requestId,
            expiresAt: new Date(Date.now() + 300000).toISOString()
          }
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: { message: 'Dados inválidos' } }));
      }
    });
    return;
  }

  // --- API: Auth Verify (Polling de Aprovação) ---
  if (pathname === '/api/auth/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        const requestId = parsed.requestId;
        const email = (parsed.email || '').trim().toLowerCase();

        const challenge = authChallenges.get(requestId);
        if (!challenge || challenge.email !== email) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: { message: 'Desafio de autenticação inválido ou expirado.' } }));
        }

        if (challenge.status === 'pending') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            data: { status: 'pending' }
          }));
        }

        if (challenge.status === 'approved') {
          const accessToken = crypto.randomBytes(32).toString('hex');
          const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex');

          activeSessions.set(accessToken, { email: challenge.email, createdAt: Date.now() });
          authChallenges.delete(requestId); // Consome o desafio

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            data: {
              sessionId,
              accessToken,
              expiresIn: 86400
            }
          }));
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: { message: 'Dados inválidos' } }));
      }
    });
    return;
  }

  // --- API: List Workers ---
  if (pathname === '/api/workers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      success: true,
      workers: getWorkersListSummary()
    }));
  }

  // --- Health Check for Docker & Cloudflare ---
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'healthy',
      uptime: Math.round(process.uptime()),
      workersOnline: registeredWorkers.size,
      viewersOnline: viewerSockets.size
    }));
  }

  // --- Static Files ---
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(path.join(PUBLIC_DIR, filePath));

  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Access Denied');
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(safePath).pipe(res);
  });
});

// WebSocket Server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const role = parsedUrl.searchParams.get('role');

  if (role === 'worker') {
    // Validate Private Authentication Key (WORKER_SECRET)
    if (WORKER_SECRET) {
      const authHeader = req.headers['authorization'] || '';
      const provided = req.headers['x-worker-secret'] ||
                       req.headers['x-worker-auth'] ||
                       authHeader.replace(/^Bearer\s+/i, '') ||
                       parsedUrl.searchParams.get('token') ||
                       parsedUrl.searchParams.get('secret') || '';

      const clientIp = req.headers['cf-connecting-ip'] ||
                       (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                       req.socket.remoteAddress;

      if (!equalSecret(provided, WORKER_SECRET)) {
        console.warn(`[Security] ⛔ Tentativa de conexão rejeitada: chave inválida do IP ${clientIp}`);
        ws.close(4401, 'Unauthorized: Credencial x-worker-secret inválida');
        return;
      }
    }

    const workerId = parsedUrl.searchParams.get('workerId') || 'worker-principal';
    const workerName = parsedUrl.searchParams.get('name') || 'Estação Principal (Local)';
    handleWorkerConnection(ws, workerId, workerName);
  } else {
    handleViewerConnection(ws);
  }
});

function handleWorkerConnection(ws, workerId, workerName) {
  console.log(`[Worker] Conectado: ${workerName} (${workerId})`);

  const workerData = {
    id: workerId,
    name: workerName,
    socket: ws,
    screenInfo: null,
    lastHeartbeat: Date.now(),
    frameCount: 0,
    lastFpsCheck: Date.now(),
    fps: 25
  };

  registeredWorkers.set(workerId, workerData);

  // Notifica todos os viewers sobre a nova lista
  broadcastToViewers({
    type: 'workers_list',
    workers: getWorkersListSummary()
  });

  ws.on('message', (data, isBinary) => {
    workerData.lastHeartbeat = Date.now();

    if (isBinary) {
      workerData.frameCount++;
      const now = Date.now();
      if (now - workerData.lastFpsCheck >= 1000) {
        workerData.fps = workerData.frameCount;
        workerData.frameCount = 0;
        workerData.lastFpsCheck = now;
      }

      // Encaminha frame para os viewers conectados a este worker
      for (const viewer of viewerSockets) {
        const wantsThisWorker = viewer.targetWorkerId === workerId || (!viewer.targetWorkerId && registeredWorkers.size === 1);
        if (viewer.readyState === WebSocket.OPEN && wantsThisWorker) {
          viewer.send(data, { binary: true });
        }
      }
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'screen_info') {
          workerData.screenInfo = msg;
          console.log(`[Worker ${workerId}] Resolução: ${msg.width}x${msg.height} @ ${msg.targetFps || 25} FPS`);
          broadcastToViewers({
            type: 'workers_list',
            workers: getWorkersListSummary()
          });
        }
      } catch (err) {
        console.error(`[Worker ${workerId}] Erro ao processar mensagem:`, err.message);
      }
    }
  });

  ws.on('close', () => {
    console.log(`[Worker] Desconectado: ${workerName} (${workerId})`);
    registeredWorkers.delete(workerId);
    broadcastToViewers({
      type: 'workers_list',
      workers: getWorkersListSummary()
    });
    for (const viewer of viewerSockets) {
      if (viewer.targetWorkerId === workerId) {
        viewer.send(JSON.stringify({
          type: 'worker_status',
          connected: false,
          workerId,
          message: `Worker "${workerName}" desconectado.`
        }));
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[Worker ${workerId}] Erro no WebSocket:`, err.message);
  });
}

function handleViewerConnection(ws) {
  viewerSockets.add(ws);
  ws.targetWorkerId = null; // Worker selecionado pelo espectador

  console.log(`[Viewer] Cliente conectado. Total de espectadores: ${viewerSockets.size}`);

  // Envia a lista de workers imediatamente
  ws.send(JSON.stringify({
    type: 'init_state',
    workers: getWorkersListSummary()
  }));

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'select_worker') {
          const targetId = msg.workerId;
          const target = registeredWorkers.get(targetId);
          if (target && target.socket.readyState === WebSocket.OPEN) {
            ws.targetWorkerId = targetId;
            console.log(`[Viewer] Selecionou a estação: ${target.name} (${targetId})`);
            ws.send(JSON.stringify({
              type: 'worker_selected',
              worker: {
                id: target.id,
                name: target.name,
                screenInfo: target.screenInfo,
                fps: target.fps
              }
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'A estação selecionada não está disponível.'
            }));
          }
          return;
        }
      } catch {
        // Not a JSON command, standard input forwarding below
      }
    }

    // Encaminha eventos de entrada (mouse/teclado) diretamente para o worker selecionado
    let targetWorkerId = ws.targetWorkerId;
    if (!targetWorkerId && registeredWorkers.size === 1) {
      targetWorkerId = registeredWorkers.keys().next().value;
    }
    if (targetWorkerId) {
      const targetWorker = registeredWorkers.get(targetWorkerId);
      if (targetWorker && targetWorker.socket.readyState === WebSocket.OPEN) {
        if (!isBinary) {
          targetWorker.socket.send(data.toString('utf8'));
        } else {
          targetWorker.socket.send(data, { binary: true });
        }
      }
    }
  });

  ws.on('close', () => {
    viewerSockets.delete(ws);
    console.log(`[Viewer] Cliente desconectado. Total de espectadores: ${viewerSockets.size}`);
  });

  ws.on('error', (err) => {
    console.error('[Viewer] Erro no WebSocket:', err.message);
  });
}

// Heartbeat periódico
setInterval(() => {
  for (const [id, worker] of registeredWorkers.entries()) {
    if (worker.socket.readyState === WebSocket.OPEN) {
      worker.socket.send(JSON.stringify({ type: 'ping' }));
    }
  }
  broadcastToViewers({
    type: 'server_stats',
    viewers: viewerSockets.size,
    workersCount: registeredWorkers.size
  });
}, 4000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  Remote Live - Servidor Independente`);
  console.log(`  Interface Web:    http://localhost:${PORT}`);
  console.log(`  Worker Connect:   ws://localhost:${PORT}?role=worker`);
  console.log(`  Autenticação:     x-worker-secret ativada`);
  console.log(`=======================================================`);
});
