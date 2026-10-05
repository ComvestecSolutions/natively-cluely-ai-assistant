import React from 'react';
import { createRoot } from 'react-dom/client';

type Listener = (...args: any[]) => void;
const listeners = new Map<string, Set<Listener>>();
const calls: { questions: Array<{ text: string; context: string }>; resets: number; cancels: number } = {
  questions: [], resets: 0, cancels: 0,
};
const api = new Proxy({
  platform: new URLSearchParams(location.search).get('platform') ?? 'win32',
  getKeybinds: async () => [{ id: 'general:reset-cancel', accelerator: 'CommandOrControl+R' }],
  getGlobalShortcutsEnabled: async () => true,
  getKeybindRegistrationFailures: async () => [],
  getDirectAssistEnabled: async () => false,
  getCurrentLlmConfig: async () => ({ provider: 'test', modelId: 'gemini-3-flash-preview' }),
  getDefaultModel: async () => ({ model: 'gemini-3-flash-preview' }),
  getSettingsPopupState: async () => ({ isVisible: false }),
  streamGeminiChat: async (text: string, _images: unknown, context: string) => {
    calls.questions.push({ text, context });
  },
  cancelChatStream: () => { calls.cancels++; },
  resetIntelligence: async () => {
    calls.resets++;
    for (const listener of listeners.get('onSessionReset') ?? []) listener();
    return { success: true };
  },
}, {
  get(target, name: string) {
    if (name in target) return target[name as keyof typeof target];
    if (name.startsWith('on')) return (listener: Listener) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => listeners.get(name)?.delete(listener);
    };
    return async () => ({});
  },
});
(window as any).electronAPI = api;
(window as any).__resetHarness = { calls, emit: (name: string, ...args: any[]) => {
  for (const listener of listeners.get(name) ?? []) listener(...args);
} };

// Import AFTER the preload stand-in: platformUtils resolves CommandOrControl at module evaluation.
import('../NativelyInterface').then(({ default: NativelyInterface }) => {
  createRoot(document.getElementById('root')!).render(<NativelyInterface />);
  (window as any).__resetHarness.mounted = true;
}).catch(error => {
  (window as any).__resetHarness.error = String(error?.stack ?? error);
});
