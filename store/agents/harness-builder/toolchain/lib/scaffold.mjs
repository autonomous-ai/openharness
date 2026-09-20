// `builder scaffold`: the package skeleton, so the Studio shows a harness taking shape within the
// first minutes. Every file is a starting point the stages replace; nothing in it pretends to be done.
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
}

function write(file, content, { mode, created }) {
  if (existsSync(file)) return
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
  if (mode) chmodSync(file, mode)
  created.push(file)
}

export function scaffold(pkg, { id, tool, engine = 'claude', reference }) {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(id ?? '')) throw new Error('scaffold needs an id: owner/name in lower case (a wrapper takes the project\'s name; an original workflow is named for the work)')
  const name = tool?.trim() || id.split('/')[1]
  const skill = slug(name)
  const envName = `${skill.replace(/-/g, '_').toUpperCase()}_TOOLCHAIN`
  const created = []
  const year = new Date().getFullYear()

  write(join(pkg, 'harness.json'), JSON.stringify({
    spec: 1,
    id,
    name,
    category: '',
    author: '',
    description: '',
    engine,
    workspace: { template: 'template', marker: 'brief.json', init: 'toolchain/init-workspace.sh' },
    agent: { instructions: 'AGENTS.md', skills: ['skills'], env: { [envName]: '${dsh}/toolchain' } },
    toolchain: { setup: 'toolchain/setup.sh', doctor: 'toolchain/doctor.sh' },
    viewer: { command: 'toolchain/viewer.sh', url: 'http://127.0.0.1:${port}/' },
    verdict: '.harness/verdict.json',
  }, null, 2) + '\n', { created })

  write(join(pkg, 'AGENTS.md'), `# ${name} — running inside Harness\n\n` +
    `<!-- Written at the skills stage: role, where things are, how to work so the pane moves, what good looks like. -->\n`, { created })
  write(join(pkg, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${name} — written at the skills stage.\n---\n\n# ${name}\n`, { created })

  write(join(pkg, 'template', 'brief.json'), JSON.stringify({ request: '', claims: [] }, null, 2) + '\n', { created })

  const shellHead = `#!/usr/bin/env bash\nset -euo pipefail\ncd "$(dirname "$0")/.."\n`
  write(join(pkg, 'toolchain', 'setup.sh'), `${shellHead}# shellcheck source=runtimes.sh\n. toolchain/runtimes.sh\n# Written at the toolchain stage: pinned, checksummed, inside this package.\n`, { mode: 0o755, created })
  write(join(pkg, 'toolchain', 'doctor.sh'), `${shellHead}# shellcheck source=runtimes.sh\n. toolchain/runtimes.sh\n# Written at the toolchain stage: one ok/miss line per check.\n`, { mode: 0o755, created })
  write(join(pkg, 'toolchain', 'init-workspace.sh'), `#!/usr/bin/env bash\n# Runs in a new workspace (cwd) after the template copy. Written at the evaluation stage: seed the first verdict.\nset -euo pipefail\nmkdir -p .harness\n`, { mode: 0o755, created })
  write(join(pkg, 'toolchain', 'viewer.sh'), `#!/usr/bin/env bash\n# The pane. Written at the viewer stage. Env: HARNESS_VIEWER_PORT, HARNESS_WORKSPACE, HARNESS_DSH_DIR.\nset -euo pipefail\n: "\${HARNESS_VIEWER_PORT:?}" "\${HARNESS_WORKSPACE:?}"\n`, { mode: 0o755, created })
  const canonical = reference && join(reference, 'store', 'tools', 'runtimes.sh')
  if (canonical && existsSync(canonical) && !existsSync(join(pkg, 'toolchain', 'runtimes.sh'))) {
    copyFileSync(canonical, join(pkg, 'toolchain', 'runtimes.sh'))
    created.push(join(pkg, 'toolchain', 'runtimes.sh'))
  }

  write(join(pkg, 'store.json'), JSON.stringify({ homepage: '', upstream: '', license: '', examples: [] }, null, 2) + '\n', { created })
  write(join(pkg, 'README.md'), `# ${name}, as a Harness agent\n\n` +
    `<!-- Written at the store stage: what it does, install, how its evaluation works. -->\n\n` +
    `## Credit and stewardship\n\n<!-- Whose project this wraps, and that its maintainers are welcome to own this package. -->\n`, { created })
  write(join(pkg, 'LICENSE'), `MIT License\n\nCopyright (c) ${year} The ${name} harness contributors\n\n` +
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n' +
    'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n', { created })
  write(join(pkg, '.gitignore'), 'node_modules/\n.venv/\n.conda/\n.playwright/\nvendor/cache/\n__pycache__/\n', { created })
  return { name, skill, created }
}
