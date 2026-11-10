// Loaded first (`node --import`) into a hook the fake engine holds back: the process has started, so notify.mjs
// stamps the hook as run now (its FIRED_AT is the process's start), but it reads its event and reaches the daemon
// only once the fake writes FAKE_HOOK_RELEASE, as a loaded daemon read a hook's request seconds late
// (`!latestop` in fakeEngine.mjs). Waiting here, before notify.mjs runs, keeps its one-second stdin wait unspent.
import { existsSync } from 'node:fs'

const release = process.env.FAKE_HOOK_RELEASE
// At most a minute: a test that failed first does not leave its hooks waiting.
if (release) for (const end = Date.now() + 60_000; !existsSync(release) && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 20))
