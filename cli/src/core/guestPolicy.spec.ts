import { describe, expect, it } from 'vitest'
import { eventAgentId, GUEST_HARNESS_REFUSAL, GUEST_REFUSALS, guestVerdict } from './guestPolicy.js'

// A guest is a session of an account the owner shares this machine with: its own space, nothing of the
// owner's (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
describe('what a guest may ask', () => {
  const owners: Record<string, string | null> = { mine: 'kim@acme.io', theirs: 'lee@acme.io', owner: null }
  const guestOf = (agentId: string) => owners[agentId]
  const verdict = (type: string, payload: Record<string, unknown> = {}, guest = 'kim@acme.io') => guestVerdict(type, payload, guest, guestOf)

  it('may list and start its own harnesses, and use its terminals', () => {
    for (const type of ['agents_list', 'agent_create', 'agent_create_status', 'agent_create_cancel', 'engines_probe', 'theme_set', 'usage_read', 'guest_folders',
      'terminal_capabilities', 'terminal_alive', 'terminal_ack', 'terminal_input', 'terminal_resize', 'terminal_paste', 'terminal_paste_image',
      'terminal_paste_file', 'terminal_chunked_upload_begin', 'terminal_chunked_upload_cancel', 'terminal_scroll', 'terminal_resync', 'terminal_close']) {
      expect(verdict(type, type === 'agent_create' ? { engine: 'claude' } : {}), type).toEqual({ allow: true })
    }
    expect(verdict('agent_create', { engine: 'codex' })).toEqual({ allow: true })
  })

  it('starts nothing on the owner\'s grid, saved APIs or cloud accounts, nor an engine the relay cannot pay for', () => {
    expect(verdict('agent_create', { engine: 'claude', grid: { baseUrl: 'x' } })).toEqual({ allow: false, error: 'GUEST_NOT_ALLOWED' })
    expect(verdict('agent_create', { engine: 'claude', apiConnection: 'openrouter' })).toEqual({ allow: false, error: 'GUEST_NOT_ALLOWED' })
    for (const engine of ['devin-cloud', 'opencode', 'terminal', undefined]) {
      expect(verdict('agent_create', { engine }), String(engine)).toEqual({ allow: false, error: 'GUEST_NOT_ALLOWED' })
    }
  })

  it('acts on a harness only when it started it', () => {
    for (const type of ['terminal_open', 'terminal_info', 'agent_update', 'agent_close', 'agent_delete', 'message', 'cancel', 'question_response']) {
      expect(verdict(type, { agentId: 'mine' }), type).toEqual({ allow: true })
      expect(verdict(type, { agentId: 'owner' }), type).toEqual({ allow: false, error: 'NOT_YOUR_HARNESS' })
      expect(verdict(type, { agentId: 'theirs' }), type).toEqual({ allow: false, error: 'NOT_YOUR_HARNESS' })
      expect(verdict(type), type).toEqual({ allow: false, error: 'NOT_YOUR_HARNESS' })
    }
  })

  it('a guest whose account was never recorded owns nothing', () => {
    expect(guestVerdict('terminal_open', { agentId: 'unrecorded' }, '', () => '')).toEqual({ allow: false, error: 'NOT_YOUR_HARNESS' })
  })

  it('relaunches nothing, its own included: a relaunch is built the owner\'s way, as the owner', () => {
    for (const type of ['agent_resume', 'agent_restart', 'agent_retarget', 'agent_fork']) {
      expect(verdict(type, { agentId: 'mine' }), type).toEqual({ allow: false, error: 'GUEST_NOT_ALLOWED' })
    }
    expect(GUEST_HARNESS_REFUSAL).toEqual({ ok: false, error: 'GUEST_HARNESS', detail: expect.stringMatching(/Start a new one/) })
  })

  it('is refused everything else, including what is added later', () => {
    for (const type of ['e2ee_pairings_list', 'e2ee_pairing_unpair', 'device_e2ee_pair', 'phone_pair', 'group_sync', 'shared_machines',
      'sessions_list', 'session_get', 'session_search', 'agent_recent', 'agent_fork', 'agent_purge', 'agents_cleanup_preview', 'fs_list_dir',
      'agent_read_file', 'shell', 'connectors', 'memory', 'grid_models_list', 'api_connections', 'harness_devices_list', 'browser_open',
      'claude_login_status', 'route_task', 'viewer_surface', 'a_request_added_next_year']) {
      expect(verdict(type), type).toEqual({ allow: false, error: 'GUEST_NOT_ALLOWED' })
    }
  })

  it('names the harness an event is about, wherever the event carries it', () => {
    expect(eventAgentId({ agentId: 'top', payload: { agentId: 'inner' } })).toBe('top')
    expect(eventAgentId({ payload: { agentId: 'inner' } })).toBe('inner')
    expect(eventAgentId({ payload: { agent: { id: 'carried' } } })).toBe('carried')
    expect(eventAgentId({ agentId: '', payload: { agent: { id: '' } } })).toBeNull()
    expect(eventAgentId({ payload: undefined })).toBeNull()
  })

  it('says why in words', () => {
    expect(GUEST_REFUSALS.GUEST_NOT_ALLOWED).toMatch(/shared with you/)
    expect(GUEST_REFUSALS.NOT_YOUR_HARNESS).toMatch(/not yours/)
  })
})
