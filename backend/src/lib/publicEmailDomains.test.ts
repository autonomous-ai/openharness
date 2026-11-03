import { describe, expect, it } from 'vitest'
import { emailDomain, isPublicEmailDomain } from './publicEmailDomains.js'

describe('public email domains', () => {
  // Swarm auto-join (docs/specs/2026-11-03-swarm-domain-auto-join.md, Trust 5): free providers common in Vietnam and Asia.
  it('counts the free providers common in Vietnam and Asia as public', () => {
    for (const domain of ['zing.vn', 'vnn.vn', 'hn.vnn.vn', 'hcm.vnn.vn', 'fpt.vn', 'rediffmail.com', 'yahoo.co.in', 'yahoo.com.sg',
      'foxmail.com', 'sohu.com', 'aliyun.com', '139.com', 'nate.com', 'docomo.ne.jp']) {
      expect(isPublicEmailDomain(domain), domain).toBe(true)
    }
  })

  it('keeps company domains, including a company sharing a provider\'s name, open to sharing', () => {
    for (const domain of ['acme.com', 'autonomous.ai', 'fpt.com.vn', 'viettel.com.vn']) expect(isPublicEmailDomain(domain), domain).toBe(false)
    expect(isPublicEmailDomain(null)).toBe(true)
    expect(emailDomain('X@Acme.COM')).toBe('acme.com')
  })
})
