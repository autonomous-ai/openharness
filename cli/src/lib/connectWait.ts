import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

/**
 * How long each address of a host is tried before the next, for every connection this process opens, `fetch` included.
 * Node's 250 ms gave up on both of the backend's IPv4 addresses over a slow Wi-Fi (a ping of 324 ms on 2026-11-02),
 * and `fetch` failed with no reason but "fetch failed": about one call in ten on the Dell, the sign-in of a computer
 * set up from the phone two seconds after it joined the Wi-Fi (MSI, 2026-11-03), and the Swarm reads of Add your
 * computers. With 2 s, 0 in 60 failed on the same Wi-Fi. Imported first by each entry, before anything connects.
 */
export const CONNECT_ATTEMPT_MS = 2_000

setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS)
