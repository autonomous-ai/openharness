import { expect, it } from 'vitest'
import { dailyProductReview } from './dailyProductReview.js'
const row = (day: string, metric: string, value: number) => ({ dayUtc: new Date(day), metric, value })

it('keeps today out of comparisons and marks sparse or absent baselines honestly', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'launch_created', 3), row('2026-10-12', 'launch_failed', 1),
    row('2026-10-12', 'launch_failed_setup', 1), row('2026-10-13', 'launch_failed', 999),
  ], new Date('2026-10-13T12:00:00Z'))
  expect(r.comparisons[0].current).toMatchObject({ numerator: 1, denominator: 4, percent: 25 })
  expect(r.comparisons[0].previous.percent).toBeNull()
  expect(r.comparisons[0].differencePercentagePoints).toBeNull()
  expect(r.comparisons[0].evidence).toContain('Sparse')
  expect(r.investigate[0]).toMatchObject({ area: 'Agent setup', count: 1 })
})

it('names the most frequent codes of unknown launch refusals and of engines that did not start after a create', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'launch_failed_other', 9), row('2026-10-12', 'launch_failed_code_invalid_prompt', 4),
    row('2026-10-11', 'launch_failed_code_invalid_prompt', 1), row('2026-10-12', 'launch_failed_code_unlisted', 2),
    ...['clone_failed', 'internal', 'busy', 'none'].map(code => row('2026-10-12', `launch_failed_code_${code}`, 1)),
    row('2026-10-12', 'launch_late_failed', 3), row('2026-10-12', 'launch_late_failed_code_start_timeout', 3),
    row('2026-10-12', 'launch_failed_code_PRIVATE_CANARY', 50),
  ], new Date('2026-10-13T12:00:00Z'))
  const unknown = r.investigate.find(s => s.area === 'Unknown launch refusal')
  expect(unknown).toMatchObject({ count: 9, codes: [{ code: 'invalid_prompt', count: 5 }, { code: 'unlisted', count: 2 },
    { code: 'busy', count: 1 }, { code: 'clone_failed', count: 1 }, { code: 'internal', count: 1 }] })
  expect(r.investigate.find(s => s.area === 'Engine did not start after create')).toMatchObject({ count: 3, codes: [{ code: 'start_timeout', count: 3 }] })
  expect(JSON.stringify(r)).not.toContain('PRIVATE_CANARY')
})

it('uses matured original working-day cohorts and refuses to interpret missing follow-up coverage as zero', () => {
  const r = dailyProductReview([
    row('2026-10-11', 'working_installation_days', 10), row('2026-10-11', 'd1_returning_work_installations', 6),
    row('2026-10-12', 'working_installation_days', 8),
    row('2026-10-04', 'working_installation_days', 12), row('2026-10-04', 'd7_returning_work_installations', 3),
    row('2026-10-05', 'working_installation_days', 7),
  ], new Date('2026-10-13'))
  expect(r.retention[0].cohorts.at(-1)).toMatchObject({ day: '2026-10-11', workingInstallations: 10, returned: 6, percent: 60 })
  expect(r.retention[1].cohorts.find(c => c.day === '2026-10-04')).toMatchObject({ percent: 25 })
  expect(r.retention[0].cohorts.find(c => c.day === '2026-10-05')?.percent).toBeNull()
  expect(r.retention[0].cohorts[0].percent).toBeNull()
})

it('reports voluntary feedback separately, never as a task success rate', () => {
  const r = dailyProductReview([row('2026-10-12', 'feedback_useful', 2), row('2026-10-12', 'feedback_slow', 1)], new Date('2026-10-13'))
  expect(r.feedback).toMatchObject({ useful: 2, slow: 1 })
  expect(r.comparisons.find(c => c.name.startsWith('Useful'))?.current.denominator).toBe(3)
  expect(r.gaps.join(' ')).toContain('self-selected')
  expect(r).not.toHaveProperty('taskSuccessRate')
})

it('compares first-launch installation cohorts only after every 24-hour window can mature', () => {
  const r = dailyProductReview([
    row('2026-10-11', 'first_launch_installations', 4), row('2026-10-11', 'first_launch_work_24h_installations', 3),
    row('2026-10-11', 'first_launch_response_24h_installations', 2), row('2026-10-12', 'first_launch_installations', 99),
  ], new Date('2026-10-13'))
  expect(r.firstLaunchCohorts.cohorts.at(-1)).toMatchObject({ day: '2026-10-11', firstLaunchInstallations: 4, workingWithin24h: 3, observedResponsePercent: 50 })
  expect(r.firstLaunchCohorts.cohorts.some(c => c.day === '2026-10-12')).toBe(false)
  expect(r.firstLaunchCohorts.cohorts[0].observedResponsePercent).toBeNull()
})

it('keeps feedback denominators and setup coverage separate from daemon participation', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'feedback_useful', 2), row('2026-10-12', 'feedback_completed', 3), row('2026-10-12', 'feedback_not_completed', 1),
    row('2026-10-12', 'setup_desktop_sign_in_started', 5), row('2026-10-12', 'setup_desktop_sign_in_ok', 2),
  ], new Date('2026-10-13'))
  expect(r.comparisons.find(c => c.name.startsWith('Useful'))?.current.denominator).toBe(2)
  expect(r.comparisons.find(c => c.name.startsWith('Completed'))?.current).toMatchObject({ denominator: 4, percent: 75 })
  expect(r.recent.observedDays).toBe(0)
  expect(r.flows.find(f => f.channel === 'setup' && f.surface === 'desktop' && f.flow === 'sign_in')).toMatchObject({ started: 5, unmatchedStarts: 3 })
  expect(r.flows.find(f => f.channel === 'ui' && f.flow === 'update_stage')?.started).toBeNull()
})
it('shows hn\'s app flows beside the other apps, with no signed-out setup row for it', () => {
  // hn counts a start when the flow begins and its outcome when it ends, as the Desktop does: one still
  // open (or ended under another account) is an unmatched start.
  const r = dailyProductReview([
    row('2026-10-12', 'ui_tui_workspace_connect_started', 4), row('2026-10-12', 'ui_tui_workspace_connect_ok', 3),
    row('2026-10-12', 'ui_tui_workspace_connect_under_1s', 3),
  ], new Date('2026-10-13'))
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'tui' && f.flow === 'workspace_connect'))
    .toMatchObject({ started: 4, unmatchedStarts: 1, outcomes: { ok: 3, failed: 0 }, durationBuckets: { under_1s: 3, over_1m: 0 } })
  expect(r.flows.some(f => f.channel === 'setup' && f.surface === 'tui')).toBe(false)
})
it('uses complete calendar months rather than adding daily installations into MAU', () => {
  const r = dailyProductReview([
    row('2026-08-12', 'monthly_working_installations', 10), row('2026-09-12', 'monthly_working_installations', 8),
    row('2026-09-12', 'monthly_returning_installations', 6), row('2026-10-12', 'monthly_returning_installations', 99),
  ], new Date('2026-10-13'))
  expect(r.monthlyRetention).toMatchObject({ from: '2026-09-01', untilExclusive: '2026-10-01', percent: 60 })
})

it('does not turn old collector work into zero D28 retention during rollout', () => {
  const rows = [row('2026-09-14', 'working_installation_days', 10), row('2026-10-12', 'working_installation_days', 8)]
  const cohort = (input: typeof rows) => dailyProductReview(input, new Date('2026-10-14')).retention[2].cohorts.find(c => c.day === '2026-09-14')
  expect(cohort(rows)).toMatchObject({ measurementAvailable: false, returned: null, percent: null })
  expect(cohort([...rows, row('2026-09-14', 'measurement_v2_installation_days', 10)]))
    .toMatchObject({ measurementAvailable: true, returned: 0, percent: 0 })
})

it('reports a read the apps make on their own as reliability only, even from clients that still send its reach', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'history_requests', 41179), row('2026-10-12', 'history_installation_days', 72),
    row('2026-10-12', 'history_first_installations', 72), row('2026-10-12', 'search_requests', 86),
    row('2026-10-12', 'search_installation_days', 19),
  ], new Date('2026-10-13'))
  expect(r.features.find(f => f.action === 'history')).toMatchObject({ requests: 41179, automatic: true,
    installationDays: null, firstMeasuredInstallations: null, repeatInstallationDays: null })
  expect(r.features.find(f => f.action === 'search')).toMatchObject({ automatic: false, installationDays: 19 })
})

it('reads Store and model-list reach only from the requests a person opened', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'store_list_requests', 1965), row('2026-10-12', 'store_list_installation_days', 22),
    row('2026-10-12', 'store_list_user_requests', 9), row('2026-10-12', 'store_list_user_installation_days', 4),
    row('2026-10-12', 'store_list_user_first_installations', 3), row('2026-10-12', 'store_list_user_repeat_installation_days', 1),
  ], new Date('2026-10-13'))
  expect(r.features.find(f => f.action === 'store_list')).toMatchObject({ requests: 1965, automatic: true, userRequests: 9,
    installationDays: 4, firstMeasuredInstallations: 3, repeatInstallationDays: 1 })
  expect(r.features.find(f => f.action === 'model_list')).toMatchObject({ userRequests: 0, installationDays: null })
  expect(r.features.find(f => f.action === 'history')).toMatchObject({ userRequests: null, installationDays: null })
})

it("splits the phone onboarding's long waits past a minute and shows what happened on the way", () => {
  const r = dailyProductReview([
    row('2026-10-12', 'ui_phone_computer_wait_started', 4), row('2026-10-12', 'ui_phone_computer_wait_ok', 2),
    row('2026-10-12', 'ui_phone_computer_wait_over_1m', 2), row('2026-10-12', 'ui_phone_computer_wait_15m_to_1h', 2),
    row('2026-10-12', 'ui_phone_computer_wait_resumed', 1), row('2026-10-12', 'ui_phone_computer_wait_not_you', 1),
    row('2026-10-12', 'ui_phone_session_open_blocked_password', 1),
  ], new Date('2026-10-13'))
  const wait = r.flows.find(f => f.channel === 'ui' && f.surface === 'phone' && f.flow === 'computer_wait')
  expect(wait).toMatchObject({ started: 4, unmatchedStarts: 2,
    over1mBuckets: { '1m_to_5m': 0, '15m_to_1h': 2 }, marks: { resumed: 1, not_you: 1, link_shared: 0 } })
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'phone' && f.flow === 'session_open'))
    .toMatchObject({ marks: { blocked_password: 1, blocked_offline: 0 } })
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'phone' && f.flow === 'session_open')).not.toHaveProperty('over1mBuckets')
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'desktop' && f.flow === 'computer_wait')).not.toHaveProperty('marks')
})

it('shows every way into Add Phone beside the Desktop\'s Add Phone card', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'ui_desktop_phone_offer_started', 3), row('2026-10-12', 'ui_desktop_phone_offer_ok', 1),
    row('2026-10-12', 'ui_desktop_phone_offer_cancelled', 1),
    row('2026-10-12', 'ui_desktop_add_phone_offer', 1), row('2026-10-12', 'ui_desktop_add_phone_titlebar', 4),
  ], new Date('2026-10-13'))
  // Started minus its outcomes: an app closed with the card still up.
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'desktop' && f.flow === 'phone_offer')).toMatchObject({
    started: 3, outcomes: { ok: 1, cancelled: 1, unknown: 0 }, unmatchedStarts: 1,
    addPhoneOpenings: { offer: 1, titlebar: 4, menu: 0, account: 0, machines: 0, command: 0 } })
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'phone' && f.flow === 'phone_offer')).not.toHaveProperty('addPhoneOpenings')
})

it('shows new phone pairings and skipped-card reasons only beside the Desktop card', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'ui_desktop_add_phone_paired_offer', 1),
    row('2026-10-12', 'ui_desktop_add_phone_paired_titlebar', 2),
    row('2026-10-12', 'ui_desktop_add_phone_paired_menu', 3),
    row('2026-10-12', 'ui_desktop_add_phone_paired_account', 4),
    row('2026-10-12', 'ui_desktop_add_phone_paired_machines', 5),
    row('2026-10-12', 'ui_desktop_add_phone_paired_command', 6),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_has_phone', 7),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_no_device_list', 8),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_already_shown', 9),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_stopped', 10),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_cap_reached', 11),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_not_signed_in', 12),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_viewer', 13),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_card_showing', 14),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_no_storage', 15),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_account_changed', 16),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_read_limit', 17),
  ], new Date('2026-10-13'))
  const card = r.flows.find(f => f.channel === 'ui' && f.surface === 'desktop' && f.flow === 'phone_offer')
  expect(card).toMatchObject({
    addPhonePaired: { offer: 1, titlebar: 2, menu: 3, account: 4, machines: 5, command: 6 },
    phoneOfferSkipped: { has_phone: 7, no_device_list: 8, already_shown: 9, stopped: 10, cap_reached: 11,
      not_signed_in: 12, viewer: 13, card_showing: 14, no_storage: 15, account_changed: 16, read_limit: 17 },
  })
  expect(r.flows.filter(f => 'addPhonePaired' in f)).toEqual([card])
  expect(r.flows.filter(f => 'phoneOfferSkipped' in f)).toEqual([card])
})

it('zero-fills absent pairing and skip counters and uses the existing complete seven-day window', () => {
  const r = dailyProductReview([
    row('2026-10-06', 'ui_desktop_add_phone_paired_command', 2),
    row('2026-10-12', 'ui_desktop_add_phone_paired_command', 3),
    row('2026-10-05', 'ui_desktop_add_phone_paired_offer', 999),
    row('2026-10-13', 'ui_desktop_add_phone_paired_offer', 999),
    row('2026-10-06', 'ui_desktop_phone_offer_skipped_has_phone', 4),
    row('2026-10-12', 'ui_desktop_phone_offer_skipped_has_phone', 5),
    row('2026-10-05', 'ui_desktop_phone_offer_skipped_stopped', 999),
    row('2026-10-13', 'ui_desktop_phone_offer_skipped_stopped', 999),
  ], new Date('2026-10-13'))
  expect(r.flows.find(f => f.channel === 'ui' && f.surface === 'desktop' && f.flow === 'phone_offer')).toMatchObject({
    addPhonePaired: { offer: 0, titlebar: 0, menu: 0, account: 0, machines: 0, command: 5 },
    phoneOfferSkipped: { has_phone: 9, no_device_list: 0, already_shown: 0, stopped: 0, cap_reached: 0,
      not_signed_in: 0, viewer: 0, card_showing: 0, no_storage: 0, account_changed: 0, read_limit: 0 },
  })
  const empty = dailyProductReview([], new Date('2026-10-13'))
  expect(empty.flows.find(f => f.channel === 'ui' && f.surface === 'desktop' && f.flow === 'phone_offer')).toMatchObject({
    addPhonePaired: { offer: 0, titlebar: 0, menu: 0, account: 0, machines: 0, command: 0 },
    phoneOfferSkipped: { has_phone: 0, no_device_list: 0, already_shown: 0, stopped: 0, cap_reached: 0,
      not_signed_in: 0, viewer: 0, card_showing: 0, no_storage: 0, account_changed: 0, read_limit: 0 },
  })
})

it('says why Desktop sign-ins that did not go through ended, beside the signed-out sign-in flow', () => {
  const r = dailyProductReview([
    row('2026-10-12', 'setup_desktop_sign_in_started', 6), row('2026-10-12', 'setup_desktop_sign_in_failed', 3),
    row('2026-10-12', 'setup_desktop_sign_in_reason_no_result', 2), row('2026-10-12', 'setup_desktop_sign_in_reason_cancelled', 1),
    row('2026-10-12', 'setup_desktop_sign_in_reason_timeout', 1), row('2026-10-11', 'setup_desktop_sign_in_reason_no_result', 1),
    row('2026-10-12', 'setup_desktop_sign_in_reason_PRIVATE_CANARY', 9),
  ], new Date('2026-10-13T12:00:00Z'))
  const signIn = r.flows.find(f => f.channel === 'setup' && f.surface === 'desktop' && f.flow === 'sign_in')
  expect(signIn).toMatchObject({ endReasons: { no_result: 3, cancelled: 1, timeout: 1, cli_unavailable: 0, other: 0 } })
  expect(r.flows.find(f => f.channel === 'setup' && f.surface === 'phone' && f.flow === 'sign_in')).not.toHaveProperty('endReasons')
  expect(r.flows.find(f => f.channel === 'setup' && f.surface === 'desktop' && f.flow === 'setup')).not.toHaveProperty('endReasons')
  expect(JSON.stringify(r)).not.toContain('PRIVATE_CANARY')
})
