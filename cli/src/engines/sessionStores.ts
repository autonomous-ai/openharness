/**
 * Where an engine keeps its sessions, and how core reads them: a session file's first record, a session
 * file found by its id, the session a live process names, and a conversation continued in another file.
 * Each engine declares its store (engines/{claude,codex}/sessionStore.ts, listed in engines/sessionStoreContracts.ts)
 * and these apply it with the kit, in core: the registry, session repair, resume capture and the handoff name no
 * engine, and binding a session never waits on an engine worker.
 */
export { continuationOf, findSessionFileOf, sessionMetaOf, type SessionMeta } from './sessionFiles.js'
export { openFileSessionOf, processFilesOf, processSessionOf } from '../lib/sessionRepair.js'
