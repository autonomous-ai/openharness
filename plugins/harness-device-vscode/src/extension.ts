// The only file that loads `vscode`: the rest takes the API by its shape.
import * as vscode from 'vscode'
import { nodeInputs } from './inputs'
import type { VscodeApi } from './vscodeApi'
import { wire } from './wire'

// Typed so the typecheck spec fails when the shape the tests' fake stands for is not VS Code 1.75's.
const api: VscodeApi = vscode
let stop: (() => Promise<void>) | undefined

export function activate(): void {
  stop = wire(api, nodeInputs())
}

export async function deactivate(): Promise<void> {
  await stop?.()
  stop = undefined
}
