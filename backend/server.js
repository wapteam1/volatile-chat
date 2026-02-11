const http = require("http");
const path = require("path");
const express = require("express");
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

redis.on("connect", () => { /* connected */ });
redis.on("error", () => { /* silent */ });

// ─── Mapa de usuarios conectados: userId → WebSocket ─────────────────
const clients = new Map();

// ─── Express + Static Files ──────────────────────────────────────────
const app = express();
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR, {
    maxAge: "1h",
    etag: true,
    lastModified: true,
}));

// ─── HTTP + WebSocket Server ─────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, maxPayload: 5 * 1024 * 1024 }); // 5MB max

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
                // user registered

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
                    mediaType: msg.mediaType || 'text', // 'text' | 'image' | 'audio'
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

                // No logging of message content — evidence-free zone
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

                    // seen event processed — no log
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

                // seen_all event processed — no log
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
            // client disconnected
        }
    });

    ws.on("error", () => { /* silent */ });
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
        // pending messages delivered — no log
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
                // LREM + immediate pipeline for instant RAM release
                const pipeline = redis.pipeline();
                pipeline.lrem(redisKey, 1, raw);
                await pipeline.exec();
                return parsed;
            }
        } catch { }
    }
    return null;
}

// ─── Catch-all: sirve index.html para cualquier ruta no definida ─────
app.get("*", (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ─── Start ───────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
    console.log("Búnker Wapnation cargado en puerto " + PORT);
});
