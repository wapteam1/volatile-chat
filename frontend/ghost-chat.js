// ─────────────────────────────────────────────────────────────
//  ghost-chat.js
//  WebSocket Ghost Chat — fully wired to volatile-chat backend
//  Protocol: register → send_message → seen (auto-destruct)
//  Encryption: AES-256-GCM via CryptoBrowser (crypto-browser.js)
// ─────────────────────────────────────────────────────────────

const GhostChat = (() => {
    'use strict';

    // ── Configuration ──────────────────────────────────────
    const EPHEMERAL_DELAY_MS = 10_000;
    const EPHEMERAL_FADE_MS = 2_000;
    const VISIBILITY_THRESHOLD = 0.6;
    const RECONNECT_BASE_MS = 1_000;
    const RECONNECT_MAX_MS = 15_000;

    // ── State ──────────────────────────────────────────────
    let ws = null;
    let sessionPassword = null;
    let userId = null;
    let recipientId = null;
    let isConnected = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;

    // ── Resolve WS URL from current page location ──────────
    function buildWsUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}`;
    }

    // ── DOM refs (resolved lazily) ─────────────────────────
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
        addSystemMessage('Sesión cifrada iniciada · clave efímera en memoria');
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
            addSystemMessage('⚠ No se pudo crear la conexión WebSocket');
            updateConnectionUI(false);
            scheduleReconnect();
            return;
        }

        ws.addEventListener('open', () => {
            isConnected = true;
            reconnectAttempts = 0;
            updateConnectionUI(true);

            // Register with the backend
            ws.send(JSON.stringify({ type: 'register', userId }));
            addSystemMessage('Conexión establecida · registrado como ' + userId);
        });

        ws.addEventListener('message', async (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch {
                return;
            }

            switch (msg.type) {
                case 'new_message':
                    await handleIncomingMessage(msg.message);
                    break;

                case 'pending_messages':
                    if (msg.messages && msg.messages.length > 0) {
                        addSystemMessage(`${msg.count} mensaje(s) pendiente(s)`);
                        for (const m of msg.messages) {
                            await handleIncomingMessage(m);
                        }
                    }
                    break;

                case 'message_sent':
                    // Silent confirmation
                    break;

                case 'message_seen':
                    addSystemMessage('\u2713\u2713 Mensaje visto por ' + msg.seenBy);
                    break;

                case 'all_messages_seen':
                    addSystemMessage('\u2713\u2713 ' + msg.seenBy + ' vio todos los mensajes');
                    break;

                case 'ack_seen':
                case 'ack_seen_all':
                    break;

                case 'error':
                    addSystemMessage('\u26A0 ' + (msg.error || 'Error desconocido'));
                    break;
            }
        });

        ws.addEventListener('close', () => {
            isConnected = false;
            updateConnectionUI(false);
            addSystemMessage('Conexión cerrada');
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
        // chatMsg = { id, from, to, content, timestamp }
        let displayText;
        try {
            displayText = await CryptoBrowser.decryptWithPassword(chatMsg.content, sessionPassword);
        } catch {
            displayText = 'Ruido ilegible';
        }

        const label = chatMsg.from === userId ? 'sent' : 'received';
        addMessage(displayText, label, chatMsg);

        // Auto-mark as seen → triggers server-side deletion from Redis
        if (label === 'received' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'seen', messageId: chatMsg.id }));
        }
    }

    // ── Send Message (encrypt) ─────────────────────────────

    async function handleSend() {
        const d = dom();
        const text = d.input.value.trim();
        if (!text || !sessionPassword || !userId) return;

        // Determine recipient — check live input each time
        const to = (d.recipientInput && d.recipientInput.value.trim()) || recipientId || null;
        if (!to) {
            addSystemMessage('\u26A0 Indica un destinatario');
            return;
        }
        recipientId = to;

        d.input.value = '';

        try {
            const encrypted = await CryptoBrowser.encryptWithPassword(text, sessionPassword);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'send_message',
                    to: recipientId,
                    content: encrypted,
                }));
                addMessage(text, 'sent', null);
            } else {
                addSystemMessage('\u26A0 Sin conexión — mensaje no enviado');
            }
        } catch {
            addSystemMessage('\u26A0 Error de cifrado');
        }
    }

    // ── Render Messages ────────────────────────────────────

    function addMessage(text, type, chatMsg) {
        const d = dom();
        const el = document.createElement('div');
        el.className = `ghost-msg ${type}`;

        const time = chatMsg
            ? new Date(chatMsg.timestamp).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const fromLabel = (type === 'received' && chatMsg)
            ? `<span class="ghost-msg-from">${escapeHtml(chatMsg.from)}</span>`
            : '';

        el.innerHTML = `
            ${fromLabel}
            <div>${escapeHtml(text)}</div>
            <div class="ghost-msg-time">${time}</div>
        `;

        d.messages.appendChild(el);
        d.messages.scrollTop = d.messages.scrollHeight;

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
        }
    }

    function deactivate() {
        document.getElementById('ghost-mode').classList.remove('active');
    }

    function destroy() {
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (ws) {
            ws.close();
            ws = null;
        }
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
