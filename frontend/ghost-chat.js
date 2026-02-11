// ─────────────────────────────────────────────────────────────
//  ghost-chat.js — Military Grade Upgrade
//  WebSocket + AES-256-GCM + Media (image/audio) + Tap-to-View
//  + Anti-leak watermark + Ephemeral self-destruct
// ─────────────────────────────────────────────────────────────

const GhostChat = (() => {
    'use strict';

    // ── Configuration ──────────────────────────────────────
    const EPHEMERAL_DELAY_MS = 10_000;
    const EPHEMERAL_FADE_MS = 2_000;
    const VISIBILITY_THRESHOLD = 0.6;
    const RECONNECT_BASE_MS = 1_000;
    const RECONNECT_MAX_MS = 15_000;
    const MAX_MEDIA_BYTES = 5 * 1024 * 1024; // 5MB

    // ── State ──────────────────────────────────────────────
    let ws = null;
    let sessionPassword = null;
    let userId = null;
    let recipientId = null;
    let isConnected = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let watermarkEl = null;
    let watermarkAnimId = null;

    // ── Resolve WS URL from current page location ──────────
    function buildWsUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}`;
    }

    // ── DOM refs ───────────────────────────────────────────
    const dom = () => ({
        ghostMode:      document.getElementById('ghost-mode'),
        messages:       document.getElementById('ghost-messages'),
        input:          document.getElementById('ghost-input'),
        sendBtn:        document.getElementById('ghost-send-btn'),
        connStatus:     document.getElementById('ghost-conn-status'),
        passwordModal:  document.getElementById('ghost-password-overlay'),
        passwordInput:  document.getElementById('ghost-password'),
        passwordBtn:    document.getElementById('ghost-password-btn'),
        aliasInput:     document.getElementById('ghost-alias'),
        recipientInput: document.getElementById('ghost-recipient'),
        photoBtn:       document.getElementById('ghost-photo-btn'),
        photoInput:     document.getElementById('ghost-photo-input'),
        micBtn:         document.getElementById('ghost-mic-btn'),
    });

    // ── Initialize ─────────────────────────────────────────

    function init() {
        const d = dom();

        d.passwordBtn.addEventListener('click', handlePasswordSubmit);
        d.passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handlePasswordSubmit();
        });

        d.sendBtn.addEventListener('click', handleSend);
        d.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });

        // Photo button
        d.photoBtn.addEventListener('click', () => d.photoInput.click());
        d.photoInput.addEventListener('change', handlePhotoSelected);

        // Mic button — hold to record
        d.micBtn.addEventListener('mousedown', startRecording);
        d.micBtn.addEventListener('mouseup', stopRecording);
        d.micBtn.addEventListener('mouseleave', stopRecording);
        d.micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
        d.micBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });
    }

    function handlePasswordSubmit() {
        const d = dom();
        const alias = (d.aliasInput.value || '').trim();
        const pw    = (d.passwordInput.value || '').trim();
        const to    = (d.recipientInput.value || '').trim();

        if (!alias || !pw) return;

        userId = alias;
        sessionPassword = pw;
        recipientId = to || null;

        d.passwordModal.classList.remove('active');
        d.input.focus();

        connectWebSocket();
        startWatermark();
        addSystemMessage('Sesion cifrada iniciada \u00b7 clave efimera en memoria');
    }

    // ── WebSocket ──────────────────────────────────────────

    function connectWebSocket() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        const url = buildWsUrl();

        try {
            ws = new WebSocket(url);
        } catch {
            addSystemMessage('\u26A0 No se pudo crear la conexion WebSocket');
            updateConnectionUI(false);
            scheduleReconnect();
            return;
        }

        ws.addEventListener('open', () => {
            isConnected = true;
            reconnectAttempts = 0;
            updateConnectionUI(true);
            ws.send(JSON.stringify({ type: 'register', userId }));
            addSystemMessage('Conexion establecida \u00b7 registrado como ' + userId);
        });

        ws.addEventListener('message', async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            switch (msg.type) {
                case 'new_message':
                    await handleIncomingMessage(msg.message);
                    break;
                case 'pending_messages':
                    if (msg.messages && msg.messages.length > 0) {
                        addSystemMessage(`${msg.count} mensaje(s) pendiente(s)`);
                        for (const m of msg.messages) await handleIncomingMessage(m);
                    }
                    break;
                case 'message_sent': break;
                case 'message_seen':
                    addSystemMessage('\u2713\u2713 Visto por ' + msg.seenBy);
                    break;
                case 'all_messages_seen':
                    addSystemMessage('\u2713\u2713 ' + msg.seenBy + ' vio todos');
                    break;
                case 'ack_seen': case 'ack_seen_all': break;
                case 'error':
                    addSystemMessage('\u26A0 ' + (msg.error || 'Error'));
                    break;
            }
        });

        ws.addEventListener('close', () => {
            isConnected = false;
            updateConnectionUI(false);
            addSystemMessage('Conexion cerrada');
            scheduleReconnect();
        });

        ws.addEventListener('error', () => {
            isConnected = false;
            updateConnectionUI(false);
        });
    }

    function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
        reconnectAttempts++;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (sessionPassword && userId) connectWebSocket();
        }, delay);
    }

    function updateConnectionUI(connected) {
        const el = dom().connStatus;
        if (connected) {
            el.textContent = '\u25CF Conectado';
            el.className = 'ghost-connection connected';
        } else {
            el.textContent = '\u25CF Desconectado';
            el.className = 'ghost-connection disconnected';
        }
    }

    // ── Incoming Message (decrypt) ─────────────────────────

    async function handleIncomingMessage(chatMsg) {
        // chatMsg = { id, from, to, content, mediaType, timestamp }
        let decrypted;
        try {
            decrypted = await CryptoBrowser.decryptWithPassword(chatMsg.content, sessionPassword);
        } catch {
            decrypted = null;
        }

        const label = chatMsg.from === userId ? 'sent' : 'received';
        const mediaType = chatMsg.mediaType || 'text';

        if (!decrypted) {
            addMessage('Ruido ilegible', 'text', label, chatMsg);
        } else {
            addMessage(decrypted, mediaType, label, chatMsg);
        }

        // Auto-seen for received → instant Redis DEL
        if (label === 'received' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'seen', messageId: chatMsg.id }));
        }
    }

    // ── Send Text ──────────────────────────────────────────

    async function handleSend() {
        const d = dom();
        const text = d.input.value.trim();
        if (!text || !sessionPassword || !userId) return;

        const to = getRecipient();
        if (!to) return;

        d.input.value = '';

        try {
            const encrypted = await CryptoBrowser.encryptWithPassword(text, sessionPassword);
            sendToServer(encrypted, 'text');
            addMessage(text, 'text', 'sent', null);
        } catch {
            addSystemMessage('\u26A0 Error de cifrado');
        }
    }

    // ── Send Media (image / audio) ─────────────────────────

    async function handlePhotoSelected(e) {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = '';

        if (file.size > MAX_MEDIA_BYTES) {
            addSystemMessage('\u26A0 Archivo muy grande (max 5MB)');
            return;
        }

        const to = getRecipient();
        if (!to) return;

        try {
            const base64 = await fileToBase64(file);
            const encrypted = await CryptoBrowser.encryptWithPassword(base64, sessionPassword);
            sendToServer(encrypted, 'image');
            addMessage(base64, 'image', 'sent', null);
        } catch {
            addSystemMessage('\u26A0 Error cifrando imagen');
        }
    }

    async function startRecording() {
        if (isRecording) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            audioChunks = [];
            mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
            mediaRecorder.start();
            isRecording = true;
            dom().micBtn.classList.add('recording');
        } catch {
            addSystemMessage('\u26A0 No se pudo acceder al microfono');
        }
    }

    async function stopRecording() {
        if (!isRecording || !mediaRecorder) return;
        isRecording = false;
        dom().micBtn.classList.remove('recording');

        mediaRecorder.stop();
        mediaRecorder.onstop = async () => {
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            if (blob.size > MAX_MEDIA_BYTES) {
                addSystemMessage('\u26A0 Audio muy largo (max 5MB)');
                return;
            }

            const to = getRecipient();
            if (!to) return;

            try {
                const base64 = await blobToBase64(blob);
                const encrypted = await CryptoBrowser.encryptWithPassword(base64, sessionPassword);
                sendToServer(encrypted, 'audio');
                addMessage(base64, 'audio', 'sent', null);
            } catch {
                addSystemMessage('\u26A0 Error cifrando audio');
            }

            // Stop mic tracks
            mediaRecorder.stream.getTracks().forEach((t) => t.stop());
            mediaRecorder = null;
            audioChunks = [];
        };
    }

    // ── Send Helper ────────────────────────────────────────

    function sendToServer(encryptedContent, mediaType) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addSystemMessage('\u26A0 Sin conexion');
            return;
        }
        ws.send(JSON.stringify({
            type: 'send_message',
            to: recipientId,
            content: encryptedContent,
            mediaType,
        }));
    }

    function getRecipient() {
        const d = dom();
        const to = (d.recipientInput && d.recipientInput.value.trim()) || recipientId || null;
        if (!to) {
            addSystemMessage('\u26A0 Indica un destinatario');
            return null;
        }
        recipientId = to;
        return to;
    }

    // ── File / Blob to Base64 ──────────────────────────────

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // ── Render Messages ────────────────────────────────────

    function addMessage(content, mediaType, type, chatMsg) {
        const d = dom();
        const el = document.createElement('div');
        el.className = `ghost-msg ${type}`;

        const time = chatMsg
            ? new Date(chatMsg.timestamp).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const fromLabel = (type === 'received' && chatMsg)
            ? `<span class="ghost-msg-from">${escapeHtml(chatMsg.from)}</span>`
            : '';

        let body = '';

        if (mediaType === 'image') {
            // Tap-to-View: blurred by default, visible only while holding
            body = `
                <div class="tap-to-view" data-media="image">
                    <img src="${content}" class="ghost-media-img" draggable="false" />
                    <div class="tap-overlay"><span>Mantener para ver</span></div>
                </div>`;
        } else if (mediaType === 'audio') {
            // Tap-to-View: audio plays only while holding
            body = `
                <div class="tap-to-view" data-media="audio">
                    <div class="ghost-audio-icon">&#127911;</div>
                    <div class="ghost-audio-label">Nota de voz</div>
                    <div class="tap-overlay"><span>Mantener para escuchar</span></div>
                    <audio preload="auto"><source src="${content}" type="audio/webm"></audio>
                </div>`;
        } else {
            body = `<div>${escapeHtml(content)}</div>`;
        }

        el.innerHTML = `${fromLabel}${body}<div class="ghost-msg-time">${time}</div>`;

        d.messages.appendChild(el);
        d.messages.scrollTop = d.messages.scrollHeight;

        // Bind tap-to-view events
        const tapEl = el.querySelector('.tap-to-view');
        if (tapEl) bindTapToView(tapEl);

        if (type === 'received') {
            observeEphemeral(el);
        }
    }

    function addSystemMessage(text) {
        const d = dom();
        const el = document.createElement('div');
        el.className = 'ghost-msg system';
        el.textContent = text;
        d.messages.appendChild(el);
        d.messages.scrollTop = d.messages.scrollHeight;
    }

    // ── Tap-to-View ────────────────────────────────────────

    function bindTapToView(el) {
        const mediaType = el.dataset.media;
        const overlay = el.querySelector('.tap-overlay');
        const audio = el.querySelector('audio');

        function reveal() {
            el.classList.add('revealed');
            if (mediaType === 'audio' && audio) {
                audio.currentTime = 0;
                audio.play().catch(() => {});
            }
        }

        function conceal() {
            el.classList.remove('revealed');
            if (mediaType === 'audio' && audio) {
                audio.pause();
                audio.currentTime = 0;
            }
        }

        // Mouse events
        el.addEventListener('mousedown', reveal);
        el.addEventListener('mouseup', conceal);
        el.addEventListener('mouseleave', conceal);

        // Touch events
        el.addEventListener('touchstart', (e) => { e.preventDefault(); reveal(); });
        el.addEventListener('touchend', (e) => { e.preventDefault(); conceal(); });
        el.addEventListener('touchcancel', conceal);
    }

    // ── Ephemeral Self-Destruct ────────────────────────────

    const ephemeralObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const el = entry.target;
                ephemeralObserver.unobserve(el);
                setTimeout(() => {
                    el.classList.add('ephemeral-fade');
                    setTimeout(() => { el.remove(); }, EPHEMERAL_FADE_MS);
                }, EPHEMERAL_DELAY_MS);
            }
        });
    }, { threshold: VISIBILITY_THRESHOLD });

    function observeEphemeral(el) {
        ephemeralObserver.observe(el);
    }

    // ── Anti-Leak Watermark ────────────────────────────────

    function startWatermark() {
        if (watermarkEl) return;

        watermarkEl = document.createElement('div');
        watermarkEl.className = 'ghost-watermark';
        watermarkEl.textContent = userId || '?';
        document.getElementById('ghost-mode').appendChild(watermarkEl);

        let x = Math.random() * 60 + 10;
        let y = Math.random() * 60 + 10;
        let dx = 0.3 + Math.random() * 0.4;
        let dy = 0.2 + Math.random() * 0.3;

        function animate() {
            x += dx;
            y += dy;
            if (x > 85 || x < 5) dx = -dx;
            if (y > 85 || y < 5) dy = -dy;
            watermarkEl.style.left = x + '%';
            watermarkEl.style.top = y + '%';
            watermarkAnimId = requestAnimationFrame(animate);
        }
        animate();
    }

    function stopWatermark() {
        if (watermarkAnimId) cancelAnimationFrame(watermarkAnimId);
        if (watermarkEl) { watermarkEl.remove(); watermarkEl = null; }
        watermarkAnimId = null;
    }

    // ── Helpers ────────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Activate / Deactivate ──────────────────────────────

    function activate() {
        const d = dom();
        d.ghostMode.classList.add('active');

        if (!sessionPassword) {
            d.passwordModal.classList.add('active');
            setTimeout(() => d.aliasInput.focus(), 400);
        } else {
            d.input.focus();
            startWatermark();
        }
    }

    function deactivate() {
        document.getElementById('ghost-mode').classList.remove('active');
        stopWatermark();
    }

    function destroy() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { ws.close(); ws = null; }
        stopWatermark();
        sessionPassword = null;
        userId = null;
        recipientId = null;
        isConnected = false;
        reconnectAttempts = 0;

        const d = dom();
        const msgs = d.messages.querySelectorAll('.ghost-msg:not(.system)');
        msgs.forEach((m) => m.remove());
        deactivate();
    }

    // ── Public API ─────────────────────────────────────────

    return { init, activate, deactivate, destroy };
})();
