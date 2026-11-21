/** The line said of an agent `removeOrphanMovePanes` could not free, each time something would start its engine. */
export function moveHeldLine(agentId: string): string {
  return `[terminal] move ${agentId}: held until the next start: a pane its stopped move left was not confirmed closed`
}
