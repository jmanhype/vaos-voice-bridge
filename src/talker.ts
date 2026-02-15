/**
 * Talker: PersonaPlex WebSocket client (System 1).
 *
 * Manages the live WebSocket connection to PersonaPlex,
 * extracts text tokens from the binary stream,
 * and provides methods to proxy audio bidirectionally.
 *
 * PersonaPlex binary protocol:
 *   0x00 = handshake
 *   0x01 = audio (Opus)
 *   0x02 = text token
 *   0x03 = control (start/endTurn/pause/restart)
 *   0x04 = metadata (JSON)
 *   0x05 = error
 *   0x06 = ping
 */

import WebSocket from 'ws';
import { createLogger } from './logger.js';
import type { Config } from './config.js';

const logger = createLogger('talker');

export const MSG = {
  HANDSHAKE: 0x00,
  AUDIO: 0x01,
  TEXT: 0x02,
  CONTROL: 0x03,
  METADATA: 0x04,
  ERROR: 0x05,
  PING: 0x06,
} as const;

export interface TalkerSession {
  ws: WebSocket;
  connected: boolean;
  textTokens: string[];
  onText: (token: string) => void;
  onAudio: (data: Buffer) => void;
  onClose: () => void;
}

export function buildPersonaplexUrl(config: Config, textPrompt: string, voice: string): string {
  const params = new URLSearchParams({
    text_prompt: textPrompt,
    voice_prompt: voice,
    text_temperature: '0.7',
    text_topk: '25',
    audio_temperature: '0.8',
    audio_topk: '250',
    pad_mult: '0',
    repetition_penalty: '1.0',
    repetition_penalty_context: '64',
  });
  return `${config.personaplex.wsUrl}?${params.toString()}`;
}

export function connectToPersonaplex(
  config: Config,
  textPrompt: string,
  voice: string,
): Promise<TalkerSession> {
  return new Promise((resolve, reject) => {
    const url = buildPersonaplexUrl(config, textPrompt, voice);
    logger.info({ url: url.slice(0, 120) }, 'Connecting to PersonaPlex');

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    const session: TalkerSession = {
      ws,
      connected: false,
      textTokens: [],
      onText: () => {},
      onAudio: () => {},
      onClose: () => {},
    };

    ws.on('open', () => {
      logger.info('PersonaPlex WebSocket open, waiting for handshake');
    });

    ws.on('message', (raw: ArrayBuffer) => {
      const data = Buffer.from(raw);
      if (data.length === 0) return;

      const msgType = data[0];

      switch (msgType) {
        case MSG.HANDSHAKE:
          session.connected = true;
          logger.info('PersonaPlex handshake received — session active');
          resolve(session);
          break;

        case MSG.AUDIO:
          session.onAudio(data.subarray(1));
          break;

        case MSG.TEXT: {
          const token = data.subarray(1).toString('utf-8').replace(/_/g, ' ');
          if (token && token !== 'PAD' && token !== 'EPAD') {
            session.textTokens.push(token);
            session.onText(token);
          }
          break;
        }

        case MSG.ERROR: {
          const errText = data.subarray(1).toString('utf-8');
          logger.error({ error: errText }, 'PersonaPlex error');
          break;
        }

        case MSG.PING:
          // Echo pong
          ws.send(data);
          break;

        case MSG.METADATA: {
          const meta = data.subarray(1).toString('utf-8');
          logger.debug({ meta }, 'PersonaPlex metadata');
          break;
        }
      }
    });

    ws.on('close', () => {
      session.connected = false;
      logger.info('PersonaPlex connection closed');
      session.onClose();
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'PersonaPlex WebSocket error');
      if (!session.connected) reject(err);
    });

    // Timeout
    setTimeout(() => {
      if (!session.connected) {
        ws.close();
        reject(new Error('PersonaPlex handshake timeout'));
      }
    }, 15000);
  });
}

/** Send audio data to PersonaPlex (prepend 0x01 type byte) */
export function sendAudio(session: TalkerSession, opusData: Buffer): void {
  if (!session.connected || session.ws.readyState !== WebSocket.OPEN) return;
  const msg = Buffer.alloc(1 + opusData.length);
  msg[0] = MSG.AUDIO;
  opusData.copy(msg, 1);
  session.ws.send(msg);
}

/** Send control message to PersonaPlex */
export function sendControl(session: TalkerSession, control: number): void {
  if (!session.connected || session.ws.readyState !== WebSocket.OPEN) return;
  const msg = Buffer.from([MSG.CONTROL, control]);
  session.ws.send(msg);
}

/** Get accumulated transcript and clear buffer */
export function flushTranscript(session: TalkerSession): string {
  const text = session.textTokens.join('').trim();
  session.textTokens = [];
  return text;
}
