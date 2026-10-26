/** Who a Swarm agent's commits and pull requests say the work is for, and which agent and machine did it. The machine
 *  writes the trailers into each commit message (cli/src/superTabs/githubTools.ts); the line opens the pull request body. */
export interface Attribution {
  requestedBy: { name: string; email: string }
  agent: string
  machine: string | null
  trailers: string[]
  pullRequestLine: string
}

/** One line of plain text: no control characters, and no angle brackets, which would end an address in a trailer. */
const plain = (text: string, max = 100) => text.replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()

export function attribution(input: { requester: { name: string | null; email: string }; agentName: string; machineName: string | null }): Attribution {
  const email = plain(input.requester.email, 254).replace(/\s/g, '')
  const name = plain(input.requester.name ?? '') || plain(email.split('@')[0] ?? '') || email
  const agent = plain(input.agentName) || 'Agent'
  const machine = input.machineName ? plain(input.machineName) || null : null
  return {
    requestedBy: { name, email }, agent, machine,
    trailers: [`Co-authored-by: ${name} <${email}>`, `Harness-Agent: ${agent}`, ...(machine ? [`Harness-Machine: ${machine}`] : [])],
    pullRequestLine: `Requested by ${name} (${email}) through Harness.`,
  }
}
