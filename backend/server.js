const http = require("http");
const { WebSocketServer } = require("ws");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");

// ─── Config ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// ─── Redis (volátil, sin persistencia) ───────────────────────────────
const redis = new Redis(REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: null,
});

redis.on("connect", () => console.log("✅ Conectado a Redis (modo volátil)"));
redis.on("error", (err) => console.error("❌ Redis error:", err.message));

// ─── Mapa de usuarios conectados: userId → WebSocket ─────────────────
const clients = new Map();

// ─── HTTP + WebSocket Server ─────────────────────────────────────────
const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", clients: clients.size }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
    let userId = null;

    ws.on("message", async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return ws.send(JSON.stringify({ type: "error", error: "JSON inválido" }));
        }

        switch (msg.type) {
            // ──────────────────────────────────────────────────────────────
            // 1. REGISTER — el cliente se identifica con un userId
            // ──────────────────────────────────────────────────────────────
            case "register": {
                if (!msg.userId) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "userId requerido" })
                    );
                }
                userId = msg.userId;
                clients.set(userId, ws);
                console.log(`👤 Registrado: ${userId}`);

                // Entregar mensajes pendientes que quedaron en Redis
                await deliverPending(userId, ws);
                break;
            }

            // ──────────────────────────────────────────────────────────────
            // 2. SEND_MESSAGE — enviar un mensaje a otro usuario
            //    Payload: { type, to, content }
            // ──────────────────────────────────────────────────────────────
            case "send_message": {
                if (!userId) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "Regístrate primero" })
                    );
                }
                if (!msg.to || !msg.content) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "Campos 'to' y 'content' requeridos" })
                    );
                }

                const chatMessage = {
                    id: uuidv4(),
                    from: userId,
                    to: msg.to,
                    content: msg.content,
                    timestamp: Date.now(),
                };

                // Guardar en Redis bajo la key del destinatario
                const redisKey = `chat:${msg.to}`;
                await redis.rpush(redisKey, JSON.stringify(chatMessage));

                // Confirmar al remitente
                ws.send(
                    JSON.stringify({
                        type: "message_sent",
                        id: chatMessage.id,
                        to: msg.to,
                        timestamp: chatMessage.timestamp,
                    })
                );

                // Si el destinatario está conectado, reenviar en tiempo real
                const recipientWs = clients.get(msg.to);
                if (recipientWs && recipientWs.readyState === 1) {
                    recipientWs.send(
                        JSON.stringify({ type: "new_message", message: chatMessage })
                    );
                }

                console.log(`💬 ${userId} → ${msg.to}: "${msg.content}" [${chatMessage.id}]`);
                break;
            }

            // ──────────────────────────────────────────────────────────────
            // 3. SEEN — el receptor marca un mensaje como visto
            //    Payload: { type, messageId }
            //    Acción: se BORRA inmediatamente de Redis
            // ──────────────────────────────────────────────────────────────
            case "seen": {
                if (!userId) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "Regístrate primero" })
                    );
                }
                if (!msg.messageId) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "messageId requerido" })
                    );
                }

                const deleted = await deleteMessageFromRedis(userId, msg.messageId);

                if (deleted) {
                    // Notificar al remitente original que el mensaje fue visto
                    const originalMessage = deleted;
                    const senderWs = clients.get(originalMessage.from);
                    if (senderWs && senderWs.readyState === 1) {
                        senderWs.send(
                            JSON.stringify({
                                type: "message_seen",
                                messageId: msg.messageId,
                                seenBy: userId,
                                timestamp: Date.now(),
                            })
                        );
                    }

                    // Confirmar al receptor
                    ws.send(
                        JSON.stringify({
                            type: "ack_seen",
                            messageId: msg.messageId,
                            deleted: true,
                        })
                    );

                    console.log(`👁️  ${userId} vio y borró mensaje ${msg.messageId}`);
                } else {
                    ws.send(
                        JSON.stringify({
                            type: "ack_seen",
                            messageId: msg.messageId,
                            deleted: false,
                            reason: "Mensaje no encontrado en la cola",
                        })
                    );
                }
                break;
            }

            // ──────────────────────────────────────────────────────────────
            // 4. SEEN_ALL — marcar TODOS los mensajes pendientes como vistos
            // ──────────────────────────────────────────────────────────────
            case "seen_all": {
                if (!userId) {
                    return ws.send(
                        JSON.stringify({ type: "error", error: "Regístrate primero" })
                    );
                }

                const redisKey = `chat:${userId}`;
                const allRaw = await redis.lrange(redisKey, 0, -1);
                await redis.del(redisKey);

                // Notificar a cada remitente que sus mensajes fueron vistos
                const senders = new Set();
                for (const raw of allRaw) {
                    try {
                        const m = JSON.parse(raw);
                        senders.add(m.from);
                    } catch { }
                }

                for (const senderId of senders) {
                    const senderWs = clients.get(senderId);
                    if (senderWs && senderWs.readyState === 1) {
                        senderWs.send(
                            JSON.stringify({
                                type: "all_messages_seen",
                                seenBy: userId,
                                count: allRaw.length,
                                timestamp: Date.now(),
                            })
                        );
                    }
                }

                ws.send(
                    JSON.stringify({
                        type: "ack_seen_all",
                        deletedCount: allRaw.length,
                    })
                );

                console.log(`👁️  ${userId} vio y borró ${allRaw.length} mensajes pendientes`);
                break;
            }

            default:
                ws.send(
                    JSON.stringify({
                        type: "error",
                        error: `Tipo de mensaje desconocido: ${msg.type}`,
                        validTypes: ["register", "send_message", "seen", "seen_all"],
                    })
                );
        }
    });

    ws.on("close", () => {
        if (userId) {
            clients.delete(userId);
            console.log(`🔌 Desconectado: ${userId}`);
        }
    });

    ws.on("error", (err) => console.error("WS error:", err.message));
});

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Entrega todos los mensajes pendientes almacenados en Redis
 * cuando un usuario se conecta/registra.
 */
async function deliverPending(userId, ws) {
    const redisKey = `chat:${userId}`;
    const pending = await redis.lrange(redisKey, 0, -1);

    if (pending.length > 0) {
        const messages = pending.map((raw) => JSON.parse(raw));
        ws.send(
            JSON.stringify({
                type: "pending_messages",
                messages,
                count: messages.length,
            })
        );
        console.log(`📨 Entregados ${messages.length} mensajes pendientes a ${userId}`);
    }
}

/**
 * Busca un mensaje por ID en la lista Redis del usuario y lo elimina.
 * Retorna el mensaje eliminado o null si no se encontró.
 *
 * Estrategia: recorrer la lista, encontrar el mensaje, usar LREM para borrarlo.
 * Esto es O(n) pero aceptable para colas de mensajes cortas (chat volátil).
 */
async function deleteMessageFromRedis(userId, messageId) {
    const redisKey = `chat:${userId}`;
    const allMessages = await redis.lrange(redisKey, 0, -1);

    for (const raw of allMessages) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed.id === messageId) {
                // LREM elimina la primera ocurrencia exacta del valor
                await redis.lrem(redisKey, 1, raw);
                return parsed;
            }
        } catch { }
    }
    return null;
}

// ─── Start ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`🚀 Chat server escuchando en ws://localhost:${PORT}`);
    console.log(`   Redis: ${REDIS_URL} (modo volátil, sin persistencia)`);
});
