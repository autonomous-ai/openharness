import { describe, expect, it, vi } from 'vitest'
import { GitHubAppError, type CiLoad } from './app.js'
import { projectCiLoad } from './ciLoad.js'

const load: CiLoad = { running: 3, queued: 1, macosRunning: 1, macosQueued: 0 }
const app = (answer: () => Promise<CiLoad | null>) => ({ ciLoad: vi.fn(answer) })
const yes = async () => true

describe('a project\'s CI load', () => {
  it('reads the counts for a GitHub repository approved for the project', async () => {
    const reader = app(async () => load)
    expect(await projectCiLoad(reader, 'git@github.com:Acme/App.git', yes)).toEqual({ state: 'read', load })
    expect(reader.ciLoad).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Acme/App' }))
  })
  it('reads nothing without an app, an address, a GitHub repository or the project\'s approval', async () => {
    const reader = app(async () => load)
    expect(await projectCiLoad(null, 'https://github.com/acme/app', yes)).toEqual({ state: 'unavailable' })
    expect(await projectCiLoad(reader, null, yes)).toEqual({ state: 'no-repository' })
    expect(await projectCiLoad(reader, 'https://gitlab.com/acme/app', yes)).toEqual({ state: 'not-github' })
    const approved = vi.fn(async () => false)
    expect(await projectCiLoad(reader, 'https://github.com/Acme/App', approved)).toEqual({ state: 'not-approved' })
    expect(approved).toHaveBeenCalledWith('acme/app')
    expect(reader.ciLoad).not.toHaveBeenCalled()
  })
  it('says not installed, and unknown when GitHub cannot say, never a load of zero; wrong app credentials are the server\'s', async () => {
    expect(await projectCiLoad(app(async () => null), 'https://github.com/acme/app', yes)).toEqual({ state: 'not-installed' })
    expect(await projectCiLoad(app(async () => { throw new GitHubAppError('GITHUB_UNAVAILABLE', 'x', 502) }), 'https://github.com/acme/app', yes)).toEqual({ state: 'unknown' })
    expect(await projectCiLoad(app(async () => { throw new Error('socket') }), 'https://github.com/acme/app', yes)).toEqual({ state: 'unknown' })
    await expect(projectCiLoad(app(async () => { throw new GitHubAppError('GITHUB_APP_MISCONFIGURED', 'x', 503) }), 'https://github.com/acme/app', yes))
      .rejects.toMatchObject({ code: 'GITHUB_APP_MISCONFIGURED' })
  })
})
