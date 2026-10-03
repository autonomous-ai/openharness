/** Internal worker contract. External transports must bind user/session authority before using it. */
import type { CodingMemoryStore } from './store.js'
import type { MemoryQueue } from './queue.js'

export type MemoryOperations = Pick<CodingMemoryStore,
  'controls' | 'setControls' | 'preferences' | 'setPreferences' | 'changePreferences' | 'maintain' | 'registerProject' | 'projectForLocator' | 'linkProjectLocator' | 'setProjectIncluded'
  | 'sessionPolicy' | 'setSessionIncluded' | 'capturePolicy'
  | 'ingest' | 'source' | 'propose' | 'revise' | 'correctFromUser' | 'read' | 'history' | 'support' | 'list' | 'recall'
  | 'libraryPage' | 'libraryProjects' | 'libraryActivity' | 'libraryDetail' | 'libraryCorrect' | 'libraryForget' | 'libraryPreview' | 'libraryApply'
  | 'notebookPending' | 'notebookClaim' | 'notebookFinish' | 'notebookDefer' | 'libraryNotebooks' | 'libraryNotebook'
  | 'prepareRecall' | 'recallEmitted' | 'recallReceipts' | 'putTopic' | 'topic' | 'forget'>
  & Pick<MemoryQueue, 'capture' | 'checkpoint' | 'pendingReview' | 'waitingForModel' | 'claim' | 'finish' | 'defer' | 'cursor' | 'episodeOpen' | 'status'>
export type Operation = keyof MemoryOperations
export type Arguments<K extends Operation> = Parameters<MemoryOperations[K]>
export type Result<K extends Operation> = ReturnType<MemoryOperations[K]>
export type MemoryPort = { request<K extends Operation>(operation: K, args: Arguments<K>, timeoutMs?: number): Promise<Result<K>> }

export const STORE_OPERATIONS = ['controls', 'setControls', 'preferences', 'setPreferences', 'changePreferences', 'maintain', 'registerProject', 'projectForLocator', 'linkProjectLocator', 'setProjectIncluded',
  'sessionPolicy', 'setSessionIncluded', 'capturePolicy',
  'ingest', 'source', 'propose', 'revise', 'correctFromUser', 'read', 'history', 'support', 'list', 'recall',
  'libraryPage', 'libraryProjects', 'libraryActivity', 'libraryDetail', 'libraryCorrect', 'libraryForget', 'libraryPreview', 'libraryApply',
  'notebookPending', 'notebookClaim', 'notebookFinish', 'notebookDefer', 'libraryNotebooks', 'libraryNotebook',
  'prepareRecall', 'recallEmitted', 'recallReceipts', 'putTopic', 'topic', 'forget'] as const
export const QUEUE_OPERATIONS = ['capture', 'checkpoint', 'pendingReview', 'waitingForModel', 'claim', 'finish', 'defer', 'cursor', 'episodeOpen', 'status'] as const
