import { Message, MessageAction, ScrapingState, ErrorMessage, RunSummary } from '../types';

/**
 * Send a message to the background service worker
 */
export async function sendToBackground<T = any>(
  action: MessageAction,
  data?: any
): Promise<T | undefined> {
  const message: Message = { action, data };
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.error('Error sending message to background:', error);
    throw error;
  }
}

/**
 * Listen for messages from any source
 */
export function onMessage(
  callback: (
    message: Message,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void
  ) => void | boolean | Promise<void>
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = callback(message, sender, sendResponse);

    // If the callback returns a Promise, handle it properly
    if (result instanceof Promise) {
      result
        .then((response) => sendResponse(response))
        .catch((error) => {
          console.error('Error in message handler:', error);
          sendResponse({ error: error.message });
        });
      return true; // Keep the message channel open for async response
    }

    return result;
  });
}

/**
 * Broadcast scraping state update to popup
 */
export function broadcastStateUpdate(state: ScrapingState): void {
  chrome.runtime.sendMessage({
    action: 'SCRAPING_STATUS',
    data: state,
  }).catch(() => {
    // Popup might not be open, which is fine
  });
}

/**
 * Broadcast the enrichment run summary to the popup after any change.
 */
export function broadcastRun(run: RunSummary | null): void {
  chrome.runtime.sendMessage({
    action: 'RUN_UPDATED',
    data: { run },
  }).catch(() => {
    // Popup might not be open, which is fine
  });
}

/**
 * Send error message
 */
export function sendError(error: ErrorMessage): void {
  chrome.runtime.sendMessage({
    action: 'SCRAPING_ERROR',
    data: error,
  }).catch(() => {
    // Popup might not be open, which is fine
  });
}
