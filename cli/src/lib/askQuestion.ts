export { codexRowKeys } from '../engines/codex/questionControl.js'
import { questionControlFor } from '../engines/questionControls.js'
export { isApprovalDialog, parsePermissionPane, parseQuestionPane } from '../engines/kit/questionPane.js'
/** Explicit inline compatibility for direct users and recorded-screen fixtures. */
export * from './questionController.js'
export { parseEngineQuestionPane } from '../engines/screens.js'
import { parseEngineQuestionPane } from '../engines/screens.js'
import { AskQuestionController as Controller, QuestionWatcher as Watcher } from './questionController.js'
import type { AskQuestionDeps, QuestionWatcherDeps, PaneView } from './questionController.js'
const readQuestion: AskQuestionDeps['readQuestion'] = (session, capture) => parseEngineQuestionPane(session.engine ?? 'claude', capture)
export class AskQuestionController extends Controller {
  constructor(deps: Omit<AskQuestionDeps, 'readQuestion' | 'questionControlFor'> & Partial<Pick<AskQuestionDeps, 'readQuestion' | 'questionControlFor'>>) {
    super({ readQuestion, questionControlFor: session => {
      const control = questionControlFor(session.engine ?? 'claude', deps.wait)
      const target = session.agentId || session.sessionId
      return control ? { apply: step => control.apply(step, { text: text => deps.sendText(target, text), key: key => deps.sendKey(target, key) }) } : undefined
    }, ...deps })
  }
}
export class QuestionWatcher extends Watcher {
  constructor(private readonly inlineDeps: Omit<QuestionWatcherDeps, 'readQuestion'> & Partial<Pick<QuestionWatcherDeps, 'readQuestion'>>) { super({ readQuestion, ...inlineDeps }) }
  override notePrompt(sessionId: string, capture: string | null, view?: PaneView): void {
    const session = this.inlineDeps.getSession(sessionId)
    super.notePrompt(sessionId, capture, view === undefined && capture !== null && session ? parseEngineQuestionPane(session.engine ?? 'claude', capture) : view ?? null)
  }
}
