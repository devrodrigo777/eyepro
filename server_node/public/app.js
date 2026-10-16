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
  const floatingKbTrigger = document.getElementById('floatingKbTrigger');
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

  let lastTouchTimestamp = 0;

  // Touch Handlers for Smart TV & Touch Screens
  canvas.addEventListener('touchstart', (e) => {
    if (!isInteractive || e.touches.length === 0) return;
    e.preventDefault(); // Prevents browser scroll/zoom and synthetic mouse events
    lastTouchTimestamp = performance.now();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const coords = getNormalizedCoordinates(touch.clientX, touch.clientY);
      if (!coords) return;

      touchStartData = {
        clientX: touch.clientX,
        clientY: touch.clientY,
        coords: coords,
        lastCoords: coords,
        time: performance.now(),
        moved: false,
        dragging: false
      };

      // Long press (450ms) triggers native remote Right Click!
      longPressTimer = setTimeout(() => {
        if (touchStartData && !touchStartData.moved) {
          playTouchRipple(touch.clientX, touch.clientY);
          // Trigger Right Click
          sendWorkerEvent({
            type: 'mouse_down',
            button: 'right',
            x: touchStartData.coords.x,
            y: touchStartData.coords.y
          });
          setTimeout(() => {
            sendWorkerEvent({
              type: 'mouse_up',
              button: 'right',
              x: touchStartData.coords.x,
              y: touchStartData.coords.y
            });
          }, 30);
          touchStartData = null; // Consume touch
        }
      }, 450);

    } else if (e.touches.length === 2) {
      if (longPressTimer) clearTimeout(longPressTimer);
      if (touchStartData && touchStartData.dragging) {
        sendWorkerEvent({
          type: 'mouse_up',
          button: 'left',
          x: touchStartData.lastCoords.x,
          y: touchStartData.lastCoords.y
        });
      }
      touchStartData = null;
      const [firstTouch, secondTouch] = e.touches;
      twoFingerGesture = {
        startY: (firstTouch.clientY + secondTouch.clientY) / 2,
        lastY: (firstTouch.clientY + secondTouch.clientY) / 2,
        startDistance: Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY),
        lastDistance: Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY),
        mode: null
      };
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!isInteractive) return;
    e.preventDefault();
    lastTouchTimestamp = performance.now();

    if (e.touches.length === 1 && touchStartData) {
      const touch = e.touches[0];
      const dist = Math.hypot(touch.clientX - touchStartData.clientX, touch.clientY - touchStartData.clientY);
      if (dist > 6) {
        touchStartData.moved = true;
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
        if (!touchStartData.dragging) {
          touchStartData.dragging = true;
          sendWorkerEvent({
            type: 'mouse_down',
            button: 'left',
            x: touchStartData.coords.x,
            y: touchStartData.coords.y
          });
        }
      }

      const now = performance.now();
      if (now - lastMouseMoveTime >= MOUSE_THROTTLE_MS) {
        lastMouseMoveTime = now;
        const coords = getNormalizedCoordinates(touch.clientX, touch.clientY);
        if (coords) {
          touchStartData.lastCoords = coords;
          sendWorkerEvent({
            type: 'mouse_move',
            x: coords.x,
            y: coords.y
          });
        }
      }
    } else if (e.touches.length === 2 && twoFingerGesture) {
      const [firstTouch, secondTouch] = e.touches;
      const currentY = (firstTouch.clientY + secondTouch.clientY) / 2;
      const currentDistance = Math.hypot(firstTouch.clientX - secondTouch.clientX, firstTouch.clientY - secondTouch.clientY);
      const distanceChange = currentDistance - twoFingerGesture.lastDistance;

      if (!twoFingerGesture.mode) {
        if (Math.abs(currentDistance - twoFingerGesture.startDistance) > 6) {
          twoFingerGesture.mode = 'zoom';
        } else if (Math.abs(currentY - twoFingerGesture.startY) > 6) {
          twoFingerGesture.mode = 'scroll';
        }
      }

      if (twoFingerGesture.mode === 'zoom' && Math.abs(distanceChange) > 0.5) {
        const centerX = (firstTouch.clientX + secondTouch.clientX) / 2;
        const centerY = (firstTouch.clientY + secondTouch.clientY) / 2;
        const coords = getNormalizedCoordinates(centerX, centerY);
        if (coords) {
          sendWorkerEvent({
            type: 'zoom',
            delta: distanceChange,
            x: coords.x,
            y: coords.y
          });
        }
      } else if (twoFingerGesture.mode === 'scroll') {
        sendWorkerEvent({
          type: 'scroll',
          deltaY: (twoFingerGesture.lastY - currentY) * 2.5
        });
      }

      twoFingerGesture.lastY = currentY;
      twoFingerGesture.lastDistance = currentDistance;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    lastTouchTimestamp = performance.now();
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    if (touchStartData && !touchStartData.moved) {
      // Single tap -> Left Click
      playTouchRipple(touchStartData.clientX, touchStartData.clientY);
      sendWorkerEvent({
        type: 'click',
        button: 'left',
        x: touchStartData.coords.x,
        y: touchStartData.coords.y
      });
    } else if (touchStartData && touchStartData.dragging) {
      const touch = e.changedTouches && e.changedTouches[0];
      const coords = touch
        ? getNormalizedCoordinates(touch.clientX, touch.clientY)
        : touchStartData.lastCoords;
      const finalCoords = coords || touchStartData.lastCoords;
      sendWorkerEvent({
        type: 'mouse_up',
        button: 'left',
        x: finalCoords.x,
        y: finalCoords.y
      });
    }

    touchStartData = null;
    twoFingerGesture = null;
  });

  canvas.addEventListener('touchcancel', () => {
    lastTouchTimestamp = performance.now();
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (touchStartData && touchStartData.dragging) {
      sendWorkerEvent({
        type: 'mouse_up',
        button: 'left',
        x: touchStartData.lastCoords.x,
        y: touchStartData.lastCoords.y
      });
    }
    touchStartData = null;
    twoFingerGesture = null;
  });

  // Standard Mouse Handlers (Air mouse / Wireless mouse on Smart TV)
  // Ignore synthetic mouse events fired by touch browsers
  canvas.addEventListener('mousemove', (e) => {
    if (!isInteractive || performance.now() - lastTouchTimestamp < 600) return;
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
  });

  canvas.addEventListener('mousedown', (e) => {
    if (!isInteractive || performance.now() - lastTouchTimestamp < 600) return;
    const coords = getNormalizedCoordinates(e.clientX, e.clientY);
    if (!coords) return;

    const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendWorkerEvent({
      type: 'mouse_down',
      button: btn,
      x: coords.x,
      y: coords.y
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!isInteractive || performance.now() - lastTouchTimestamp < 600) return;
    const coords = getNormalizedCoordinates(e.clientX, e.clientY);
    if (!coords) return;

    const btn = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
    sendWorkerEvent({
      type: 'mouse_up',
      button: btn,
      x: coords.x,
      y: coords.y
    });
  });

  canvas.addEventListener('contextmenu', e => e.preventDefault());

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
  const KB_STORAGE_SIZE = 'eyepro_kb_size';

  // Restore last position from localStorage
  function restoreKbPosition() {
    try {
      const pos = JSON.parse(localStorage.getItem(KB_STORAGE_POS) || 'null');
      const sizeKey = localStorage.getItem(KB_STORAGE_SIZE) || 'large';
      if (pos) {
        virtualKeyboard.style.left = pos.left + 'px';
        virtualKeyboard.style.top = pos.top + 'px';
        virtualKeyboard.style.bottom = 'auto';
        virtualKeyboard.style.transform = 'none';
      }
      applyKbSizePreset(sizeKey, false);
    } catch (_) {}
  }

  function saveKbPosition() {
    const rect = virtualKeyboard.getBoundingClientRect();
    localStorage.setItem(KB_STORAGE_POS, JSON.stringify({ left: rect.left, top: rect.top }));
  }

  function applyKbSizePreset(sizeKey, saveToStorage = true) {
    const preset = KB_SIZE_PRESETS[sizeKey] || KB_SIZE_PRESETS.large;
    virtualKeyboard.style.width = preset.width + 'px';
    // Mark active preset button
    document.querySelectorAll('.kb-size-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-size') === sizeKey);
    });
    if (saveToStorage) localStorage.setItem(KB_STORAGE_SIZE, sizeKey);
  }

  function toggleVirtualKeyboard() {
    const isHidden = virtualKeyboard.classList.toggle('hidden');
    if (!isHidden) restoreKbPosition();
  }

  toggleVirtualKbBtn.addEventListener('click', toggleVirtualKeyboard);
  floatingKbTrigger.addEventListener('click', toggleVirtualKeyboard);
  closeKbBtn.addEventListener('click', () => virtualKeyboard.classList.add('hidden'));

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
    if (kbDragState) { kbDragState = null; saveKbPosition(); }
  });

  kbDragHandle.addEventListener('pointercancel', () => { kbDragState = null; });

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
    const newWidth = Math.max(320, Math.min(window.innerWidth * 0.98, kbResizeState.origWidth + dx));
    virtualKeyboard.style.width = newWidth + 'px';
    // Deactivate all size preset buttons since we're using custom size
    document.querySelectorAll('.kb-size-btn').forEach(btn => btn.classList.remove('active'));
  });

  kbResizeGrip.addEventListener('pointerup', () => { kbResizeState = null; });
  kbResizeGrip.addEventListener('pointercancel', () => { kbResizeState = null; });


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
  bottomSwipeZone.addEventListener('click', (e) => {
    e.stopPropagation();
    showExitDock();
  });

  // --- Swipe Up Gesture Detection (Touch & Pointer) ---
  let swipeStartY = 0;
  let swipeStartX = 0;

  window.addEventListener('touchstart', (e) => {
    if (!isImmersive || e.touches.length === 0) return;
    swipeStartY = e.touches[0].clientY;
    swipeStartX = e.touches[0].clientX;
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (!isImmersive || !e.changedTouches || e.changedTouches.length === 0) return;
    const endY = e.changedTouches[0].clientY;
    const endX = e.changedTouches[0].clientX;
    const deltaY = swipeStartY - endY;
    const deltaX = Math.abs(swipeStartX - endX);

    // If dragged UP by 50px or more (and more vertical than horizontal)
    if (deltaY > 50 && deltaY > deltaX) {
      showExitDock();
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
