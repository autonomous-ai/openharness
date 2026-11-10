// Loaded first (`node --import`) into a hook the fake engine holds back: the process has started, so notify.mjs
// stamps the hook as run now (its FIRED_AT is the process's start), but it reads its event and reaches the daemon
// only once the fake writes FAKE_HOOK_RELEASE, as a loaded daemon read a hook's request seconds late
// (`!latestop` in fakeEngine.mjs). Waiting here, before notify.mjs runs, keeps its one-second stdin wait unspent.
import { existsSync } from 'node:fs'

const release = process.env.FAKE_HOOK_RELEASE
if (release) while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20))
