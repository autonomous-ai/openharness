import { describe, expect, it } from 'vitest'
import * as inline from './inline.js'
import { startMonitor } from './monitor.js'
import { startProjects } from './projects.js'
import { startSearch } from './search.js'
import { startUsage } from './usage.js'
import { startViewers } from './viewers.js'
import { startWorkspaces } from './workspaces.js'

describe('the services the core runs in its own process only when they do not run in theirs', () => {
  it('are their own starts, unchanged: the same services either way', () => {
    expect({ ...inline }).toEqual({ startMonitor, startProjects, startSearch, startUsage, startViewers, startWorkspaces })
  })
})
