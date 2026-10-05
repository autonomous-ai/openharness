// cli/src/orchestrator/flow.spec.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { FlowError, compileFlow, flowJsonSchema, inputEnvName, parseFlowSource, RUN_STEP_DEFAULT_TIMEOUT_MS } from './flow.js'

const launch = `spec: 1
name: product-launch
description: CAD part -> check
inputs:
  object: { required: true, description: What to design }
  units: { default: mm }
tasks:
  - id: part
    harness: autonomous/text-to-cad
    prompt: |
      Design $inputs.object in $inputs.units.
    outputs: { files: ["*.step", "dimensions.json"], verdict: ready }
    timeout: 45m
    retry: { max_attempts: 2 }
  - id: part-check
    run: python3 "$HARNESS_PROJECT_DIR/checks/reimport.py" inputs/part "$HARNESS_INPUT_UNITS"
    depends_on: [part]
`
const compile = (source: string, inputs: Record<string, string> = {}) => compileFlow(parseFlowSource(source, 'flow.yaml'), inputs)
const issues = (fn: () => unknown): string => {
  try { fn() } catch (error) { if (error instanceof FlowError) return error.message; throw error }
  throw new Error('expected a FlowError')
}

describe('flow compilation', () => {
  it('compiles the issue example into task specs', () => {
    const flow = compile(launch, { object: 'a desk lamp' })
    expect(flow).toMatchObject({ name: 'product-launch', inputs: { object: 'a desk lamp', units: 'mm' }, warnings: [] })
    expect(flow.tasks).toEqual([
      { id: 'part', title: 'part', harness: 'autonomous/text-to-cad', prompt: 'Design a desk lamp in mm.', dependsOn: [],
        outputs: { files: ['*.step', 'dimensions.json'], verdict: 'ready' }, timeoutMs: 2_700_000, retry: { maxAttempts: 2 } },
      { id: 'part-check', title: 'part-check', harness: 'run', prompt: expect.stringContaining('reimport.py'), dependsOn: ['part'],
        run: expect.stringContaining('$HARNESS_INPUT_UNITS'), timeoutMs: RUN_STEP_DEFAULT_TIMEOUT_MS },
    ])
    expect(inputEnvName('object_id')).toBe('HARNESS_INPUT_OBJECT_ID')
  })
  it('accepts JSON as YAML and records the source hash', () => {
    const parsed = parseFlowSource('{"spec":1,"name":"j","tasks":[{"id":"a","run":"true"}]}', 'j.json')
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(compileFlow(parsed, {}).tasks[0]).toMatchObject({ harness: 'run', run: 'true' })
  })
  it.each([
    ['an alias', 'spec: 1\nname: x\nbase: &b { id: a, run: "true" }\ntasks: [*b]\n', 'Anchors are not allowed'],
    ['a tag', 'spec: 1\nname: x\ntasks:\n  - id: a\n    run: !!str true\n', 'Tags are not allowed'],
    ['a duplicate key', 'spec: 1\nname: x\nname: y\ntasks: [{ id: a, run: "true" }]\n', 'flow.yaml:3:'],
    ['two documents', 'spec: 1\n---\nspec: 1\n', 'flow.yaml:'],
    ['an unknown key', 'spec: 1\nname: x\ntasks: [{ id: a, run: "true", colour: x }]\n', 'flow.yaml:3:'],
    ['a wrong spec', 'spec: 2\nname: x\ntasks: [{ id: a, run: "true" }]\n', 'spec'],
    ['an empty file', '', 'expected object'],
  ])('rejects %s with a located message', (_name, source, expected) => {
    expect(issues(() => parseFlowSource(source, 'flow.yaml'))).toContain(expected)
  })
  it('rejects oversized sources before parsing', () => {
    expect(issues(() => parseFlowSource(`# ${'x'.repeat(300 * 1024)}`, 'big.yaml'))).toContain('256 KiB')
  })
  it('collects every compile error in one message', () => {
    const message = issues(() => compile(`spec: 1
name: bad
inputs:
  a: { required: true, default: x }
tasks:
  - { id: one, run: "echo $inputs.a", harness: engine:claude }
  - { id: two, harness: engine:claude }
  - { id: two, harness: run, prompt: x }
  - { id: three, run: "echo $HARNESS_INPUT_NOPE", outputs: { files: [x] } }
  - { id: four, harness: engine:claude, prompt: "use $inputs.zzz", timeout: 25h, depends_on: [ghost] }
`, { nope: '1' }))
    for (const part of ['Unknown input: nope', 'both required and have a default', 'HARNESS_INPUT_A', 'exactly one of run, harness + prompt, approval or cancel',
      'Duplicate task id: two', 'reserved', 'Unknown input: HARNESS_INPUT_NOPE', 'outputs apply to agent tasks', 'Unknown input: $inputs.zzz', '24h']) {
      expect(message).toContain(part)
    }
    expect(message).not.toContain('1\n') // the value of an unknown input is never echoed
  })
  it('reports missing required inputs, dependency problems and limits', () => {
    expect(issues(() => compile(launch))).toContain('Missing required input: object')
    expect(issues(() => compile('spec: 1\nname: x\ntasks: [{ id: a, run: "true", depends_on: [b] }, { id: b, run: "true", depends_on: [a] }]\n'))).toContain('Dependency cycle')
    expect(issues(() => compile('spec: 1\nname: x\ntasks: [{ id: a, run: "true", depends_on: [ghost] }]\n'))).toContain('Unknown dependency: ghost')
    expect(issues(() => compile(`spec: 1\nname: x\ninputs: { big: {} }\ntasks: [{ id: a, harness: engine:claude, prompt: "$inputs.big" }]\n`, { big: 'y'.repeat(24_001) }))).toContain('tasks[0]')
  })
  it('counts retry.max_attempts as all attempts, the first included', () => {
    const retry = (n: number) => `spec: 1\nname: x\ntasks: [{ id: a, run: "true", retry: { max_attempts: ${n} } }]\n`
    expect(compile(retry(1)).tasks[0].retry).toEqual({ maxAttempts: 1 })
    expect(compile(retry(6)).tasks[0].retry).toEqual({ maxAttempts: 6 })
    for (const n of [0, 7]) expect(issues(() => compile(retry(n)))).toContain('max_attempts')
    const items = (flowJsonSchema() as { properties: { tasks: { items: { properties: { retry: { description?: string } } } } } }).properties.tasks.items
    expect(items.properties.retry.description).toMatch(/first attempt included/)
  })
  it('rejects output globs that leave the task folder', () => {
    for (const glob of ['/etc/passwd', '../x', 'a/../../b', 'a\\\\b']) {
      expect(issues(() => parseFlowSource(`spec: 1\nname: x\ntasks: [{ id: a, harness: engine:claude, prompt: p, outputs: { files: ["${glob}"] } }]\n`, 'f.yaml'))).toContain('outputs')
    }
  })
  it('warns about agent tasks that can only finish explicitly, and treats optional inputs as empty', () => {
    const flow = compile('spec: 1\nname: x\ninputs: { note: {} }\ntasks: [{ id: a, harness: engine:claude, prompt: "Note: $inputs.note." }]\n')
    expect(flow.warnings).toEqual(['Task a has neither outputs nor timeout; it finishes only when its worker calls finish or fail.'])
    expect(flow.tasks[0].prompt).toBe('Note: .')
    expect(flow.inputs).toEqual({ note: '' })
  })
  it('treats inputs named like Object members as plain inputs', () => {
    const source = 'spec: 1\nname: x\ninputs: { constructor: {}, valueof: { default: v } }\ntasks: [{ id: a, harness: engine:claude, prompt: "[$inputs.constructor][$inputs.valueof]", title: Custom }]\n'
    expect(compile(source).tasks[0]).toMatchObject({ prompt: '[][v]', title: 'Custom' })
    expect(compile(source, { constructor: 'c' }).tasks[0].prompt).toBe('[c][v]')
    expect(issues(() => compile('spec: 1\nname: x\ninputs: { constructor: { required: true } }\ntasks: [{ id: a, run: "true" }]\n'))).toContain('Missing required input: constructor')
  })
  it('points an unknown key at the key, not its value', () => {
    const source = 'spec: 1\nname: demo\ntasks:\n  - id: a\n    run: echo\n    colour: red\n'
    expect(() => parseFlowSource(source, 'f.yaml')).toThrow('f.yaml:6:5: tasks[0]: Unknown keys: colour')
  })
  it('points a non-string unknown key at the key', () => {
    const source = 'spec: 1\nname: demo\ntasks:\n  - id: a\n    run: echo\n    1: red\n    true: x\n'
    expect(() => parseFlowSource(source, 'f.yaml')).toThrow('f.yaml:6:5: tasks[0]: Unknown keys: 1, true')
  })
  it('points a null unknown key at the key', () => {
    expect(() => parseFlowSource('spec: 1\nname: demo\ntasks:\n  - id: a\n    run: echo\n    null: red\n', 'f.yaml')).toThrow('f.yaml:6:5: tasks[0]: Unknown keys: ')
    expect(() => parseFlowSource('spec: 1\nname: demo\ntasks:\n  - id: a\n    run: echo\n    ~: red\n', 'f.yaml')).toThrow('f.yaml:6:5: tasks[0]: Unknown keys: ')
  })
  it('gives the size limit a position', () => {
    expect(() => parseFlowSource(`# ${'x'.repeat(300 * 1024)}`, 'big.yaml')).toThrow('big.yaml:1:1: A flow file is limited to 256 KiB.')
  })
  it('reports independent problems together, with lines', () => {
    const message = issues(() => compile('spec: 1\nname: x\ntasks:\n  - { id: a, run: "true", timeout: 30h, depends_on: [ghost] }\n  - { id: b, prompt: p }\n'))
    expect(message).toContain('flow.yaml:4:')
    expect(message).toContain('timeout is limited to 24h')
    expect(message).toContain('Unknown dependency: ghost')
    expect(message).toContain('A task has exactly one of run, harness + prompt, approval or cancel.')
    expect(issues(() => compile('spec: 1\nname: x\ntasks: [{ id: a, approval: ok, when: x }]\n'))).toBe('flow.yaml:3:38: tasks[0] (a): when: Write one comparison, like "review.verdict.errors == 0".')
  })
  it('never echoes values through conversion warnings and rejects non-plain keys', () => {
    const secret = 'SECRET_VALUE_123'
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const message = issues(() => parseFlowSource(`spec: 1\nname: x\ninputs:\n  key:\n    default: { { ${secret}: x }: y }\ntasks: [{ id: a, run: "true" }]\n`, 'flow.yaml'))
      expect(message).toContain('Keys must be plain names.')
      expect(message).toContain('flow.yaml:5:')
      expect(message).not.toContain(secret)
      expect(JSON.stringify([...warn.mock.calls, ...log.mock.calls])).not.toContain(secret)
    } finally { warn.mockRestore(); log.mockRestore() }
  })
  it('reports approval outside a task as an ordinary unknown key', () => {
    expect(issues(() => parseFlowSource('spec: 1\nname: x\napproval: x\ntasks: [{ id: a, run: "true" }]\n', 'flow.yaml'))).toMatch(/flow\.yaml:3:.*Unknown keys: approval/)
    expect(issues(() => parseFlowSource('spec: 1\nname: x\ninputs: { key: { approval: x } }\ntasks: [{ id: a, run: "true" }]\n', 'flow.yaml'))).toMatch(/flow\.yaml:3:.*Unknown keys: approval/)
  })
})

describe('flow task kinds, conditions and trigger rules', () => {
  const compileTasks = (tasks: string, inputs = '') => compileFlow(parseFlowSource(`spec: 1\nname: demo\n${inputs}tasks:\n${tasks}`, 'f.yaml'), {})
  const errors = (tasks: string, inputs = '') => issues(() => compileTasks(tasks, inputs))
  it('compiles approvals, cancel steps, conditions and trigger rules', () => {
    const flow = compileTasks(`  - { id: review, harness: test/cad, prompt: Review, outputs: { files: [r.md], verdict: ready } }
  - { id: ok, approval: "Ship?", depends_on: [review], when: "review.verdict.errors == 0", timeout: 24h }
  - id: choose
    approval: { message: "Pick", decisions: [{ id: ship, label: Ship it }, { id: rework }] }
    depends_on: [ok]
  - { id: stop, cancel: "Rework asked", depends_on: [choose], when: "choose.decision == rework" }
  - { id: report, run: "true", depends_on: [review], trigger_rule: all_done, retry: { max_attempts: 3, delay: 5s } }
`)
    expect(flow.tasks.find(t => t.id === 'ok')).toMatchObject({ harness: 'approval', prompt: 'Ship?', approval: { message: 'Ship?' }, when: 'review.verdict.errors == 0', timeoutMs: 86_400_000 })
    expect(flow.tasks.find(t => t.id === 'ok')!.approval!.decisions).toBeUndefined()
    expect(flow.tasks.find(t => t.id === 'choose')!.approval!.decisions).toEqual([{ id: 'ship', label: 'Ship it' }, { id: 'rework', label: 'rework' }])
    expect(flow.tasks.find(t => t.id === 'stop')).toEqual({ id: 'stop', title: 'stop', dependsOn: ['choose'], harness: 'cancel', prompt: 'Rework asked', cancel: 'Rework asked', when: 'choose.decision == rework' })
    expect(flow.tasks.find(t => t.id === 'report')).toMatchObject({ triggerRule: 'all_done', retry: { maxAttempts: 3, delayMs: 5000 } })
    expect(flow.warnings).toEqual([])
  })
  it('substitutes inputs in approval messages and cancel reasons, and rejects unknown ones', () => {
    const inputs = 'inputs: { issue: { default: "#7" } }\n'
    const flow = compileTasks(`  - { id: ok, approval: { message: "Ship $inputs.issue?", decisions: [{ id: ship }] } }\n  - { id: stop, cancel: "Stop $inputs.issue", depends_on: [ok] }\n`, inputs)
    expect(flow.tasks[0]).toMatchObject({ prompt: 'Ship #7?', approval: { message: 'Ship #7?' } })
    expect(flow.tasks[1]).toMatchObject({ prompt: 'Stop #7', cancel: 'Stop #7' })
    const message = errors(`  - { id: ok, approval: "Ship $inputs.nope?" }\n  - { id: stop, cancel: "Stop $inputs.zip" }\n`, inputs)
    expect(message).toContain('Unknown input: $inputs.nope')
    expect(message).toContain('Unknown input: $inputs.zip')
  })
  it('compiles a loop and an idle timeout on an agent task', () => {
    const flow = compileTasks(`  - { id: fix, harness: test/cad, prompt: Fix, loop: { until_run: "npm test", max_iterations: 3 }, idle_timeout: 15m }\n`)
    expect(flow.tasks[0]).toMatchObject({ loop: { untilRun: 'npm test', maxIterations: 3 }, idleTimeoutMs: 900_000 })
    expect(flow.warnings).toEqual([])
  })
  it('accepts a declared HARNESS_INPUT in until_run', () => {
    const flow = compileTasks(`  - { id: fix, harness: test/cad, prompt: Fix, timeout: 1h, loop: { until_run: "test $HARNESS_INPUT_X", max_iterations: 2 } }\n`, 'inputs: { x: {} }\n')
    expect(flow.tasks[0].loop).toEqual({ untilRun: 'test $HARNESS_INPUT_X', maxIterations: 2 })
  })
  it('rejects a when on something that is not a direct dependency', () => {
    expect(errors(`  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a] }\n  - { id: c, run: "true", depends_on: [b], when: "a.state == failed" }\n`))
      .toContain('f.yaml:6:50: tasks[2] (c): when: a is not a direct dependency of c.')
    expect(errors(`  - { id: a, run: "true", when: "a.state == failed" }\n`)).toContain('when: a is not a direct dependency of a.')
  })
  it('rejects keys on the wrong kind', () => {
    expect(errors(`  - { id: a, run: "true", loop: { until_run: "true", max_iterations: 1 } }\n`)).toContain('loop applies to agent tasks.')
    expect(errors(`  - { id: a, run: "true", idle_timeout: 1m }\n`)).toContain('idle_timeout applies to agent tasks.')
    expect(errors(`  - { id: a, approval: x, outputs: { files: [x] } }\n`)).toContain('outputs apply to agent tasks.')
    expect(errors(`  - { id: a, cancel: x, timeout: 1m }\n`)).toContain('timeout does not apply to cancel tasks.')
    expect(errors(`  - { id: a, approval: x, retry: { max_attempts: 2 } }\n`)).toContain('retry does not apply to approval or cancel tasks.')
    expect(errors(`  - { id: a, cancel: x, retry: { max_attempts: 2 } }\n`)).toContain('retry does not apply to approval or cancel tasks.')
    expect(errors(`  - { id: a, approval: x, run: "true" }\n`)).toContain('A task has exactly one of run, harness + prompt, approval or cancel.')
    expect(errors(`  - { id: a, approval: x, cancel: y }\n`)).toContain('A task has exactly one of run, harness + prompt, approval or cancel.')
    expect(errors(`  - { id: a, harness: approval, prompt: x }\n`)).toContain('"approval" is reserved; use the approval key instead.')
    expect(errors(`  - { id: a, harness: cancel, prompt: x }\n`)).toContain('"cancel" is reserved; use the cancel key instead.')
    expect(errors(`  - { id: a, harness: run, prompt: x }\n`)).toContain('"run" is reserved; use the run key instead.')
  })
  it('checks the keys that are present even when the kind is ambiguous', () => {
    const message = errors(`  - { id: a, approval: x, cancel: y, loop: { until_run: "true", max_iterations: 1 }, timeout: 1m, retry: { max_attempts: 2 } }\n`)
    expect(message).toContain('exactly one of')
    expect(message).toContain('loop applies to agent tasks.')
    expect(message).not.toContain('timeout does not apply') // the approval part allows a timeout
    expect(message).toContain('retry does not apply to approval or cancel tasks.')
    expect(errors(`  - { id: a, run: "true", approval: x, retry: { max_attempts: 2 } }\n`)).not.toContain('retry does not apply')
  })
  it('warns about a verdict nobody promised and an unbounded loop', () => {
    const flow = compileTasks(`  - { id: a, harness: test/cad, prompt: x, loop: { until_run: "true", max_iterations: 2 } }\n  - { id: b, run: "true", depends_on: [a], when: "a.verdict.ready == true" }\n`)
    expect(flow.warnings).toEqual([
      'Task a loops without timeout or idle_timeout; it may run until someone stops it.',
      'Task b: when reads the verdict of a, which does not declare outputs.verdict: ready.',
    ])
  })
  it('rejects inputs/<x> of a task that is not a direct dependency, at the field that names it', () => {
    const text = errors(`  - { id: plan, harness: test/cad, prompt: p, outputs: { files: [plan.md] } }\n  - { id: tests, run: "true" }\n  - { id: review, harness: test/cad, prompt: "Review against inputs/plan/plan.md", depends_on: [tests] }\n`)
    expect(text).toMatch(/:\d+:\d+: tasks\[2\] \(review\): inputs\/plan\/ is only filled for direct dependencies; add plan to depends_on\./)
    expect(errors(`  - { id: a, run: "true" }\n  - { id: b, harness: test/cad, prompt: p, loop: { until_run: "test -f inputs/a/x", max_iterations: 2 }, timeout: 1h }\n`)).toContain('inputs/a/ is only filled for direct dependencies; add a to depends_on.')
  })
  it('warns once about a file the dependency does not declare', () => {
    const flow = compileTasks(`  - { id: plan, harness: test/cad, prompt: p, outputs: { files: [plan.md] } }
  - { id: tests, run: "cat inputs/plan/notes.md inputs/plan/notes.md inputs/plan/plan.md", depends_on: [plan] }
  - { id: log, run: "cat inputs/tests/stdout.log inputs/tests/x.txt", depends_on: [tests] }
  - { id: free, harness: test/cad, prompt: p, timeout: 1h }
  - { id: any, run: "cat inputs/free/whatever.md", depends_on: [free] }
  - { id: ok, approval: "Read inputs/log/approval.json", depends_on: [log] }
  - { id: gone, cancel: "see inputs/ok/x", depends_on: [ok] }
  - { id: bare, run: "ls inputs/ok", depends_on: [ok] }
  - { id: after, run: "cat inputs/gone/x", depends_on: [gone] }
`)
    expect(flow.warnings).toEqual([
      'Task tests reads inputs/plan/notes.md, which plan does not declare in outputs.',
      'Task log reads inputs/tests/x.txt, which tests does not declare in outputs.',
      'Task ok reads inputs/log/approval.json, which log does not declare in outputs.',
      'Task after reads inputs/gone/x, which gone does not declare in outputs.',
    ])
  })
  it('reads references by whole words, and puts the error at the exact field', () => {
    const base = `  - { id: plan, harness: test/cad, prompt: p, outputs: { files: [plan.md, "docs/**"] } }\n`
    for (const text of ['inputs/plan_backup/file', 'inputs/plan.json', '/tmp/inputs/plan/file', 'inputs/plan'])
      expect(compileTasks(`${base}  - { id: b, run: "cat ${text}" }\n`).warnings).toEqual([])
    expect(compileTasks(`${base}  - { id: b, run: "cat x=inputs/plan/plan.md (inputs/plan/plan.md)", depends_on: [plan] }\n`).warnings).toEqual([])
    expect(errors(`${base}  - { id: b, run: "cat x=inputs/plan/f", depends_on: [] }\n`)).toContain('add plan to depends_on')
    // two references to the same task in one field: one error
    expect(errors(`${base}  - { id: b, run: "cat inputs/plan/a inputs/plan/b" }\n`).match(/is only filled/g)).toHaveLength(1)
    const at = (tasks: string): string => errors(`${base}${tasks}`)
    expect(at(`  - { id: b, approval: { decisions: [{ id: ok }], message: "see inputs/plan/x" } }\n`)).toMatch(/f\.yaml:5:\d+: tasks\[1\] \(b\)/)
    expect(at(`  - { id: b, approval: { decisions: [{ id: ok }], message: "see inputs/plan/x" } }\n`)).toContain(':5:60:')
    expect(at(`  - { id: c, harness: test/cad, prompt: p, loop: { max_iterations: 2, until_run: "test -f inputs/plan/x" }, timeout: 1h }\n`)).toContain(':5:82:')
  })
  it('ignores punctuation, separators and globs after a file name, and treats a folder of a declared glob as declared', () => {
    const flow = compileTasks(`  - { id: plan, harness: test/cad, prompt: p, outputs: { files: [plan.md, "docs/**"] } }
  - { id: a, run: "true" }
  - { id: b, prompt: "x", harness: test/cad, timeout: 1h, depends_on: [plan, a] , run: null }
`.replace(', run: null', '') + `  - { id: c, run: "cat inputs/a/stdout.log; cat inputs/plan/*.md inputs/plan/$F inputs/plan/part? inputs/plan/docs inputs/plan/docs/ inputs/plan/docs/x.md|cat", depends_on: [plan, a] }
  - { id: d, harness: test/cad, prompt: "Review inputs/plan/plan.md. Then inputs/plan/nope.txt, please", timeout: 1h, depends_on: [plan] }
`)
    expect(flow.warnings).toEqual(['Task d reads inputs/plan/nope.txt, which plan does not declare in outputs.'])
  })
  it('lists warnings in task order and reports only the cycle of a cyclic flow', () => {
    expect(compileTasks(`  - { id: a, run: "cat inputs/b/x", depends_on: [b] }\n  - { id: b, run: "true", trigger_rule: none_failed_min_one_success }\n`).warnings).toEqual([
      'Task a reads inputs/b/x, which b does not declare in outputs.',
      'Task b uses trigger_rule none_failed_min_one_success without depends_on; it is always skipped.',
    ])
    expect(errors(`  - { id: a, run: "cat inputs/c/x", depends_on: [b] }\n  - { id: b, run: "true", depends_on: [a] }\n  - { id: c, run: "true" }\n`)).not.toContain('only filled')
  })
  it('warns about configurations that can never run', () => {
    expect(compileTasks(`  - { id: a, run: "true", trigger_rule: none_failed_min_one_success }\n`).warnings).toEqual(['Task a uses trigger_rule none_failed_min_one_success without depends_on; it is always skipped.'])
    expect(compileTasks(`  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a], when: "a.state == failed" }\n`).warnings)
      .toEqual(['Task b: when a.state == failed can never be true under trigger_rule all_success, which blocks or skips b first; use trigger_rule: all_done.'])
    expect(compileTasks(`  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a], trigger_rule: none_failed_min_one_success, when: "a.state == cancelled" }\n`).warnings)
      .toEqual(['Task b: when a.state == cancelled can never be true under trigger_rule none_failed_min_one_success, which blocks b first; use trigger_rule: all_done.'])
    for (const ok of ['when: "a.state != failed"', 'trigger_rule: all_done, when: "a.state == failed"', 'trigger_rule: none_failed_min_one_success, when: "a.state == skipped"'])
      expect(compileTasks(`  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a], ${ok} }\n`).warnings).toEqual([])
  })
  it('warns differently about the verdict of a shell step', () => {
    expect(compileTasks(`  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a], when: "a.verdict.ready == true" }\n`).warnings)
      .toEqual(['Task b: when reads the verdict of a, a shell step; it must write .harness/verdict.json itself.'])
  })
  it('accepts state conditions on any kind and decisions declared by an approval', () => {
    const flow = compileTasks(`  - { id: c, approval: { message: m, decisions: [{ id: ship }] } }\n  - { id: d, run: "true", depends_on: [c], when: "c.decision == ship" }\n  - { id: e, cancel: x, depends_on: [c, d], when: "c.state != succeeded" }\n`)
    expect(flow.tasks.map(t => t.when)).toEqual([undefined, 'c.decision == ship', 'c.state != succeeded'])
    expect(flow.warnings).toEqual([])
  })
  it.each([
    ['retry delay over 60s', `  - { id: a, run: "true", retry: { max_attempts: 2, delay: 2m } }\n`, 'retry.delay is 1s to 60s.'],
    ['idle_timeout over 24h', `  - { id: a, harness: test/cad, prompt: p, idle_timeout: 25h }\n`, 'idle_timeout is limited to 24h.'],
    ['$inputs in until_run', `  - { id: a, harness: test/cad, prompt: p, loop: { until_run: "test $inputs.x", max_iterations: 2 } }\n`, 'Use "$HARNESS_INPUT_X" in until_run'],
    ['an unknown HARNESS_INPUT in until_run', `  - { id: a, harness: test/cad, prompt: p, loop: { until_run: "test $HARNESS_INPUT_Y", max_iterations: 2 } }\n`, 'Unknown input: HARNESS_INPUT_Y'],
    ['a decision that is not declared', `  - { id: c, approval: { message: m, decisions: [{ id: ship }] } }\n  - { id: d, run: "true", depends_on: [c], when: "c.decision == rework" }\n`, 'when: c has no decision rework.'],
    ['a decision on an approval without decisions', `  - { id: c, approval: m }\n  - { id: d, run: "true", depends_on: [c], when: "c.decision == ship" }\n`, 'when: c has no decisions to compare.'],
    ['a decision on a shell step', `  - { id: c, run: "true" }\n  - { id: d, run: "true", depends_on: [c], when: "c.decision == ship" }\n`, 'when: c has no decisions to compare.'],
    ['a verdict of an approval', `  - { id: c, approval: m }\n  - { id: d, run: "true", depends_on: [c], when: "c.verdict.ready == true" }\n`, 'when: c writes no verdict.'],
    ['a verdict of a cancel step', `  - { id: c, cancel: m }\n  - { id: d, run: "true", depends_on: [c], when: "c.verdict.errors > 0" }\n`, 'when: c writes no verdict.'],
    ['a duplicate decision id', `  - { id: c, approval: { message: m, decisions: [{ id: ship }, { id: ship }] } }\n`, 'approval.decisions: duplicate id ship.'],
    ['a glob into .harness/loop/', `  - { id: a, harness: test/cad, prompt: p, outputs: { files: [".harness/loop/1.stdout.log"] } }\n`, 'outputs cannot name .harness/loop/, the loop check logs.'],
    ['a syntax error in when', `  - { id: a, run: "true" }\n  - { id: b, run: "true", depends_on: [a], when: "a.state" }\n`, 'when: Write one comparison'],
    ['a malformed duration', `  - { id: a, run: "true", timeout: 5d }\n`, 'a duration looks like 90s, 45m or 2h'],
    ['a malformed decision id', `  - { id: c, approval: { message: m, decisions: [{ id: Ship }] } }\n`, 'a decision id looks like ship or needs-work'],
    ['an unknown trigger rule', `  - { id: a, run: "true", trigger_rule: any }\n`, 'trigger_rule'],
  ])('rejects %s', (_name, tasks, expected) => { expect(errors(tasks)).toContain(expected) })
  it.each(['./.harness/loop/1.log', '.harness/loop', '.harness/loop/**', './././.harness/loop/x'])('refuses an outputs glob into the loop logs: %s', glob => {
    expect(errors(`  - { id: a, harness: test/cad, prompt: p, outputs: { files: ["${glob}"] } }\n`)).toContain('outputs cannot name .harness/loop/, the loop check logs.')
  })
  it('accepts a folder whose name only starts like the loop logs', () => {
    expect(compileTasks(`  - { id: a, harness: test/cad, prompt: p, outputs: { files: [".harness/loopy/x"] }, timeout: 1h }\n`).tasks).toHaveLength(1)
  })
  it('warns about agent tasks without outputs or timeout, but not about loops', () => {
    expect(compileTasks(`  - { id: a, harness: test/cad, prompt: p }\n`).warnings).toEqual(['Task a has neither outputs nor timeout; it finishes only when its worker calls finish or fail.'])
    expect(compileTasks(`  - { id: a, harness: test/cad, prompt: p, loop: { until_run: "true", max_iterations: 2 }, timeout: 1h }\n`).warnings).toEqual([])
    expect(compileTasks(`  - { id: a, harness: test/cad, prompt: p, loop: { until_run: "true", max_iterations: 2 }, idle_timeout: 1h }\n`).warnings).toEqual([])
  })
  it('publishes four task kinds in the schema', () => {
    const items = (flowJsonSchema() as { properties: { tasks: { items: { oneOf: unknown[] } } } }).properties.tasks.items
    expect(items.oneOf).toHaveLength(4)
  })
})

describe('published flow schema', () => {
  it('matches the runtime validator', () => {
    const file = JSON.parse(readFileSync(new URL('../../../store/spec/schema/flow.schema.json', import.meta.url), 'utf8'))
    const { $id, title, ...rest } = file
    expect($id).toBe('https://harness.autonomous.ai/dsh/spec/1/flow.schema.json')
    expect(title).toBe('Orchestrator flow (.harness/flows/*.yaml), spec 1')
    expect(rest).toEqual(flowJsonSchema())
  })
  it('says a task is a shell step, an agent task, an approval or a cancel step', () => {
    const items = (flowJsonSchema() as { properties: { tasks: { items: Record<string, unknown> } } }).properties.tasks.items
    const not = (...keys: string[]) => ({ anyOf: keys.map(k => ({ required: [k] })) })
    expect(items.oneOf).toEqual([
      expect.objectContaining({ required: ['id', 'run'], not: not('harness', 'prompt', 'outputs', 'approval', 'cancel', 'loop', 'idle_timeout') }),
      expect.objectContaining({ required: ['id', 'harness', 'prompt'], not: not('run', 'approval', 'cancel') }),
      expect.objectContaining({ required: ['id', 'approval'], not: not('run', 'harness', 'prompt', 'outputs', 'retry', 'cancel', 'loop', 'idle_timeout') }),
      expect.objectContaining({ required: ['id', 'cancel'], not: not('run', 'harness', 'prompt', 'outputs', 'retry', 'timeout', 'approval', 'loop', 'idle_timeout') }),
    ])
  })
  it.each([
    ['no action', '{ id: a }', 'A task has exactly one of run, harness + prompt, approval or cancel.'],
    ['run with agent fields', '{ id: a, run: "true", harness: engine:claude, prompt: p }', 'A task has exactly one of run, harness + prompt, approval or cancel.'],
    ['a harness without a prompt', '{ id: a, harness: engine:claude }', 'A task has exactly one of run, harness + prompt, approval or cancel.'],
    ['run with outputs', '{ id: a, run: "true", outputs: { files: [x] } }', 'outputs apply to agent tasks'],
  ])('rejects a task with %s, as the schema does', (_name, item, expected) => {
    expect(issues(() => compile(`spec: 1\nname: x\ntasks: [${item}]\n`))).toContain(expected)
  })
})
