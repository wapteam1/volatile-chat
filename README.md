# Volatile Chat 💬

Sistema de chat efímero con **Redis en modo volátil** (sin persistencia a disco) y backend **Node.js + WebSocket**.

Los mensajes se almacenan solo en memoria y se **borran inmediatamente** cuando el receptor los marca como "vistos".

## Arquitectura

```
┌─────────────┐     WebSocket     ┌─────────────┐     Redis Lists     ┌─────────────┐
│  Cliente A  │◄──────────────────►│   Node.js   │◄────────────────────►│    Redis    │
│  Cliente B  │◄──────────────────►│   Backend   │   chat:{userId}     │  (volátil)  │
└─────────────┘                   └─────────────┘                     └─────────────┘
```

## Ejecución

```bash
docker compose up --build
```

El servidor WebSocket estará disponible en `ws://localhost:3000`.

## Protocolo WebSocket

| Evento | Payload | Acción |
|---|---|---|
| `register` | `{type, userId}` | Registrar usuario y recibir mensajes pendientes |
| `send_message` | `{type, to, content}` | Enviar mensaje (se guarda en Redis) |
| `seen` | `{type, messageId}` | Marcar como visto → **borrado inmediato de Redis** |
| `seen_all` | `{type}` | Marcar todos como vistos → **borrado masivo** |

## Test rápido con wscat

```bash
# Terminal 1
npx wscat -c ws://localhost:3000
> {"type":"register","userId":"alice"}
> {"type":"send_message","to":"bob","content":"Hola!"}

# Terminal 2
npx wscat -c ws://localhost:3000
> {"type":"register","userId":"bob"}
> {"type":"seen","messageId":"<id>"}
```
