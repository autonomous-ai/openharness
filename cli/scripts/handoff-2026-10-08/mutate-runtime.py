# Flip one engine's runtime-profile reading at a time and check the runtime golden fails.
import subprocess, sys, os
cli = sys.argv[1]
M_ = 'src/lib/runtimeProfileManager.ts'
E = lambda e: f'src/engines/{e}/runtimeProfile.ts'
M = [
 ('pi footer read as grok', M_, "engineNow('pi', 'its pane was read')?.parsePiFooterProfile(paneText)", "engineNow('grok', 'x')?.parseGrokFooterProfile(paneText)"),
 ('grok footer ignored', M_, "engineNow('grok', 'its pane was read')?.parseGrokFooterProfile(paneText)", "null"),
 ('agy footer ignored', M_, "engineNow('agy', 'its pane was read')?.parseAgyFooterProfile(paneText)", "null"),
 ('devin footer ignored', M_, "engineNow('devin', 'its pane was read')?.devinFooterModel(paneText)", "null"),
 ('hermes status ignored', M_, "engineNow('hermes', 'its pane was read')?.hermesStatusModel(paneText)", "null"),
 ('commandcode banner ignored', M_, "engineNow('commandcode', 'its pane was read')?.commandcodeBannerModel(paneText)", "null"),
 ('opencode footer without catalog', M_, "opencode?.opencodeFooterModelId(paneText, this.opencodeCatalogCache?.entries ?? [])", "opencode?.opencodeFooterModelId(paneText, [])"),
 ('kilo footer without catalog', M_, "?.kiloFooterModelId(paneText, this.kiloCatalogCache?.entries ?? [])", "?.kiloFooterModelId(paneText, [])"),
 ('hermes config effort', M_, "      state.effort = parsed.effort ?? 'auto'\n      state.observedAt = Date.now()\n      const after = this.selectedModel(session)\n      this.wake(session.sessionId)\n      if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {\n        this.scheduleChanged(session.sessionId)\n      }\n      return before !== after\n    }\n    if (session.engine === 'muse') {", "      state.effort = 'auto'\n      state.observedAt = Date.now()\n      const after = this.selectedModel(session)\n      this.wake(session.sessionId)\n      if (!silent && this.suppressNotifications === 0 && before !== after && !this.controls.has(session.sessionId)) {\n        this.scheduleChanged(session.sessionId)\n      }\n      return before !== after\n    }\n    if (session.engine === 'muse') {"),
 ('muse settings ignored', M_, "muse.parseMuseSettings(await readText(join(env.MUSE_CONFIG_DIR, 'settings.json')))", "muse.parseMuseSettings('')"),
 ('amp session ignored', M_, "amp.parseAmpSession(await readText(join(env.AMP_STATE_DIR, 'session.json')))", "amp.parseAmpSession('')"),
 ('devin catalog empty', M_, "      entries = devin.parseDevinModelsOutput(result.stdout)", "      entries = devin.parseDevinModelsOutput('')"),
 ('cursor footer (manager own code)', M_, "const parsed = footerLines.map(parseCursorFooter).find((item) => item !== null)", "const parsed = null as ReturnType<typeof parseCursorFooter>"),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherRuntime.golden.spec.ts'], cwd=cli, capture_output=True, text=True)
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
