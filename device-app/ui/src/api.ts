// The UI's one door to Rust.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type Screen = 'install' | 'sign_in'
export type Phase = 'offer' | 'working' | 'browser' | 'failed'
export interface View {
  screen: Screen
  phase: Phase
  lines: string[]
}
export type Action = 'retry' | 'sign_in' | 'later' | 'cancel'

export function view(): Promise<View | null> {
  return invoke<View | null>('view')
}

export function act(action: Action): Promise<void> {
  return invoke<void>('act', { action })
}

export function onView(listener: (view: View | null) => void): Promise<() => void> {
  return listen<View | null>('view', (event) => listener(event.payload))
}
