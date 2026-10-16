// DataGate Remote Live - Smart TV & Touch Client
(function () {
  'use strict';

  // --- DOM Elements ---
  const authScreen = document.getElementById('authScreen');
  const loginForm = document.getElementById('loginForm');
  const corporateEmail = document.getElementById('corporateEmail');
  const authErrorMsg = document.getElementById('authErrorMsg');
  const authWaitingBox = document.getElementById('authWaitingBox');
  const cancelAuthBtn = document.getElementById('cancelAuthBtn');
  const logoutBtn = document.getElementById('logoutBtn');

  const workersModal = document.getElementById('workersModal');
  const closeWorkersModal = document.getElementById('closeWorkersModal');
  const workersListContainer = document.getElementById('workersListContainer');
  const refreshWorkersBtn = document.getElementById('refreshWorkersBtn');
  const switchWorkerBtn = document.getElementById('switchWorkerBtn');
  const openSelectWorkerBtn = document.getElementById('openSelectWorkerBtn');
  const noWorkerOverlay = document.getElementById('noWorkerOverlay');
  const activeWorkerName = document.getElementById('activeWorkerName');

  const appContainer = document.getElementById('appContainer');
  const canvas = document.getElementById('screenCanvas');
  const ctx = canvas.getContext('2d');
  const viewport = document.getElementById('viewport');
  const touchRipple = document.getElementById('touchRipple');
  const fpsCount = document.getElementById('fpsCount');
  const resolutionText = document.getElementById('resolutionText');

  const modeViewBtn = document.getElementById('modeViewBtn');
  const modeControlBtn = document.getElementById('modeControlBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const fullscreenExitDock = document.getElementById('fullscreenExitDock');
  const bottomSwipeZone = document.getElementById('bottomSwipeZone');
  const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');
  const fsSwitchWorkerBtn = document.getElementById('fsSwitchWorkerBtn');
  const fsToggleKbBtn = document.getElementById('fsToggleKbBtn');
  const specialKeysBtn = document.getElementById('specialKeysBtn');
  const specialKeysMenu = document.getElementById('specialKeysMenu');

  // Virtual TV Keyboard Elements
  const virtualKeyboard = document.getElementById('virtualKeyboard');
  const toggleVirtualKbBtn = document.getElementById('toggleVirtualKbBtn');
  const closeKbBtn = document.getElementById('closeKbBtn');
  const clearKbTextBtn = document.getElementById('clearKbTextBtn');
  const kbCapsLock = document.getElementById('kbCapsLock');
  const kbShift = document.getElementById('kbShift');
  const kbDragHandle = document.getElementById('kbDragHandle');
  const kbResizeGrip = document.getElementById('kbResizeGrip');

  // Quality & Misc Elements
  const qualityBtn = document.getElementById('qualityBtn');
  const qualityMenu = document.getElementById('qualityMenu');

  // --- State ---
  let ws = null;
  let authToken = localStorage.getItem('datagate_token') || null;
  let userEmail = localStorage.getItem('datagate_email') || '';
  let authPollingTimer = null;
  let currentRequestId = null;

  let isInteractive = true;
  let selectedWorker = null;
  let availableWorkers = [];
  let remoteWidth = 1920;
  let remoteHeight = 1080;

  let isCapsLock = false;
  let isShift = false;

  let clientFrameCount = 0;
  let lastFpsTime = performance.now();

  // Mouse / Touch Tracking
  let lastMouseMoveTime = 0;
  const MOUSE_THROTTLE_MS = 16;
  let touchStartData = null;
  let longPressTimer = null;
  let twoFingerGesture = null;

  // --- Device Identification ---
  function getDeviceInfo() {
    let id = localStorage.getItem('datagate_device_id');
    if (!id) {
      id = 'tv_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('datagate_device_id', id);
    }
    return {
      id,
      type: 'smart_tv',
      platform: navigator.platform || 'SmartTV Web'
    };
  }

  // ==================== AUTENTICAÇÃO INICIAL (KARL PUSH) ====================
  function initAuth() {
    if (userEmail) {
      corporateEmail.value = userEmail;
    }

    if (authToken) {
      // User already logged in, enter main app and open workers modal
      authScreen.classList.add('hidden');
      connectWebSocket();
      setTimeout(openWorkersModal, 400);
    } else {
      authScreen.classList.remove('hidden');
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = corporateEmail.value.trim().toLowerCase();
    if (!email) return;

    authErrorMsg.classList.add('hidden');
    loginForm.classList.add('hidden');
    authWaitingBox.classList.remove('hidden');

    try {
      const res = await fetch('/api/auth/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          device: getDeviceInfo()
        })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data?.error?.message || 'Falha ao iniciar autenticação.');
      }

      currentRequestId = data.data.requestId;
      userEmail = email;
      localStorage.setItem('datagate_email', email);

      // Start Polling for Karl push verification
      pollAuthStatus(email, currentRequestId);

    } catch (err) {
      showAuthError(err.message || 'Erro ao conectar ao serviço de autenticação.');
    }
  });

  function pollAuthStatus(email, requestId) {
    if (authPollingTimer) clearInterval(authPollingTimer);

    authPollingTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, requestId })
        });

        const data = await res.json();
        if (data.success && data.data && data.data.accessToken) {
          // Karl push authentication approved!
          clearInterval(authPollingTimer);
          authToken = data.data.accessToken;
          localStorage.setItem('datagate_token', authToken);

          // Success transition
          authScreen.classList.add('hidden');
          connectWebSocket();
          setTimeout(openWorkersModal, 300);
        } else if (data.data?.status === 'pending') {
          // Still waiting for Karl push approval...
        } else if (data.data?.status === 'failed') {
          throw new Error('A autenticação foi recusada no Karl.');
        }
      } catch (err) {
        clearInterval(authPollingTimer);
        showAuthError(err.message || 'Falha na verificação de autenticação.');
      }
    }, 2000);
  }

  function showAuthError(msg) {
    if (authPollingTimer) clearInterval(authPollingTimer);
    authWaitingBox.classList.add('hidden');
    loginForm.classList.remove('hidden');
    authErrorMsg.textContent = msg;
    authErrorMsg.classList.remove('hidden');
  }

  cancelAuthBtn.addEventListener('click', () => {
    if (authPollingTimer) clearInterval(authPollingTimer);
    authWaitingBox.classList.add('hidden');
    loginForm.classList.remove('hidden');
  });

  logoutBtn.addEventListener('click', () => {
    if (confirm('Deseja realmente sair da sessão na Smart TV?')) {
      localStorage.removeItem('datagate_token');
      authToken = null;
      if (ws) ws.close();
      authScreen.classList.remove('hidden');
      loginForm.classList.remove('hidden');
      authWaitingBox.classList.add('hidden');
    }
  });

  // ==================== WEBSOCKET & MULTI-WORKER ====================
  function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}?role=viewer`;

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'blob';

    ws.onopen = () => {
      console.log('[RemoteLive TV] Connected to relay server.');
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        handleServerJson(JSON.parse(event.data));
      } else if (event.data instanceof Blob) {
        handleBinaryFrame(event.data);
      }
    };

    ws.onclose = () => {
      console.log('[RemoteLive TV] Relay disconnected. Retrying in 2s...');
      setTimeout(connectWebSocket, 2000);
    };
  }

  function handleServerJson(msg) {
    if (msg.type === 'init_state' || msg.type === 'workers_list') {
      availableWorkers = msg.workers || [];
      renderWorkersList(availableWorkers);

      // Auto-select if only 1 worker is available and none selected yet
      if (availableWorkers.length === 1 && availableWorkers[0].online && !selectedWorker) {
        selectWorker(availableWorkers[0].id);
      }

      // If active worker is no longer online, update badge
      if (selectedWorker) {
        const stillOnline = availableWorkers.some(w => w.id === selectedWorker.id);
        if (!stillOnline) {
          activeWorkerName.textContent = `${selectedWorker.name} (Desconectado)`;
          noWorkerOverlay.classList.remove('hidden');
        }
      }
    } else if (msg.type === 'worker_selected') {
      selectedWorker = msg.worker;
      activeWorkerName.textContent = selectedWorker.name;
      noWorkerOverlay.classList.add('hidden');
      closeWorkersModalDialog();
      if (selectedWorker.screenInfo) {
        updateDimensions(selectedWorker.screenInfo.width, selectedWorker.screenInfo.height);
      }
    } else if (msg.type === 'worker_status') {
      if (!msg.connected && selectedWorker && selectedWorker.id === msg.workerId) {
        activeWorkerName.textContent = `${selectedWorker.name} (Offline)`;
        noWorkerOverlay.classList.remove('hidden');
      }
    }
  }

  async function handleBinaryFrame(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
        updateDimensions(bitmap.width, bitmap.height);
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();

      // FPS Calculation
      clientFrameCount++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        fpsCount.textContent = `${clientFrameCount} FPS`;
        clientFrameCount = 0;
        lastFpsTime = now;
      }
    } catch (err) {
      console.warn('[RemoteLive TV] Render error:', err);
    }
  }

  function updateDimensions(w, h) {
    remoteWidth = w;
    remoteHeight = h;
    resolutionText.textContent = `${w} x ${h}`;
    canvas.style.aspectRatio = `${w} / ${h}`;
  }

  function sendWorkerEvent(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ==================== MODAL DE SELEÇÃO DE WORKERS ====================
  function openWorkersModal() {
    workersModal.classList.remove('hidden');
    renderWorkersList(availableWorkers);
  }

  function closeWorkersModalDialog() {
    workersModal.classList.add('hidden');
  }

  switchWorkerBtn.addEventListener('click', openWorkersModal);
  openSelectWorkerBtn.addEventListener('click', openWorkersModal);
  closeWorkersModal.addEventListener('click', closeWorkersModalDialog);

  refreshWorkersBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/workers');
      const data = await res.json();
      if (data.workers) {
        availableWorkers = data.workers;
        renderWorkersList(availableWorkers);
      }
    } catch {
      // Ignored
    }
  });

  function renderWorkersList(workers) {
    workersListContainer.innerHTML = '';

    if (!workers || workers.length === 0) {
      workersListContainer.innerHTML = `
        <div class="worker-empty-state">
          <div class="push-radar" style="width:60px; height:60px;">
            <div class="pulse-ring"></div>
            <div class="push-icon" style="font-size:24px;">📡</div>
          </div>
          <p><strong>Nenhum worker conectado no momento.</strong></p>
          <p style="font-size:13px; margin-top:6px;">Execute <code>run_worker.bat</code> na máquina de destino para ela aparecer aqui.</p>
        </div>
      `;
      return;
    }

    workers.forEach(w => {
      const isCurrent = selectedWorker && selectedWorker.id === w.id;
      const card = document.createElement('div');
      card.className = `worker-card ${isCurrent ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="worker-card-header">
          <div class="worker-title-box">
            <span class="worker-icon">🖥️</span>
            <div>
              <div class="worker-name">${escapeHtml(w.name)}</div>
              <div class="worker-id">${escapeHtml(w.id)}</div>
            </div>
          </div>
          <span class="worker-badge ${w.online ? 'online' : 'offline'}">
            ${w.online ? '● Online' : '○ Offline'}
          </span>
        </div>
        <div class="worker-card-details">
          <span>Resolução: <strong>${w.resolution || '1920x1080'}</strong></span>
          <span>•</span>
          <span>Taxa: <strong>~${w.fps || 25} FPS</strong></span>
        </div>
        <button class="btn btn-primary btn-connect" type="button">
          ${isCurrent ? '✓ Conectado (Reconectar)' : 'Conectar Nesta Estação ➔'}
        </button>
      `;

      card.addEventListener('click', () => {
        selectWorker(w.id);
      });

      workersListContainer.appendChild(card);
    });
  }

  function selectWorker(workerId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'select_worker',
        workerId: workerId
      }));
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ==================== OTIMIZAÇÃO DE TOQUE E SMART TV ====================
  function getNormalizedCoordinates(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    if (mouseX < 0 || mouseX > rect.width || mouseY < 0 || mouseY > rect.height) {
      return null;
    }

    return {
      x: Math.max(0, Math.min(1, mouseX / rect.width)),
      y: Math.max(0, Math.min(1, mouseY / rect.height))
    };
  }

  function playTouchRipple(clientX, clientY) {
    touchRipple.style.left = `${clientX}px`;
    touchRipple.style.top = `${clientY}px`;
    touchRipple.classList.remove('active');
    void touchRipple.offsetWidth; // Force reflow
    touchRipple.classList.add('active');
    setTimeout(() => touchRipple.classList.remove('active'), 400);
  }

  // ==================== CONTROLE UNIFICADO VIA POINTER EVENTS (TOUCH & MOUSE) ====================
  function getNormalizedCoordinates(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const mouseX = clientX - rect.left;
    const mouseY = clientY - rect.top;

    if (mouseX < 0 || mouseX > rect.width || mouseY < 0 || mouseY > rect.height) {
      return null;
    }

    return {
      x: Math.max(0, Math.min(1, mouseX / rect.width)),
      y: Math.max(0, Math.min(1, mouseY / rect.height))
    };
  }

  function playTouchRipple(clientX, clientY) {
    touchRipple.style.left = `${clientX}px`;
    touchRipple.style.top = `${clientY}px`;
    touchRipple.classList.remove('active');
    void touchRipple.offsetWidth; // Force reflow
    touchRipple.classList.add('active');
    setTimeout(() => touchRipple.classList.remove('active'), 400);
  }

  // Active touch pointers on canvas
  const canvasTouches = new Map();
  let touchLongPressTimer = null;
  let lastTouchEndTime = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!isInteractive) return;

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

      canvasTouches.set(e.pointerId, {
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        hasMoved: false
      });

      // Se for exatamente 1 dedo, prepara long-press (500ms) para Duplo Clique
      if (canvasTouches.size === 1) {
        if (touchLongPressTimer) clearTimeout(touchLongPressTimer);
        const ptrId = e.pointerId;
        touchLongPressTimer = setTimeout(() => {
          const pt = canvasTouches.get(ptrId);
          if (pt && !pt.hasMoved && canvasTouches.size === 1) {
            const coords = getNormalizedCoordinates(pt.startX, pt.startY);
            if (coords) {
              playTouchRipple(pt.startX, pt.startY);
              sendWorkerEvent({
                type: 'double_click',
                x: coords.x,
                y: coords.y
              });
            }
            pt.hasMoved = true; // Consumido para não gerar click simples ao soltar
          }
        }, 500);
      } else {
        if (touchLongPressTimer) {
          clearTimeout(touchLongPressTimer);
          touchLongPressTimer = null;
        }
      }
      return;
    }

    // Mouse físico
    if (e.pointerType === 'mouse') {
      if (performance.now() - lastTouchEndTime < 800) return;
      const coords = getNormalizedCoordinates(e.clientX, e.clientY);
      if (!coords) return;

      const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      sendWorkerEvent({
        type: 'mouse_down',
        button: btn,
        x: coords.x,
        y: coords.y
      });
    }
  }, { passive: false });

  canvas.addEventListener('pointermove', (e) => {
    if (!isInteractive) return;

    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      e.preventDefault();
      const pt = canvasTouches.get(e.pointerId);
      if (!pt) return;

      const dist = Math.hypot(e.clientX - pt.startX, e.clientY - pt.startY);
      if (dist > 8) {
        pt.hasMoved = true;
        if (touchLongPressTimer) {
          clearTimeout(touchLongPressTimer);
          touchLongPressTimer = null;
        }
      }

      // 2 dedos: Pinça para zoom ou scroll com 2 dedos
      if (canvasTouches.size === 2) {
        const pts = Array.from(canvasTouches.values());
        const p1 = pts[0];
        const p2 = pts[1];
        const currentDist = Math.hypot(
          (p1 === pt ? e.clientX : p1.lastX) - (p2 === pt ? e.clientX : p2.lastX),
          (p1 === pt ? e.clientY : p1.lastY) - (p2 === pt ? e.clientY : p2.lastY)
        );
        const lastDist = Math.hypot(p1.lastX - p2.lastX, p1.lastY - p2.lastY);
        const diff = currentDist - lastDist;

        if (Math.abs(diff) > 2.5) {
          const centerX = ((p1 === pt ? e.clientX : p1.lastX) + (p2 === pt ? e.clientX : p2.lastX)) / 2;
          const centerY = ((p1 === pt ? e.clientY : p1.lastY) + (p2 === pt ? e.clientY : p2.lastY)) / 2;
          const coords = getNormalizedCoordinates(centerX, centerY);
          if (coords) {
            sendWorkerEvent({
              type: 'zoom',
              delta: diff,
              x: coords.x,
              y: coords.y
            });
          }
        } else {
          // 2 dedos se movendo juntos: scroll vertical e horizontal
          const stepY = pt.lastY - e.clientY;
          const stepX = pt.lastX - e.clientX;
          if (Math.abs(stepY) >= 2 || Math.abs(stepX) >= 2) {
            sendWorkerEvent({
              type: 'scroll',
              deltaX: stepX * 2.0,
              deltaY: stepY * 2.0
            });
          }
        }
      }
      // 1 dedo arrastando: Scrolla na direção do dedo (NUNCA envia mouse_down ou move, portanto NÃO seleciona)
      else if (canvasTouches.size === 1 && pt.hasMoved) {
        const stepY = pt.lastY - e.clientY;
        const stepX = pt.lastX - e.clientX;
        if (Math.abs(stepY) >= 2 || Math.abs(stepX) >= 2) {
          sendWorkerEvent({
            type: 'scroll',
            deltaX: stepX * 2.5,
            deltaY: stepY * 2.5
          });
        }
      }

      pt.lastX = e.clientX;
      pt.lastY = e.clientY;
      return;
    }

    // Mouse físico
    if (e.pointerType === 'mouse') {
      if (performance.now() - lastTouchEndTime < 800) return;
      const now = performance.now();
      if (now - lastMouseMoveTime < MOUSE_THROTTLE_MS) return;
      lastMouseMoveTime = now;

      const coords = getNormalizedCoordinates(e.clientX, e.clientY);
      if (!coords) return;

      sendWorkerEvent({
        type: 'mouse_move',
        x: coords.x,
        y: coords.y
      });
    }
  }, { passive: false });

  canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      e.preventDefault();
      lastTouchEndTime = performance.now();
      if (touchLongPressTimer) {
        clearTimeout(touchLongPressTimer);
        touchLongPressTimer = null;
      }

      const pt = canvasTouches.get(e.pointerId);
      if (pt && !pt.hasMoved && canvasTouches.size === 1) {
        // Toque simples -> Dispara SOMENTE o click! (Sem mouse_down nem mouse_up)
        const coords = getNormalizedCoordinates(pt.startX, pt.startY);
        if (coords) {
          playTouchRipple(pt.startX, pt.startY);
          sendWorkerEvent({
            type: 'click',
            button: 'left',
            x: coords.x,
            y: coords.y
          });
        }
      }

      canvasTouches.delete(e.pointerId);
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }

    // Mouse físico
    if (e.pointerType === 'mouse') {
      if (performance.now() - lastTouchEndTime < 800) return;
      const coords = getNormalizedCoordinates(e.clientX, e.clientY);
      if (!coords) return;

      const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
      sendWorkerEvent({
        type: 'mouse_up',
        button: btn,
        x: coords.x,
        y: coords.y
      });
    }
  }, { passive: false });

  canvas.addEventListener('pointercancel', (e) => {
    lastTouchEndTime = performance.now();
    if (touchLongPressTimer) {
      clearTimeout(touchLongPressTimer);
      touchLongPressTimer = null;
    }
    canvasTouches.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // Previne ações conflitantes padrão do navegador no canvas
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('dragstart', e => e.preventDefault());
  canvas.addEventListener('selectstart', e => e.preventDefault());

  // Roda do mouse físico (Wheel Scroll)
  canvas.addEventListener('wheel', (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    sendWorkerEvent({
      type: 'scroll',
      deltaX: e.deltaX,
      deltaY: e.deltaY
    });
  }, { passive: false });

  // Physical Keyboard Handlers
  window.addEventListener('keydown', (e) => {
    if (!isInteractive) return;
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }

    if (['Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) ||
        (e.ctrlKey && ['s', 'f', 'p', 'h'].includes(e.key.toLowerCase()))) {
      e.preventDefault();
    }

    sendWorkerEvent({
      type: 'key_down',
      key: e.key,
      code: e.code
    });
  });

  window.addEventListener('keyup', (e) => {
    if (!isInteractive) return;
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
      return;
    }

    sendWorkerEvent({
      type: 'key_up',
      key: e.key,
      code: e.code
    });
  });

  // ==================== TECLADO VIRTUAL SMART TV - FLUTUANTE ARRASTÁVEL ====================
  const KB_SIZE_PRESETS = {
    small:  { width: 480 },
    medium: { width: 620 },
    large:  { width: 760 }
  };
  const KB_STORAGE_POS = 'eyepro_kb_pos';
  const KB_STORAGE_WIDTH = 'eyepro_kb_width';
  const KB_STORAGE_SIZE = 'eyepro_kb_size';

  function saveKbState() {
    const rect = virtualKeyboard.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      localStorage.setItem(KB_STORAGE_POS, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
      localStorage.setItem(KB_STORAGE_WIDTH, Math.round(rect.width).toString());
    }
  }

  // Restore last position and size from localStorage
  function restoreKbState() {
    try {
      // 1. Restaurar Largura / Tamanho
      const savedWidth = parseFloat(localStorage.getItem(KB_STORAGE_WIDTH));
      const savedSizeKey = localStorage.getItem(KB_STORAGE_SIZE) || 'large';

      if (savedWidth && savedWidth >= 280) {
        virtualKeyboard.style.width = `${savedWidth}px`;
        updateKeyboardScale(savedWidth);

        // Identifica se a largura coincide com um dos presets (small, medium, large)
        let matchedPreset = null;
        for (const [key, preset] of Object.entries(KB_SIZE_PRESETS)) {
          if (Math.abs(preset.width - savedWidth) <= 5) {
            matchedPreset = key;
            break;
          }
        }
        document.querySelectorAll('.kb-size-btn').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-size') === matchedPreset);
        });
      } else {
        applyKbSizePreset(savedSizeKey, false);
      }

      // 2. Restaurar Posição (X e Y)
      const pos = JSON.parse(localStorage.getItem(KB_STORAGE_POS) || 'null');
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const maxLeft = Math.max(0, window.innerWidth - 100);
        const maxTop = Math.max(0, window.innerHeight - 80);
        const clampedLeft = Math.max(0, Math.min(maxLeft, pos.left));
        const clampedTop = Math.max(0, Math.min(maxTop, pos.top));
        virtualKeyboard.style.left = clampedLeft + 'px';
        virtualKeyboard.style.top = clampedTop + 'px';
        virtualKeyboard.style.bottom = 'auto';
        virtualKeyboard.style.transform = 'none';
      }
    } catch (_) {}
  }

  function updateKeyboardScale(width) {
    const baseWidth = 740;
    const ratio = Math.max(0.45, Math.min(1.4, width / baseWidth));
    const keyHeight = Math.round(38 * ratio);
    const fontSize = Math.round(13 * ratio);
    const gap = Math.max(2, Math.round(5 * ratio));
    virtualKeyboard.style.setProperty('--kb-key-height', `${keyHeight}px`);
    virtualKeyboard.style.setProperty('--kb-font-size', `${fontSize}px`);
    virtualKeyboard.style.setProperty('--kb-gap', `${gap}px`);
  }

  function applyKbSizePreset(sizeKey, saveToStorage = true) {
    const preset = KB_SIZE_PRESETS[sizeKey] || KB_SIZE_PRESETS.large;
    virtualKeyboard.style.width = preset.width + 'px';
    updateKeyboardScale(preset.width);
    // Mark active preset button
    document.querySelectorAll('.kb-size-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-size') === sizeKey);
    });
    if (saveToStorage) {
      localStorage.setItem(KB_STORAGE_SIZE, sizeKey);
      localStorage.setItem(KB_STORAGE_WIDTH, preset.width.toString());
    }
  }

  function toggleVirtualKeyboard() {
    const isHidden = virtualKeyboard.classList.toggle('hidden');
    if (!isHidden) {
      restoreKbState();
    } else {
      saveKbState();
    }
  }

  toggleVirtualKbBtn.addEventListener('click', toggleVirtualKeyboard);
  closeKbBtn.addEventListener('click', () => {
    saveKbState();
    virtualKeyboard.classList.add('hidden');
  });

  // Size Preset Buttons
  document.querySelectorAll('.kb-size-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyKbSizePreset(btn.getAttribute('data-size'));
    });
  });

  // Clear keyboard (Ctrl+A then Delete)
  if (clearKbTextBtn) {
    clearKbTextBtn.addEventListener('click', () => {
      sendWorkerEvent({ type: 'special_key', action: 'ctrlc' }); // focus confirmation
      setTimeout(() => {
        sendWorkerEvent({ type: 'key_down', key: 'a', code: 'KeyA', ctrlKey: true });
        setTimeout(() => {
          sendWorkerEvent({ type: 'key_up', key: 'a', code: 'KeyA' });
          sendWorkerEvent({ type: 'key_down', key: 'Delete', code: 'Delete' });
          setTimeout(() => sendWorkerEvent({ type: 'key_up', key: 'Delete', code: 'Delete' }), 30);
        }, 30);
      }, 30);
    });
  }

  // --- Drag Logic (pointer events) ---
  let kbDragState = null;

  kbDragHandle.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'BUTTON') return; // Don't drag when clicking buttons
    e.preventDefault();
    kbDragHandle.setPointerCapture(e.pointerId);
    const rect = virtualKeyboard.getBoundingClientRect();
    // Switch from CSS centering to absolute position
    virtualKeyboard.style.left = rect.left + 'px';
    virtualKeyboard.style.top = rect.top + 'px';
    virtualKeyboard.style.bottom = 'auto';
    virtualKeyboard.style.transform = 'none';
    kbDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
  });

  kbDragHandle.addEventListener('pointermove', (e) => {
    if (!kbDragState) return;
    e.preventDefault();
    const dx = e.clientX - kbDragState.startX;
    const dy = e.clientY - kbDragState.startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - 100, kbDragState.origLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - 60, kbDragState.origTop + dy));
    virtualKeyboard.style.left = newLeft + 'px';
    virtualKeyboard.style.top = newTop + 'px';
  });

  kbDragHandle.addEventListener('pointerup', () => {
    if (kbDragState) {
      kbDragState = null;
      saveKbState();
    }
  });

  kbDragHandle.addEventListener('pointercancel', () => {
    if (kbDragState) {
      kbDragState = null;
      saveKbState();
    }
  });

  // --- Resize Logic (corner grip) ---
  let kbResizeState = null;

  kbResizeGrip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    kbResizeGrip.setPointerCapture(e.pointerId);
    const rect = virtualKeyboard.getBoundingClientRect();
    kbResizeState = { startX: e.clientX, origWidth: rect.width };
  });

  kbResizeGrip.addEventListener('pointermove', (e) => {
    if (!kbResizeState) return;
    e.preventDefault();
    const dx = e.clientX - kbResizeState.startX;
    const newWidth = Math.max(280, Math.min(window.innerWidth * 0.98, kbResizeState.origWidth + dx));
    virtualKeyboard.style.width = newWidth + 'px';
    updateKeyboardScale(newWidth);
    // Deactivate all size preset buttons since we're using custom size
    document.querySelectorAll('.kb-size-btn').forEach(btn => btn.classList.remove('active'));
  });

  kbResizeGrip.addEventListener('pointerup', () => {
    if (kbResizeState) {
      kbResizeState = null;
      saveKbState();
    }
  });

  kbResizeGrip.addEventListener('pointercancel', () => {
    if (kbResizeState) {
      kbResizeState = null;
      saveKbState();
    }
  });


  // Caps Lock & Shift
  kbCapsLock.addEventListener('click', () => {
    isCapsLock = !isCapsLock;
    kbCapsLock.classList.toggle('active', isCapsLock);
    updateKeyboardLetterCase();
  });

  kbShift.addEventListener('click', () => {
    isShift = !isShift;
    kbShift.classList.toggle('active', isShift);
    updateKeyboardLetterCase();
  });

  function updateKeyboardLetterCase() {
    const uppercase = isCapsLock || isShift;
    virtualKeyboard.querySelectorAll('.kb-key').forEach(key => {
      const char = key.getAttribute('data-key');
      if (char && char.length === 1 && char.match(/[a-zç]/i)) {
        key.textContent = uppercase ? char.toUpperCase() : char.toLowerCase();
      }
    });
  }

  // Handle Virtual Keys Click
  virtualKeyboard.querySelectorAll('.kb-key').forEach(keyBtn => {
    keyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const key = keyBtn.getAttribute('data-key');
      const action = keyBtn.getAttribute('data-action');

      if (action) {
        // Special Key
        sendWorkerEvent({
          type: 'special_key',
          action: action
        });
        return;
      }

      if (!key) return;

      let sendChar = key;
      if (key.length === 1) {
        const uppercase = isCapsLock || isShift;
        sendChar = uppercase ? key.toUpperCase() : key.toLowerCase();

        // Single stroke shift resets
        if (isShift) {
          isShift = false;
          kbShift.classList.remove('active');
          updateKeyboardLetterCase();
        }
      }

      // Send key stroke
      sendWorkerEvent({
        type: 'key_down',
        key: sendChar,
        code: key === ' ' ? 'Space' : key
      });
      setTimeout(() => {
        sendWorkerEvent({
          type: 'key_up',
          key: sendChar,
          code: key === ' ' ? 'Space' : key
        });
      }, 30);
    });
  });

  // Mode View / Control Toggle
  modeViewBtn.addEventListener('click', () => {
    isInteractive = false;
    modeViewBtn.classList.add('active');
    modeControlBtn.classList.remove('active');
  });

  modeControlBtn.addEventListener('click', () => {
    isInteractive = true;
    modeControlBtn.classList.add('active');
    modeViewBtn.classList.remove('active');
  });

  // ==================== 100% IMMERSIVE FULLSCREEN MODE & GESTURE ====================
  let isImmersive = false;
  let dockHideTimer = null;

  function enterImmersiveFullscreen() {
    isImmersive = true;
    appContainer.classList.add('immersive-fullscreen');
    bottomSwipeZone.classList.remove('hidden');
    fullscreenExitDock.classList.add('hidden');
    document.documentElement.requestFullscreen().catch(() => {});
  }

  function exitImmersiveFullscreen() {
    isImmersive = false;
    appContainer.classList.remove('immersive-fullscreen');
    bottomSwipeZone.classList.add('hidden');
    fullscreenExitDock.classList.add('hidden');
    if (dockHideTimer) clearTimeout(dockHideTimer);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function showExitDock() {
    fullscreenExitDock.classList.remove('hidden');
    if (dockHideTimer) clearTimeout(dockHideTimer);
    dockHideTimer = setTimeout(() => {
      fullscreenExitDock.classList.add('hidden');
    }, 4500);
  }

  fullscreenBtn.addEventListener('click', enterImmersiveFullscreen);
  exitFullscreenBtn.addEventListener('click', exitImmersiveFullscreen);

  fsSwitchWorkerBtn.addEventListener('click', () => {
    openWorkersModal();
    fullscreenExitDock.classList.add('hidden');
  });

  fsToggleKbBtn.addEventListener('click', () => {
    toggleVirtualKeyboard();
    fullscreenExitDock.classList.add('hidden');
  });

  // Tapping bottom swipe bar reveals the exit controls
  bottomSwipeZone.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
  });
  bottomSwipeZone.addEventListener('click', (e) => {
    e.stopPropagation();
    showExitDock();
  });

  // --- Swipe Up Gesture Detection (3-finger touch via Pointer Events) ---
  const windowActiveTouches = new Map();
  let threeFingerStartY = null;

  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      windowActiveTouches.set(e.pointerId, e.clientY);
      if (windowActiveTouches.size === 3) {
        let sum = 0;
        for (const y of windowActiveTouches.values()) sum += y;
        threeFingerStartY = sum / 3;
      }
    }
  }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && windowActiveTouches.has(e.pointerId)) {
      windowActiveTouches.set(e.pointerId, e.clientY);
      if (isImmersive && windowActiveTouches.size === 3 && threeFingerStartY !== null) {
        let sum = 0;
        for (const y of windowActiveTouches.values()) sum += y;
        const currentAvgY = sum / 3;
        if (threeFingerStartY - currentAvgY > 50) {
          showExitDock();
          threeFingerStartY = null;
        }
      }
    }
  }, { passive: true });

  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') {
      windowActiveTouches.delete(e.pointerId);
      if (windowActiveTouches.size < 3) threeFingerStartY = null;
    }
  }, { passive: true });

  window.addEventListener('pointercancel', (e) => {
    if (e.pointerType === 'touch') {
      windowActiveTouches.delete(e.pointerId);
      if (windowActiveTouches.size < 3) threeFingerStartY = null;
    }
  }, { passive: true });

  // Escape key or browser fullscreen exit restores standard view
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isImmersive) {
      exitImmersiveFullscreen();
    }
  });

  // Special Keys Menu
  specialKeysBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    specialKeysBtn.parentElement.classList.toggle('open');
  });

  window.addEventListener('click', () => {
    specialKeysBtn.parentElement.classList.remove('open');
  });

  specialKeysMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      sendWorkerEvent({
        type: 'special_key',
        action: btn.getAttribute('data-key')
      });
      specialKeysBtn.parentElement.classList.remove('open');
    });
  });

  // Quality Dropdown
  const QUALITY_PRESETS = {
    low:    { fps: 20, quality: 65, scale: 0.6 },
    medium: { fps: 25, quality: 75, scale: 0.8 },
    high:   { fps: 30, quality: 82, scale: 1.0 },
    ultra:  { fps: 60, quality: 92, scale: 1.0 }
  };

  if (qualityBtn && qualityMenu) {
    qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('qualityDropdown').classList.toggle('open');
    });

    qualityMenu.querySelectorAll('button[data-quality]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = QUALITY_PRESETS[btn.getAttribute('data-quality')];
        if (preset) {
          sendWorkerEvent({
            type: 'set_settings',
            fps: preset.fps,
            quality: preset.quality,
            scale: preset.scale
          });
          qualityBtn.textContent = `📶 ${btn.textContent.split(' ').slice(1, 2).join(' ')} ▾`;
        }
        document.getElementById('qualityDropdown').classList.remove('open');
      });
    });

    window.addEventListener('click', () => {
      const qd = document.getElementById('qualityDropdown');
      if (qd) qd.classList.remove('open');
    });
  }

  // Start app
  initAuth();
})();
