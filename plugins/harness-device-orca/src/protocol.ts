// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export type DialAgent = { name: string; app: string }
export type DialState = {
  state: 'checking' | 'noHarness' | 'notRunning' | 'elsewhere' | 'unplugged' | 'attached'
  agent?: DialAgent
}

declare module 'orca' {
  interface PluginRequests { 'dial.get': { output: DialState } }
  interface PluginPanelEvents { 'dial.changed': DialState }
}
