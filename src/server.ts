/**
 * VAOS Voice Bridge — Talker-Reasoner coordination service.
 *
 * Implements "Agents Thinking Fast and Slow" (arXiv:2410.08328):
 *   Talker (System 1) = PersonaPlex (fast, intuitive voice)
 *   Reasoner (System 2) = Letta agent + Claude (slow, deliberate reasoning)
 *   Bridge = this service (coordination, routing, belief management)
 *
 * Endpoints:
 *   GET  /health                — Health check
 *   POST /api/v1/speak          — TTS: text → PersonaPlex → WAV (used by voice executor)
 *   GET  /api/v1/belief         — Current belief state
 *   POST /api/v1/reason         — Send text to Reasoner, get response
 *   POST /api/v1/reason-and-speak — Reason + TTS combined
 *   GET  /api/v1/session/config — Session configuration
 *   WS   /api/v1/session        — Live voice session (proxy to PersonaPlex)
 */

import { Hono } from 'hono';
import { createLogger } from './logger.js';
import { getConfig } from './config.js';
import { Reasoner } from './reasoner.js';
import { PersonaplexTTS } from './tts.js';
import { beliefToPrompt, type BeliefState } from './belief.js';
import { route, detectComplexity } from './coordinator.js';
import {
  connectToPersonaplex,
  sendAudio,
  flushTranscript,
  MSG,
  type TalkerSession,
} from './talker.js';
import type { ServerWebSocket } from 'bun';

const logger = createLogger('voice-bridge');
const config = getConfig();
const reasoner = new Reasoner(config);
const tts = new PersonaplexTTS(config);

// ── Per-session state stored in ws.data ──────────────────────
interface SessionData {
  sessionId: string;
  voice: string;
  talker: TalkerSession | null;
  turnTimer: ReturnType<typeof setTimeout> | null;
  talkerTranscript: string[];  // PersonaPlex text tokens (what the AI said)
  connected: boolean;
}

/** Turn silence threshold: flush transcript after this many ms of no new text tokens */
const TURN_SILENCE_MS = 2500;

/** Active WebSocket sessions — receives belief change notifications */
const activeSessions = new Set<ServerWebSocket<SessionData>>();

/** Send belief update metadata to all active sessions */
function broadcastBeliefUpdate(belief: BeliefState): void {
  const meta = JSON.stringify({
    type: 'belief_update',
    phase: belief.conversation.phase,
    topic: belief.conversation.topic,
    goals: belief.userModel.goals,
    project: belief.userModel.currentProject,
    pendingActions: belief.pendingActions.length,
    prompt: beliefToPrompt(belief),
  });
  const metaBuf = Buffer.from(meta, 'utf-8');
  const msg = Buffer.alloc(1 + metaBuf.length);
  msg[0] = MSG.METADATA;
  metaBuf.copy(msg, 1);

  for (const ws of activeSessions) {
    if (ws.readyState === 1) {
      ws.sendBinary(msg);
    }
  }
}

// Wire up belief change listener
reasoner.onBeliefChange(broadcastBeliefUpdate);

const app = new Hono();

// ── Health ───────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'vaos-voice-bridge', version: '1.0.0' }),
);

// ── Speak (TTS) ──────────────────────────────────────────────
app.post('/api/v1/speak', async (c) => {
  const body = await c.req.json<{ text: string; voice?: string; session_id?: string }>();

  if (!body.text) {
    return c.json({ error: 'text is required' }, 400);
  }

  logger.info({ text: body.text.slice(0, 80), voice: body.voice }, 'Speak request');

  try {
    const wav = await tts.speak(body.text, body.voice);
    return new Response(wav, {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Speak failed');
    return c.json({ error: 'TTS synthesis failed' }, 500);
  }
});

// ── Belief State ─────────────────────────────────────────────
app.get('/api/v1/belief', (c) => {
  return c.json(reasoner.getBelief());
});

// ── Reason (System 2 direct) ─────────────────────────────────
app.post('/api/v1/reason', async (c) => {
  const body = await c.req.json<{ text: string }>();

  if (!body.text) {
    return c.json({ error: 'text is required' }, 400);
  }

  const mode = route(body.text, reasoner.getBelief(), config.routing.complexityThreshold);
  logger.info({ text: body.text.slice(0, 80), mode }, 'Reason request');

  if (mode === 'direct') {
    return c.json({
      mode: 'direct',
      message: 'Query is simple enough for System 1 (Talker). No Reasoner needed.',
      complexity: detectComplexity(body.text),
    });
  }

  const response = await reasoner.processAndRespond(body.text);
  return c.json({
    mode: 'agent',
    response,
    belief: reasoner.getBelief(),
  });
});

// ── Reason + Speak (combined) ────────────────────────────────
app.post('/api/v1/reason-and-speak', async (c) => {
  const body = await c.req.json<{ text: string; voice?: string }>();

  if (!body.text) {
    return c.json({ error: 'text is required' }, 400);
  }

  logger.info({ text: body.text.slice(0, 80) }, 'Reason-and-speak request');

  const response = await reasoner.processAndRespond(body.text);
  const wav = await tts.speak(response, body.voice);

  return new Response(wav, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      'X-Reasoner-Response': encodeURIComponent(response),
    },
  });
});

// ── Live Session Info ────────────────────────────────────────
app.get('/api/v1/session/config', (c) => {
  const belief = reasoner.getBelief();
  const prompt = beliefToPrompt(belief);
  return c.json({
    personaplexUrl: config.personaplex.wsUrl,
    textPrompt: prompt,
    defaultVoice: config.personaplex.defaultVoice,
    belief,
  });
});

// ── WebSocket Session Handlers ───────────────────────────────

/**
 * Called when a client WebSocket opens.
 * Connects to PersonaPlex and wires up bidirectional proxying.
 */
async function handleSessionOpen(ws: ServerWebSocket<SessionData>) {
  const data = ws.data;
  logger.info({ sessionId: data.sessionId, voice: data.voice }, 'Session opened — connecting to PersonaPlex');

  try {
    const belief = reasoner.getBelief();
    const textPrompt = beliefToPrompt(belief);
    const talker = await connectToPersonaplex(config, textPrompt, data.voice);
    data.talker = talker;
    data.connected = true;

    // Forward PersonaPlex audio → client
    talker.onAudio = (audioData: Buffer) => {
      if (ws.readyState === 1) {
        // Send as binary with 0x01 audio type prefix
        const msg = Buffer.alloc(1 + audioData.length);
        msg[0] = MSG.AUDIO;
        audioData.copy(msg, 1);
        ws.sendBinary(msg);
      }
    };

    // Forward PersonaPlex text tokens → client AND accumulate for Reasoner
    talker.onText = (token: string) => {
      // Forward text token to client (0x02 prefix)
      if (ws.readyState === 1) {
        const tokenBuf = Buffer.from(token, 'utf-8');
        const msg = Buffer.alloc(1 + tokenBuf.length);
        msg[0] = MSG.TEXT;
        tokenBuf.copy(msg, 1);
        ws.sendBinary(msg);
      }

      // Accumulate for turn detection
      data.talkerTranscript.push(token);

      // Reset turn timer — after TURN_SILENCE_MS of no tokens, flush to Reasoner
      if (data.turnTimer) clearTimeout(data.turnTimer);
      data.turnTimer = setTimeout(() => onTurnEnd(ws), TURN_SILENCE_MS);
    };

    // Handle PersonaPlex disconnect
    talker.onClose = () => {
      data.connected = false;
      logger.info({ sessionId: data.sessionId }, 'PersonaPlex disconnected');
      if (ws.readyState === 1) {
        // Send error message to client
        const errBuf = Buffer.from('PersonaPlex disconnected', 'utf-8');
        const msg = Buffer.alloc(1 + errBuf.length);
        msg[0] = MSG.ERROR;
        errBuf.copy(msg, 1);
        ws.sendBinary(msg);
        ws.close(1000, 'PersonaPlex disconnected');
      }
    };

    // Track active session for belief broadcasts
    activeSessions.add(ws);

    // Send handshake to client to signal ready
    ws.sendBinary(new Uint8Array([MSG.HANDSHAKE]));
    logger.info({ sessionId: data.sessionId }, 'Session active — PersonaPlex connected');

  } catch (err) {
    logger.error({ err, sessionId: data.sessionId }, 'Failed to connect to PersonaPlex');
    if (ws.readyState === 1) {
      const errBuf = Buffer.from('Failed to connect to PersonaPlex', 'utf-8');
      const msg = Buffer.alloc(1 + errBuf.length);
      msg[0] = MSG.ERROR;
      errBuf.copy(msg, 1);
      ws.sendBinary(msg);
      ws.close(1011, 'PersonaPlex connection failed');
    }
  }
}

/**
 * Called when the client sends a binary message.
 * Routes audio to PersonaPlex, handles control messages.
 */
function handleSessionMessage(ws: ServerWebSocket<SessionData>, raw: Buffer | ArrayBuffer) {
  const data = ws.data;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  if (buf.length === 0 || !data.talker || !data.connected) return;

  const msgType = buf[0];

  switch (msgType) {
    case MSG.AUDIO:
      // Forward client audio → PersonaPlex
      sendAudio(data.talker, buf.subarray(1));
      break;

    case MSG.CONTROL:
      // Forward control messages → PersonaPlex
      if (data.talker.connected && data.talker.ws.readyState === 1) {
        data.talker.ws.send(buf);
      }
      break;

    case MSG.PING:
      // Echo pong to client
      ws.sendBinary(buf);
      break;

    default:
      logger.debug({ sessionId: data.sessionId, msgType, size: buf.length }, 'Unknown client message type');
  }
}

/**
 * Called when a conversation turn ends (no text tokens for TURN_SILENCE_MS).
 * Flushes the accumulated transcript and sends to Reasoner (async, non-blocking).
 */
function onTurnEnd(ws: ServerWebSocket<SessionData>) {
  const data = ws.data;
  const transcript = data.talkerTranscript.join('').trim();
  data.talkerTranscript = [];

  if (!transcript) return;

  logger.info({ sessionId: data.sessionId, transcript: transcript.slice(0, 100) }, 'Turn ended — sending to Reasoner');

  // Send metadata to client with the detected transcript
  if (ws.readyState === 1) {
    const meta = JSON.stringify({ type: 'turn_transcript', text: transcript });
    const metaBuf = Buffer.from(meta, 'utf-8');
    const msg = Buffer.alloc(1 + metaBuf.length);
    msg[0] = MSG.METADATA;
    metaBuf.copy(msg, 1);
    ws.sendBinary(msg);
  }

  // Async belief update (non-blocking — System 1 path)
  reasoner.updateBelief(transcript, '').catch((err) => {
    logger.error({ err, sessionId: data.sessionId }, 'Async belief update failed');
  });
}

/**
 * Called when the client WebSocket closes.
 * Tears down the PersonaPlex connection.
 */
function handleSessionClose(ws: ServerWebSocket<SessionData>) {
  const data = ws.data;
  logger.info({ sessionId: data.sessionId }, 'Session closed');

  activeSessions.delete(ws);
  if (data.turnTimer) clearTimeout(data.turnTimer);

  // Flush any remaining transcript to Reasoner
  const transcript = data.talkerTranscript.join('').trim();
  if (transcript) {
    reasoner.updateBelief(transcript, '').catch(() => {});
  }

  // Close PersonaPlex connection
  if (data.talker?.ws?.readyState === 1) {
    data.talker.ws.close();
  }
  data.talker = null;
  data.connected = false;
}

// ── Startup ──────────────────────────────────────────────────
async function start() {
  logger.info({ port: config.port }, 'Starting Voice Bridge');

  await reasoner.init();

  try {
    await tts.init();
  } catch (err) {
    logger.warn({ err }, 'TTS init failed — speak endpoint will init on first use');
  }

  const server = Bun.serve({
    fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade for /api/v1/session
      if (url.pathname === '/api/v1/session') {
        const voice = url.searchParams.get('voice') || config.personaplex.defaultVoice;
        const sessionId = crypto.randomUUID().slice(0, 8);

        const upgraded = server.upgrade<SessionData>(req, {
          data: {
            sessionId,
            voice,
            talker: null,
            turnTimer: null,
            talkerTranscript: [],
            connected: false,
          },
        });

        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // All other routes → Hono
      return app.fetch(req);
    },
    port: config.port,
    websocket: {
      open(ws: ServerWebSocket<SessionData>) {
        handleSessionOpen(ws);
      },
      message(ws: ServerWebSocket<SessionData>, msg: string | Buffer) {
        handleSessionMessage(ws, msg as Buffer);
      },
      close(ws: ServerWebSocket<SessionData>) {
        handleSessionClose(ws);
      },
    },
  });

  // Periodic Letta memory sync — keeps belief fresh during active sessions
  const SYNC_INTERVAL_MS = 30_000;
  setInterval(async () => {
    if (activeSessions.size === 0) return;
    try {
      await reasoner.syncBeliefFromLetta();
    } catch {
      // Non-critical — belief sync is best-effort
    }
  }, SYNC_INTERVAL_MS);

  logger.info({ port: server.port }, 'Voice Bridge listening');
  logger.info({
    personaplex: `${config.personaplex.host}:${config.personaplex.port}`,
    letta: config.letta.baseUrl,
    reasonerAgent: config.letta.agentName,
    wsSession: `ws://localhost:${config.port}/api/v1/session`,
  }, 'Connected services');
}

if (import.meta.main) {
  start().catch((err) => {
    logger.fatal({ err }, 'Voice Bridge failed to start');
    process.exit(1);
  });
}

export { app };
