import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

export const experimentalFeatures = ['focus_bar_creature', 'share_button', 'devices_tab'] as const
export type ExperimentalFeature = typeof experimentalFeatures[number]
export const experimentalSettingsId = (userId: string): string =>
  createHash('sha256').update(JSON.stringify(['experimental-settings', userId])).digest('hex').slice(0, 24)

const snapshot = (row: { focusBarCreature: boolean; shareButton: boolean; devicesTab?: boolean; revision: number } | null) => ({
  revision: row?.revision ?? 0,
  features: { focus_bar_creature: row?.focusBarCreature === true, share_button: row?.shareButton === true, devices_tab: row?.devicesTab === true },
})

/** Reading never opts an account in or imports an installation's unscoped preferences. */
export async function readExperimentalSettings(userId: string) {
  const row = await prisma.experimentalSettings.findUnique({ where: { id: experimentalSettingsId(userId) } })
  if (row && row.userId !== userId) throw new Error('Experimental settings identity mismatch')
  return snapshot(row)
}

/** Change one field atomically so two machines editing different switches keep both choices. */
export async function setExperimentalSetting(userId: string, feature: ExperimentalFeature, enabled: boolean) {
  const id = experimentalSettingsId(userId)
  const field = { focus_bar_creature: 'focusBarCreature', share_button: 'shareButton', devices_tab: 'devicesTab' }[feature]
  const data = { [field]: enabled, revision: { increment: 1 } }
  let row
  try {
    row = await prisma.experimentalSettings.upsert({ where: { id },
      create: { id, userId, focusBarCreature: false, shareButton: false, devicesTab: false, [field]: enabled, revision: 1 },
      update: data })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    row = await prisma.experimentalSettings.update({ where: { id }, data })
  }
  return snapshot(row)
}
