import { describe, expect, it } from 'vitest'
import { literalToolCall, literalToolCalls } from './literalToolCall.js'

describe('code-mode literal tool calls', () => {
  it.each([
    'text(await tools.exec_command({cmd: "cargo test", workdir: "/ship-hn"}));',
    "await tools.exec_command({cmd: 'cargo test', workdir: '/ship-hn',});",
    'const result = await tools.exec_command({cmd: `cargo test`, workdir: "/ship-hn", yield_time_ms: 1000}); text(result);',
    '// @exec: {"max_output_tokens":1000}\ntext(await tools.exec_command({"cmd":"cargo test","workdir":"/ship-hn"}));',
  ])('recognizes an unconditional call: %s', source => {
    expect(literalToolCall(source)).toMatchObject({ name: 'exec_command', input: { cmd: 'cargo test', workdir: '/ship-hn' } })
  })
  it.each([
    'if (false) text(await tools.exec_command({cmd:"pwd",workdir:"/fake"}));',
    'text(await tools.exec_command({cmd: command,workdir:"/fake"}));',
    'text(await tools.exec_command({cmd:`cd ${path}`,workdir:"/fake"}));',
    'text(await tools.exec_command({cmd:"pwd",workdir:"/real",workdir:"/fake"}));',
    'text(await tools.exec_command({cmd:"pwd",...overrides}));',
    'const result=await tools.exec_command({cmd:"pwd"}); text({result, another: tool()});',
    'text(await tools.exec_command({cmd:"pwd"})); text(await tools.exec_command({cmd:"pwd"}));',
    'text(await tools.exec_command({cmd:"pwd", workdir:(()=>"/fake")()}));',
  ])('leaves dynamic or conditional code unknown: %s', source => expect(literalToolCall(source)).toBeNull())
  it('does not interpret strings as source, properties, or prototype setters', () => {
    const parsed = literalToolCall('text(await tools.exec_command({cmd:"echo \\\"{workdir: \\\"/fake\\\"}\\\"", workdir:"/real", __proto__: {hidden:true}}));')
    expect(parsed?.input).toMatchObject({ workdir: '/real' })
    expect(Object.getPrototypeOf(parsed?.input)).toBeNull()
  })
})

describe('unconditional code-mode batches', () => {
  it('maps sequential receipts separately and parallel receipts to one group', () => {
    const source = `text(await tools.apply_patch("patch"));
      const results = await Promise.allSettled([
        tools.exec_command({cmd:"pwd",workdir:"/one"}),
        tools.exec_command({cmd:"pwd",workdir:"/two"}),
      ]); for(let i=0;i<results.length;i++) { text({i,...results[i]}); }
      text(await tools.write_stdin({session_id:14,chars:""}));`
    expect(literalToolCalls(source)?.map(({ name, group, output }) => ({ name, group, output }))).toEqual([
      { name: 'apply_patch', group: 1, output: { block: 0 } },
      { name: 'exec_command', group: 2, output: { block: 1, index: 0, settled: true } },
      { name: 'exec_command', group: 2, output: { block: 2, index: 1, settled: true } },
      { name: 'write_stdin', group: 3, output: { block: 3 } },
    ])
  })
  it.each([
    'if (false) text(await tools.exec_command({cmd:"pwd",workdir:"/fake"}));',
    'text("await tools.exec_command({cmd: \'pwd\'})");',
    'text(await tools.exec_command({cmd: dynamic, workdir:"/fake"}));',
    'const results=await Promise.allSettled([tools.exec_command({cmd:"pwd"})]); for(let i=0;i<results.length;i++) text({i,...results[0]});',
    'text(await tools.exec_command({cmd:"pwd"})); doSomethingElse();',
    'const results=await Promise.all([tools.exec_command({cmd:"pwd"})]); for(const result of results) { if(false) text(result); }',
    'text(await tools.exec_command({cmd:"pwd",...overrides}));',
  ])('rejects scripts whose execution/output cannot be established: %s', source => {
    expect(literalToolCalls(source)).toBeNull()
  })
  it('bounds a batch before reading its receipts', () => {
    expect(literalToolCalls('text(await tools.exec_command({cmd:"pwd"}));'.repeat(33))).toBeNull()
  })
})
