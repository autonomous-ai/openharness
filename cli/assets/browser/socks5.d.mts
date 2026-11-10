import type { Duplex } from 'node:stream'

/** socks5.mjs: the SOCKS5 handshake with username and password, sending the host name, never a resolved address. */
export function socks5Connect(socket: Duplex, target: { host: string; port: number; username: string; password: string }): Promise<void>
