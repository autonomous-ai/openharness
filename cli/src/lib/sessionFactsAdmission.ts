/** Semantic session facts plus opaque, bounded component display values. Native rows never enter this admission. */
import { copySessionValue, type SessionValue, type SessionValueCharge, type SessionValueLimit } from './sessionFactValues.js'
import { SESSION_FACT_FIELDS, type SessionFacts } from './sessionPresentation.js'

type Data = { [key: string]: SessionValue }
const object = (value: SessionValue | undefined): value is Data => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: SessionValue | undefined): value is string => typeof value === 'string'
const nullableText = (value: SessionValue | undefined): boolean => value === null || text(value)
const flag = (value: SessionValue | undefined): boolean => typeof value === 'boolean'
const finite = (value: SessionValue | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const keys = (value: Data, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const maybe = (value: Data, key: string, valid: (item: SessionValue | undefined) => boolean): boolean => !Object.hasOwn(value, key) || valid(value[key])
const fields = new Set<string>(SESSION_FACT_FIELDS)
const optionalText = ['identityHold', 'namedState', 'workspace']
const nullableTexts = ['title', 'lastOpenedAt', 'selectedModel', 'codexHome', 'claudeHome', 'dsh', 'dshName',
  'viewerUrl', 'viewerName', 'parentAgentId', 'permissionMode', 'namedAgent']
const flags = ['nameChosen', 'closeSupported', 'forkable', 'starting']
const displays = ['tokenUsage', 'outputStats', 'grid', 'project', 'verdict']
const displayOverrides = new Set(['project', 'gitContext', 'dsh', 'dshName', 'viewerUrl', 'viewerName', 'verdict'])
const reserved = new Set<string>([...SESSION_FACT_FIELDS.filter(key => key !== 'app' && key !== 'turn' && key !== 'work'),
  'userId', 'agentId', 'frameEpoch', 'gridLaunch'])

function launch(value: SessionValue | undefined): boolean {
  if (!object(value)) return false
  if (value.state === 'ready' || value.state === 'starting') return keys(value, ['state'])
  if (value.state === 'failed') return keys(value, ['state', 'error'], ['detail']) && text(value.error) && maybe(value, 'detail', text)
  return value.state === 'held' && keys(value, ['state', 'service', 'detail']) && text(value.service) && text(value.detail)
}
function activity(value: SessionValue | undefined): boolean {
  return value === null || object(value) && keys(value, ['state', 'epoch', 'revision', 'validForMs'])
    && (value.state === 'working' || value.state === 'idle' || value.state === 'unknown') && text(value.epoch)
    && finite(value.revision) && finite(value.validForMs) && value.validForMs >= 0
}
function turn(value: SessionValue | undefined): boolean {
  return object(value) && keys(value, ['fullText', 'card']) && text(value.fullText)
    && (value.card === null || object(value.card) && keys(value.card, ['recap', 'text']) && text(value.card.recap) && text(value.card.text))
}
function work(value: SessionValue | undefined): boolean {
  return object(value) && keys(value, [], ['text', 'snapshot', 'elapsedSeconds', 'processing'])
    && maybe(value, 'text', text) && maybe(value, 'snapshot', item => item === true)
    && maybe(value, 'elapsedSeconds', item => finite(item) && item >= 0)
    && maybe(value, 'processing', item => object(item) && keys(item, [], ['text']) && maybe(item, 'text', text))
}
function validFacts(value: Data): boolean {
  if (Object.keys(value).some(key => !fields.has(key))) return false
  for (const key of ['id', 'engine', 'name', 'createdAt', 'updatedAt']) if (!text(value[key]) || !value[key]) return false
  if ((value.id as string).length > 80 || (value.engine as string).length > 80 || (value.name as string).length > 120) return false
  if (!Number.isFinite(Date.parse(value.createdAt as string)) || !Number.isFinite(Date.parse(value.updatedAt as string))) return false
  for (const key of optionalText) if (!maybe(value, key, text)) return false
  for (const key of nullableTexts) if (!maybe(value, key, nullableText)) return false
  for (const key of flags) if (!maybe(value, key, flag)) return false
  for (const key of displays) if (!maybe(value, key, item => item === null || object(item))) return false
  if (!maybe(value, 'gitContext', object) || !maybe(value, 'status', text) || !maybe(value, 'launch', launch)
    || !maybe(value, 'activity', activity) || !maybe(value, 'turn', turn) || !maybe(value, 'work', work)) return false
  if (!maybe(value, 'launchArgs', item => Array.isArray(item) && item.every(text))
    || !maybe(value, 'startedBy', item => item === null || item === 'agent')
    || !maybe(value, 'waitingFor', item => item === null || item === 'engine')
    || !maybe(value, 'bypassPermission', item => item === null || flag(item))
    || !maybe(value, 'resumeMode', item => item === 'shell' || item === 'conversation' || item === 'fresh')) return false
  if (!maybe(value, 'closePlan', item => item === null || object(item) && keys(item, ['state'], ['detail'])
    && (item.state === 'waiting' || item.state === 'failed') && maybe(item, 'detail', text))) return false
  if (!maybe(value, 'forkedFrom', item => item === null || object(item) && keys(item, ['agentId', 'name']) && text(item.agentId) && text(item.name))) return false
  // An ephemeral owner cannot borrow a native conversation alias or advertise a terminal route it does not own.
  if (!maybe(value, 'sessionId', item => item === value.id) || !maybe(value, 'tmuxPane', item => item === null)
    || !maybe(value, 'terminal', item => object(item) && keys(item, ['available', 'primary', 'runtimes'])
      && item.available === false && item.primary === '' && Array.isArray(item.runtimes) && item.runtimes.length === 0)) return false
  if (!maybe(value, 'app', object)) return false
  if (object(value.app)) for (const [key, item] of Object.entries(value.app)) {
    if (reserved.has(key) && !displayOverrides.has(key)) return false
    if (['dsh', 'dshName', 'viewerUrl', 'viewerName'].includes(key) && !nullableText(item)) return false
    if (['project', 'gitContext', 'verdict'].includes(key) && item !== null && !object(item)) return false
  }
  return true
}

export function readSessionFacts(input: unknown, limit: SessionValueLimit,
  ownsFactory: (factory: string) => boolean): { facts: SessionFacts; charge: SessionValueCharge } {
  const { value, charge } = copySessionValue(input, limit)
  if (!object(value) || !validFacts(value) || !ownsFactory(value.engine as string)) throw new Error('SESSION_OWNER_INVALID')
  // Only standard control fields were interpreted. Opaque feature display objects remain detached JSON values.
  return { facts: value as unknown as SessionFacts, charge }
}
