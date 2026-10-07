/** A test daemon starts its own supervisor; it must not inherit the host daemon's topology or token. */
export function daemonEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('HARNESSD_')))
  return { ...clean, ...own }
}
