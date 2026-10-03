import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { parseTabs } from './desk.js'

/** This address is independent of pane order, focus and which app is open. */
export const tabChannelId = (userId: string, tabId: string): string =>
  createHash('sha256').update(JSON.stringify([userId, tabId])).digest('hex').slice(0, 24)

export async function readTabChannelSettings(userId: string) {
  const row = await prisma.tabChannelSettings.findUnique({ where: { id: tabChannelId(userId, 'settings') } })
  if (row && row.userId !== userId) throw new Error('Channel settings identity mismatch')
  return { enabled: row?.enabled === true, revision: row?.revision ?? 0 }
}

export async function setTabChannelSettings(userId: string, enabled: boolean) {
  const id = tabChannelId(userId, 'settings')
  const data = { enabled, revision: { increment: 1 } }
  let row
  try {
    row = await prisma.tabChannelSettings.upsert({ where: { id },
      create: { id, userId, enabled, revision: 1 }, update: data })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    row = await prisma.tabChannelSettings.update({ where: { id }, data })
  }
  return { enabled: row.enabled, revision: row.revision }
}

export async function readTabChannels(userId: string) {
  const settings = await readTabChannelSettings(userId)
  // Reading the experiment while OFF never registers a host or touches the desk.
  if (!settings.enabled) return { enabled: false, settingsRevision: settings.revision, revision: 0, tabs: [] }
  const [desk, machines] = await Promise.all([
    prisma.desk.findUnique({ where: { userId } }),
    prisma.machine.findMany({ where: { userId }, select: { machineId: true } }),
  ])
  const owned = new Set(machines.map(m => m.machineId))
  const tabs = await Promise.all(parseTabs(desk?.tabs).map(async tab => {
    // Shared observation panes are not participants, even when shown beside
    // owned agents. Runtime discovery on each host filters ordinary shells.
    const panes = tab.panes.filter(p => owned.has(p.machineId))
    const id = tabChannelId(userId, tab.id)
    let channel = await prisma.tabChannel.findUnique({ where: { id } })
    if (!channel && panes.length) {
      try {
        channel = await prisma.tabChannel.create({ data: { id, userId, tabId: tab.id, hostMachineId: panes[0].machineId } })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        channel = await prisma.tabChannel.findUnique({ where: { id } })
        if (!channel) throw error
      }
    }
    if (channel && (channel.userId !== userId || channel.tabId !== tab.id)) throw new Error('Channel routing identity mismatch')
    return { ...tab, panes, ...(channel ? { channelHost: channel.hostMachineId } : {}) }
  }))
  return { enabled: true, settingsRevision: settings.revision, revision: desk?.revision ?? 0, tabs }
}
