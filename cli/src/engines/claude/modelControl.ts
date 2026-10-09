/** Claude Code's model/effort commands. Core supplies one operation's guarded host. */
import { parseRuntimeProfile } from '../../lib/runtimeProfileWire.js'
import { stripAnsi } from '../kit/pane.js'
import { RuntimeProfileControlError, type EngineModelControl, type ModelControlHost, type ModelControlInput } from '../facets/modelControl.js'
import type { RuntimeProfile } from '../facets/runtime.js'
const COMMAND_CONFIRM_MS = 8_000

export const modelControl: EngineModelControl = {
  async validate() {},
  apply: (input, host) => new ClaudeModelControl(host).apply(input),
}

class ClaudeModelControl {
  constructor(private readonly host: ModelControlHost) {}
  async apply({ target, current, options }: ModelControlInput): Promise<void> {
    await this.setClaude(target, current, options)
  }

  private async setClaude(
    target: RuntimeProfile,
    current: RuntimeProfile | null,
    options: Array<{ id: string }>,
  ): Promise<void> {
    if (current?.model !== target.model) {
      if (!await this.host.text(`/model ${target.model}`)) {
        throw new RuntimeProfileControlError('TMUX_FAILED')
      }
      if (!await this.waitClaudeModel()) throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
    }

    if (current?.effort === target.effort) {
      await this.host.confirmEffort(target.effort)
      return
    }

    const hasExplicitEffort = options.some((option) => {
      const profile = parseRuntimeProfile(option.id)
      return profile?.model === target.model && profile.effort !== 'auto'
    })
    if (!hasExplicitEffort && target.effort === 'auto') {
      await this.host.confirmEffort('auto')
      return
    }
    if (!await this.host.text(`/effort ${target.effort}`)) {
      throw new RuntimeProfileControlError('TMUX_FAILED')
    }
    if (!await this.host.waitForProfile(COMMAND_CONFIRM_MS)) {
      await this.host.key('Enter')
      if (!await this.host.waitForProfile(2_000)) {
        throw new RuntimeProfileControlError('CONFIRM_TIMEOUT')
      }
    }
  }

  private async waitClaudeModel(): Promise<boolean> {
    if (await this.host.waitForModel(1_200)) return true
    const capture = await this.host.capture(80)
    if (capture && /switch model|change model|continue.*model|re-read.*history/i.test(stripAnsi(capture))) {
      await this.host.key('Enter')
    } else {
      // Claude and Codex can swallow the first Enter immediately after a terminal literal write.
      await this.host.key('Enter')
    }
    return this.host.waitForModel(COMMAND_CONFIRM_MS)
  }
}
