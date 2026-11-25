import type { BackgroundMessage } from './types';
import { log } from './core';

export async function sendToBackground<T = unknown>(message: BackgroundMessage): Promise<T> {
  try {
    const response = await chrome.runtime.sendMessage(message);
    return response as T;
  } catch (err) {
    log.warn('background message failed', message.type, err);
    throw err;
  }
}

export function onBackgroundMessage(
  handler: (
    message: BackgroundMessage,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown> | unknown,
): void {
  chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
    Promise.resolve(handler(message, sender))
      .then((result) => sendResponse(result))
      .catch((err) => {
        log.error('message handler error', message?.type, err);
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  });
}
