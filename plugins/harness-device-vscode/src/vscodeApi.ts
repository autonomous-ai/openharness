// What the extension reads of VS Code, by shape: the real module satisfies it (extension.ts), and tests pass a fake, so
// nothing but the extension host has to load `vscode`.

export interface Disposable { dispose(): void }

export interface ApiTerminal { readonly processId: PromiseLike<number | undefined>; show(preserveFocus?: boolean): void }

export interface VscodeApi {
  env: { readonly remoteName: string | undefined }
  commands: { executeCommand(command: string): PromiseLike<unknown> }
  window: {
    readonly terminals: readonly ApiTerminal[]
    readonly activeTerminal: ApiTerminal | undefined
    readonly state: { readonly focused: boolean }
    onDidOpenTerminal(listener: (terminal: ApiTerminal) => void): Disposable
    onDidCloseTerminal(listener: (terminal: ApiTerminal) => void): Disposable
    onDidChangeActiveTerminal(listener: (terminal: ApiTerminal | undefined) => void): Disposable
    onDidChangeWindowState(listener: (state: { readonly focused: boolean }) => void): Disposable
    createOutputChannel(name: string): { appendLine(line: string): void; dispose(): void }
  }
}
