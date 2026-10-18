import { env } from '../config/env.js'
import { logger } from '../utils/logger.js'
import { prisma } from './prisma.js'

export const communityReportReasons = ['spam', 'harassment', 'sexual', 'violence', 'private_information', 'harmful_code', 'other'] as const
export const communityReportTargets = ['harness', 'comment'] as const
export type ReportTarget = typeof communityReportTargets[number]

/** Reports from this many readers hide a publication or comment from everyone until a review. */
export const hideAfterReports = 3

/**
 * The ids of [targetType] a reader is not shown: whatever reports have hidden from everyone, and
 * whatever they reported themselves (hidden from them at once). [harnessId] narrows to one harness's.
 */
export async function hiddenFrom(autonomousEnv: string, targetType: ReportTarget, userId?: string, harnessId?: string): Promise<string[]> {
  const scope = { autonomousEnv, targetType, ...(harnessId ? { harnessId } : {}) }
  const [hidden, reported] = await Promise.all([
    prisma.communityHidden.findMany({ where: { ...scope, restoredAt: null }, select: { targetId: true } }),
    userId ? prisma.communityReport.findMany({ where: { ...scope, userId }, select: { targetId: true } }) : [],
  ])
  return [...new Set([...hidden, ...reported].map(row => row.targetId))]
}

/** Whether one publication or comment is hidden from this reader. */
export async function isHiddenFrom(autonomousEnv: string, targetType: ReportTarget, targetId: string, userId?: string): Promise<boolean> {
  const [hidden, reported] = await Promise.all([
    prisma.communityHidden.findFirst({ where: { autonomousEnv, targetType, targetId, restoredAt: null }, select: { id: true } }),
    userId ? prisma.communityReport.findFirst({ where: { autonomousEnv, targetType, targetId, userId }, select: { id: true } }) : null,
  ])
  return !!hidden || !!reported
}

/** Tells the reviewers' Slack, when one is set: what was hidden and where to review it, never its words. */
async function tellReviewers(targetType: ReportTarget, targetId: string): Promise<void> {
  if (!env.COMMUNITY_REPORTS_WEBHOOK_URL) return
  try {
    await fetch(env.COMMUNITY_REPORTS_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ text: `Harness Hub: a ${targetType} (${targetId}) was hidden after ${hideAfterReports} reports. Review it at https://harness.autonomous.ai/hub/reports` }),
    })
  } catch (err) {
    logger.warn('community report alert failed', { targetType, targetId, error: String(err) })
  }
}

type Report = { autonomousEnv: string; targetType: ReportTarget; targetId: string; harnessId: string; userId: string; reason: string }

/**
 * Files one reader's report (a second report of the same one by them changes nothing) and hides it
 * from everyone once [hideAfterReports] readers have reported it since its last review.
 */
export async function fileReport(report: Report): Promise<void> {
  try {
    await prisma.communityReport.create({ data: report })
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return
    throw error
  }
  const { autonomousEnv, targetType, targetId, harnessId } = report
  const key = { autonomousEnv, targetType, targetId }
  const reviewed = await prisma.communityHidden.findUnique({ where: { autonomousEnv_targetType_targetId: key } })
  if (reviewed && !reviewed.restoredAt) return
  const since = reviewed?.restoredAt ? { createdAt: { gt: reviewed.restoredAt } } : {}
  if (await prisma.communityReport.count({ where: { ...key, ...since } }) < hideAfterReports) return
  await prisma.communityHidden.upsert({ where: { autonomousEnv_targetType_targetId: key }, create: { ...key, harnessId }, update: { restoredAt: null, createdAt: new Date() } })
  logger.info('community target hidden after reports', key)
  await tellReviewers(targetType, targetId)
}
