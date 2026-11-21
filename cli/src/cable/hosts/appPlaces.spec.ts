// Where the Claude and ChatGPT apps keep their stores and programs on each OS: plain values, so every OS's case runs here.
import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAUDE_MSIX_FAMILY, chatGptPlaces, claudeStoreRoots } from './appPlaces.js'

describe('claudeStoreRoots', () => {
  it('macOS: the one Application Support root, watched from it and its Claude folder, whatever XDG_CONFIG_HOME says', () => {
    const root = '/Users/a/Library/Application Support/Claude/claude-code-sessions'
    const want = [{ root, watch: [root, '/Users/a/Library/Application Support/Claude'] }]
    expect(claudeStoreRoots('darwin', {}, '/Users/a')).toEqual(want)
    expect(claudeStoreRoots('darwin', { XDG_CONFIG_HOME: '/Users/a/.xdg' }, '/Users/a')).toEqual(want)
  })

  describe('Windows', () => {
    const home = "C:\\Users\\Nguyễn Văn A' & 100%"
    const local = "D:\\Profiles\\Nguyễn Văn A' & 100%\\Local"
    const roaming = "D:\\Profiles\\Nguyễn Văn A' & 100%\\Roaming"
    /** The two roots under these folders, MSIX's private copy first, each watched down to its stop folder. */
    const rootsUnder = (localAppData: string, appData: string) => {
      const packages = win32.join(localAppData, 'Packages')
      const family = win32.join(packages, 'Claude_pzs8sxrjxfjjc')
      const localCache = win32.join(family, 'LocalCache')
      const roamingCopy = win32.join(localCache, 'Roaming')
      const msixClaude = win32.join(roamingCopy, 'Claude')
      const msix = win32.join(msixClaude, 'claude-code-sessions')
      const claude = win32.join(appData, 'Claude')
      const squirrel = win32.join(claude, 'claude-code-sessions')
      return [
        { root: msix, watch: [msix, msixClaude, roamingCopy, localCache, family, packages] },
        { root: squirrel, watch: [squirrel, claude, appData] },
      ]
    }

    it('the MSIX copy under LOCALAPPDATA, then APPDATA, a profile name that needs escaping kept as it is', () => {
      const roots = claudeStoreRoots('win32', { LOCALAPPDATA: local, APPDATA: roaming }, home)
      expect(roots).toEqual(rootsUnder(local, roaming))
      expect(roots[0]!.root).toBe(
        "D:\\Profiles\\Nguyễn Văn A' & 100%\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code-sessions")
      expect(roots[1]!.root).toBe("D:\\Profiles\\Nguyễn Văn A' & 100%\\Roaming\\Claude\\claude-code-sessions")
    })

    it.each([
      ['unset', {}],
      ['empty', { LOCALAPPDATA: '', APPDATA: '' }],
      ['relative', { LOCALAPPDATA: 'AppData\\Local', APPDATA: 'Roaming' }],
    ])('LOCALAPPDATA and APPDATA %s: the profile\'s AppData folders in their place', (_, env) => {
      expect(claudeStoreRoots('win32', env, home))
        .toEqual(rootsUnder(win32.join(home, 'AppData', 'Local'), win32.join(home, 'AppData', 'Roaming')))
    })

    it('APPDATA equal to the profile folder: its chain stops at the Claude folder and never holds the profile', () => {
      const roots = claudeStoreRoots('win32', { LOCALAPPDATA: local, APPDATA: `${home}\\` }, home)
      expect(roots[1]).toEqual({
        root: win32.join(home, 'Claude', 'claude-code-sessions'),
        watch: [win32.join(home, 'Claude', 'claude-code-sessions'), win32.join(home, 'Claude')],
      })
    })

    it('the family is Claude\'s MSIX package family', () => {
      expect(CLAUDE_MSIX_FAMILY).toBe('Claude_pzs8sxrjxfjjc')
    })
  })

  describe('Linux', () => {
    const home = '/home/a'

    it('XDG_CONFIG_HOME absolute: the Claude folder under it, watched down to it', () => {
      expect(claudeStoreRoots('linux', { XDG_CONFIG_HOME: '/srv/conf' }, home)).toEqual([{
        root: '/srv/conf/Claude/claude-code-sessions',
        watch: ['/srv/conf/Claude/claude-code-sessions', '/srv/conf/Claude', '/srv/conf'],
      }])
    })

    it.each([
      ['unset', {}],
      ['empty', { XDG_CONFIG_HOME: '' }],
      ['relative', { XDG_CONFIG_HOME: '.xdg' }],
    ])('XDG_CONFIG_HOME %s: ~/.config in its place', (_, env) => {
      expect(claudeStoreRoots('linux', env, home)).toEqual([{
        root: '/home/a/.config/Claude/claude-code-sessions',
        watch: ['/home/a/.config/Claude/claude-code-sessions', '/home/a/.config/Claude', '/home/a/.config'],
      }])
    })

    it('XDG_CONFIG_HOME equal to the home folder: the chain stops at <home>/Claude and never holds home', () => {
      expect(claudeStoreRoots('linux', { XDG_CONFIG_HOME: '/home/a/' }, home)).toEqual([{
        root: '/home/a/Claude/claude-code-sessions',
        watch: ['/home/a/Claude/claude-code-sessions', '/home/a/Claude'],
      }])
    })
  })

  it('any other OS: no root', () => {
    expect(claudeStoreRoots('freebsd', { XDG_CONFIG_HOME: '/srv/conf' }, '/home/a')).toEqual([])
  })
})

describe('chatGptPlaces', () => {
  it('macOS: the apps folder or /Applications, then ~/Applications', () => {
    expect(chatGptPlaces('darwin', '/tmp/apps', '/Users/a'))
      .toEqual(['/tmp/apps/ChatGPT.app', '/Users/a/Applications/ChatGPT.app'])
    expect(chatGptPlaces('darwin', undefined, '/Users/a'))
      .toEqual(['/Applications/ChatGPT.app', '/Users/a/Applications/ChatGPT.app'])
  })

  it('macOS: a relative apps folder is ignored', () => {
    expect(chatGptPlaces('darwin', 'apps', '/Users/a'))
      .toEqual(['/Applications/ChatGPT.app', '/Users/a/Applications/ChatGPT.app'])
  })

  it('Linux: the program under the apps folder, else under /usr/lib', () => {
    expect(chatGptPlaces('linux', '/tmp/apps', '/home/a')).toEqual([posix.join('/tmp/apps', 'chatgpt', 'ChatGPT')])
    expect(chatGptPlaces('linux', undefined, '/home/a')).toEqual(['/usr/lib/chatgpt/ChatGPT'])
    expect(chatGptPlaces('linux', 'apps', '/home/a')).toEqual(['/usr/lib/chatgpt/ChatGPT'])
  })

  it('Windows: the package\'s program under an absolute apps folder, else nothing (the Store package is asked)', () => {
    expect(chatGptPlaces('win32', "C:\\Users\\Nguyễn Văn A' & 100%\\apps", 'C:\\Users\\a'))
      .toEqual(["C:\\Users\\Nguyễn Văn A' & 100%\\apps\\OpenAI.Codex\\app\\ChatGPT.exe"])
    expect(chatGptPlaces('win32', undefined, 'C:\\Users\\a')).toEqual([])
    expect(chatGptPlaces('win32', 'apps', 'C:\\Users\\a')).toEqual([])
  })

  it('any other OS: nowhere', () => {
    expect(chatGptPlaces('freebsd', '/tmp/apps', '/home/a')).toEqual([])
  })
})
