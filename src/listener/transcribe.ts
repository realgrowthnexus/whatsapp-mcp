import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../shared/config.js';
import { paths } from '../shared/paths.js';

const run = promisify(execFile);

export class TranscriptionUnavailable extends Error {}

/**
 * Offline speech-to-text with whisper.cpp. Audio never leaves this computer.
 * Steps: ffmpeg converts the voice note (OGG/Opus) to 16 kHz mono WAV, then
 * whisper-cli turns it into text.
 */
export async function transcribe(audioFile: string, config: Config): Promise<string> {
  const t = config.transcription;
  if (!t.enabled) throw new TranscriptionUnavailable('Transcription is off ("transcription.enabled": false in config.json).');
  if (!t.whisperCli || !fs.existsSync(t.whisperCli)) {
    throw new TranscriptionUnavailable(`whisper-cli not found at "${t.whisperCli}". See README → "Voice note transcription".`);
  }
  if (!t.model || !fs.existsSync(t.model)) {
    throw new TranscriptionUnavailable(`Whisper model not found at "${t.model}". See README → "Voice note transcription".`);
  }
  // ffmpeg-static is optional: if its download failed during install, everything else still works.
  const ffmpeg = await import('ffmpeg-static').then((m) => (m.default as unknown as string | null), () => null);
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    throw new TranscriptionUnavailable('ffmpeg is missing. Run "npm install" again in the whatsapp-mcp folder.');
  }

  fs.mkdirSync(paths.tmp, { recursive: true });
  const base = path.join(paths.tmp, `tx_${process.pid}_${Date.now()}`);
  const wav = `${base}.wav`;
  try {
    await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', audioFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], {
      windowsHide: true,
      timeout: 120_000,
    });
    await run(t.whisperCli, ['-m', t.model, '-f', wav, '-l', t.language || 'auto', '-nt', '-np', '-otxt', '-of', base], {
      windowsHide: true,
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = fs.readFileSync(`${base}.txt`, 'utf8').replace(/\s+/g, ' ').trim();
    return text || '(no speech detected)';
  } finally {
    for (const f of [wav, `${base}.txt`]) fs.rmSync(f, { force: true });
  }
}
