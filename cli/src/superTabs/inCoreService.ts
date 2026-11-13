/**
 * The Super Tab service itself, for a core that runs it in its own process: the door the core takes only while the Swarm
 * is on and its service is not in a process of its own (`HARNESSD_SERVICES=none`, or a list without it; core/main.ts).
 * By default the master runs the service (services/superTabsProcess.ts), and the core loads none of this: the Swarm's
 * side of the core is superTabs/inCore.ts, which holds no service code (src/architecture.spec.ts).
 */
export { startSuperTabs } from '../services/superTabs.js'
