import { describe, expect, it } from 'vitest'
import { jobKindOf } from './jobKind.js'

const group = (owns: string[], reviewOf?: string) => ({ task: { goal: 'g', changes: 'c', constraints: 'k', owns }, ...(reviewOf ? { reviewOf } : {}) })

describe('job kind', () => {
  it('takes the kind its owned paths agree on, a path or a leading word', () => {
    expect(jobKindOf(group(['backend/src/superTabs/costs', 'backend/prisma/schema.prisma']))).toBe('backend')
    expect(jobKindOf(group(['backend Swarm route and attempt records', 'a new backend aggregate store module']))).toBe('backend')
    expect(jobKindOf(group(['cli/src/superTabs/route.ts']))).toBe('cli')
    expect(jobKindOf(group(['desktop/lib/super_tab/models.dart']))).toBe('desktop')
    expect(jobKindOf(group(['mobile/lib/main.dart']))).toBe('mobile')
    expect(jobKindOf(group(['docs/swarms.md']))).toBe('docs')
    expect(jobKindOf(group(['README.md', 'CONTRIBUTING.md']))).toBe('docs')
  })

  it('counts code with its own tests as the code, and only tests as tests', () => {
    expect(jobKindOf(group(['backend/src/superTabs/store.ts', 'backend/src/superTabs/store.test.ts', 'backend/integration/superTabs.test.ts']))).toBe('backend')
    expect(jobKindOf(group(['backend/src/superTabs/store.test.ts', 'cli/src/superTabs/route.spec.ts', 'desktop/test/models_test.dart']))).toBe('tests')
    expect(jobKindOf(group(['tests/e2e']))).toBe('tests')
  })

  it('falls back to the route word when the paths disagree or say nothing, and to general after that', () => {
    expect(jobKindOf(group(['backend/src', 'cli/src']), 'cli')).toBe('cli')
    expect(jobKindOf(group(['backend/src', 'cli/src']))).toBe('general')
    expect(jobKindOf(group(['the fix-after-merge record']), 'mobile')).toBe('mobile')
    expect(jobKindOf(group(['the fix-after-merge record']), 'ui')).toBe('general')
    expect(jobKindOf(group([]), 'parser')).toBe('general')
    expect(jobKindOf({}, undefined)).toBe('general')
  })

  it('keeps security work security whatever it owns, and a review group a review', () => {
    expect(jobKindOf(group(['backend/src/lib/ssoAuth.ts']), 'security')).toBe('security')
    expect(jobKindOf(group(['backend/src/superTabs'], 'build-group'), 'backend')).toBe('review')
  })

  it('reads a backtick, ./ or a capitalised word the same', () => {
    expect(jobKindOf(group(['`backend/src/superTabs/costs`']))).toBe('backend')
    expect(jobKindOf(group(['./cli/src']))).toBe('cli')
    expect(jobKindOf(group(['Desktop Models section']))).toBe('desktop')
  })
})
