import { ipcCall, IpcError, type ListenerStatus } from '../shared/ipc.js';

export async function listenerStatus(): Promise<ListenerStatus | null> {
  try {
    return await ipcCall<ListenerStatus>('GET', '/status', undefined, 3000);
  } catch (err) {
    if (err instanceof IpcError && (err.code === 'not_running' || err.code === 'timeout')) return null;
    throw err;
  }
}

export function die(message: string, code = 1): never {
  console.error(`❌ ${message}`);
  process.exit(code);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
