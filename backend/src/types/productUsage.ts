import { HEALTH_FLOWS, PRODUCT_HEALTH_METRICS, type ProductUsageContext } from './productHealthContract.js'
/** Fixed vocabulary only. Keep the CLI copy identical; conformance is tested. */
export const PRODUCT_USAGE_VERSION = 1
export const PRODUCT_USAGE_DAYS = 35
export const PRODUCT_USAGE_MAX_COUNT = 100_000
export const PRODUCT_FEEDBACK_REASONS = ['useful', 'could_not_finish', 'slow', 'confusing', 'missing_feature'] as const
export const PRODUCT_FEEDBACK_OUTCOMES = ['completed', 'partly_completed', 'not_completed'] as const
export const PRODUCT_FEEDBACK = [...PRODUCT_FEEDBACK_REASONS, ...PRODUCT_FEEDBACK_OUTCOMES] as const
export const PRODUCT_USAGE_ACTIONS = ['create', 'resume', 'restart', 'model_change', 'history',
  'fork', 'close', 'delete', 'search', 'history_page', 'store_list', 'store_install', 'store_update', 'store_remove',
  'model_list', 'model_download', 'model_start', 'model_stop', 'browser_open'] as const
/** Reads the apps make on their own (an agent's recent turns after each update, the Store and model
 * lists on connect, picker previews): measured for reliability, never as a feature someone used. */
export const PRODUCT_USAGE_AUTOMATIC_ACTIONS: readonly typeof PRODUCT_USAGE_ACTIONS[number][] = ['history', 'history_page', 'store_list', 'model_list']
export const PRODUCT_USAGE_FEATURE_MEASURES = ['installation_days', 'first_installations', 'repeat_installation_days'] as const
/** Of those, the lists a person also opens (the Store, a model list): the request that opening sends
 * carries `userAction: true`, and only it counts their reach, under its own `_user_` names, because
 * clients released before the split still send the plain names for every automatic read. */
export const PRODUCT_USAGE_USER_OPENED_ACTIONS = ['store_list', 'model_list'] as const satisfies typeof PRODUCT_USAGE_AUTOMATIC_ACTIONS
export const PRODUCT_USAGE_SURFACES = ['desktop', 'phone', 'web'] as const
/** hn counts its flows through its own daemon (`product_observe`), signed in only: it has the UI
 * names but no signed-out setup channel, so it is not one of the setup surfaces above. */
export const PRODUCT_USAGE_UI_SURFACES = [...PRODUCT_USAGE_SURFACES, 'tui'] as const
/** Flows that can finish before an account exists, so a signed-out report may carry them. The
 * sign_in_<method> flows split the phone's welcome screen by the button used; sign_in stays the total. */
export const PRODUCT_USAGE_SETUP_FLOWS = ['setup', 'setup_harness', 'setup_tmux', 'setup_clipboard', 'sign_in',
  'sign_in_scan', 'sign_in_google', 'sign_in_apple', 'sign_in_email'] as const
/** Phone onboarding after sign-in: waiting for a computer, opening its session, the first message
 * sent there and the notification prompt that follows. Counts and duration buckets only. */
export const PRODUCT_USAGE_ONBOARDING_FLOWS = ['computer_wait', 'session_open', 'first_message', 'notify_permission'] as const
/** Onboarding steps that can take hours (setting the computer up, the first message): the flow
 * buckets stop at over_1m, so these also split that bucket. */
export const PRODUCT_USAGE_LONG_FLOWS = ['computer_wait', 'first_message'] as const
export const PRODUCT_USAGE_LONG_MEASURES = ['1m_to_5m', '5m_to_15m', '15m_to_1h', 'over_1h'] as const
/** What happened on the way through a phone onboarding step, at most once per step per sign-in.
 * `resumed`: the step started in an app run that did not sign in (reopened mid-step), so it is not a
 * new person; the rest are the step's own ways out or walls. The sign_in marks are counted with a
 * sign-in that went through: `retried`, an attempt before it in this app run failed or was
 * cancelled; `switched`, it used another button than the first one tried; `new_account`, the account
 * was created by this sign-in (minutes old: its first Harness sign-in anywhere), not one coming back.
 * `computer_wait_joined_after_leaving`: the computer the wait was for turned up after the app had left
 * that screen, which ends the wait in no `ok` of its own (16–19 October 2026: 5 `ok` in 49 fresh waits,
 * while 91% of the phone's people had a computer on the same account those days). */
export const PRODUCT_USAGE_ONBOARDING_MARKS = ['ui_phone_sign_in_retried', 'ui_phone_sign_in_switched',
  'ui_phone_sign_in_new_account',
  // The steps after a sign-in that made its account: started (counted) and ended `ok` there, so the new
  // people's funnel reads apart from everyone signing in again (mobile/lib/measurement/onboarding_measurement.dart).
  'ui_phone_computer_wait_new_account', 'ui_phone_computer_wait_new_account_ok',
  'ui_phone_session_open_new_account', 'ui_phone_session_open_new_account_ok',
  'ui_phone_first_message_new_account', 'ui_phone_first_message_new_account_ok',
  'ui_phone_computer_wait_resumed', 'ui_phone_computer_wait_not_you',
  'ui_phone_computer_wait_link_shared', 'ui_phone_computer_wait_joined_after_leaving',
  'ui_phone_session_open_resumed', 'ui_phone_session_open_blocked_password',
  'ui_phone_session_open_blocked_offline', 'ui_phone_first_message_resumed'] as const
export const PRODUCT_USAGE_ONBOARDING_METRICS = [...PRODUCT_USAGE_ONBOARDING_MARKS,
  ...PRODUCT_USAGE_LONG_FLOWS.flatMap(flow => PRODUCT_USAGE_LONG_MEASURES.map(measure => `ui_phone_${flow}_${measure}` as const)),
] as const
/** Why a phone launch's computers had not answered yet (mobile/lib/measurement/launch_measurement.dart,
 * `LaunchWait`), each at most once per launch beside its `app_start`: the account's list had no computer,
 * could not be read, or said every one was offline; a computer wanted this phone's password; a dial to a
 * computer said to be online failed; or a minute passed on screen with none answering. On 2026-10-19 21 of
 * 44 launches ended in no outcome at all, which said none of this. */
export const PRODUCT_USAGE_PHONE_LAUNCH_MARKS = ['ui_phone_app_start_no_computer', 'ui_phone_app_start_list_failed',
  'ui_phone_app_start_offline', 'ui_phone_app_start_locked', 'ui_phone_app_start_connect_failed',
  'ui_phone_app_start_waited_1m'] as const
/** The phone's two side pages, counted each time one opens and by how: a sideways swipe on the
 * terminal (Find from the left, Computers from the right), or a button (Computers' row in Settings,
 * its link on a long wait at home). Find's key and screen-reader actions are not counted. Which page
 * and which way, nothing else. */
export const PRODUCT_USAGE_PHONE_SCREENS = ['find', 'computers'] as const
export const PRODUCT_USAGE_SCREEN_OPENINGS = ['swipe', 'button'] as const
export const PRODUCT_USAGE_PHONE_SCREEN_METRICS = PRODUCT_USAGE_PHONE_SCREENS.flatMap(screen =>
  PRODUCT_USAGE_SCREEN_OPENINGS.map(opening => `ui_phone_screen_${screen}_${opening}` as const))
/** Desktop's Add Phone card (desktop/lib/widgets/phone_offer_card.dart), offered once per computer: started
 * when it is on screen, ok for its Add Phone, cancelled for its ×, unknown when it goes another way (Add Phone
 * opened from elsewhere, a sign-out). It waits beside the work, so it has no 15-minute observation bound.
 * Vocabulary 3 (`x-harness-usage-vocabulary`, cli/src/lib/appProductUsageReport.ts), like the openings below.
 * `phone_offer_after_work` is the same card offered once to a computer that never showed it (a computer that
 * opened signed in was marked offered without it), after one of its own harnesses finished a turn; vocabulary 4.
 * `phone_offer_away_waited` / `_finished`: the card for a person back after five minutes or more away, to a harness
 * that waited on them or finished meanwhile; vocabulary 4. docs/design/2026-10-20-desktop-phone-conversion.md. */
export const PRODUCT_USAGE_DESKTOP_FLOWS = ['phone_offer', 'phone_offer_after_work', 'phone_offer_away_waited',
  'phone_offer_away_finished', 'share_invite', 'share_accept'] as const
/** Each time Add Phone opens on a computer, by its way in: that card (`offer`), the title bar's phone, Harness ▸
 * Add Phone… (`menu`, or a key bound to it on macOS), the account menu, the Machines picker, or the command
 * (`> add phone`, a key bound to it elsewhere). Which way in, nothing else. */
export const PRODUCT_USAGE_ADD_PHONE_OPENINGS = ['offer', 'titlebar', 'menu', 'account', 'machines', 'command'] as const
export const PRODUCT_USAGE_ADD_PHONE_METRICS = PRODUCT_USAGE_ADD_PHONE_OPENINGS.map(opening => `ui_desktop_add_phone_${opening}` as const)
export const PRODUCT_USAGE_FLOWS = [...PRODUCT_USAGE_SETUP_FLOWS,
  'workspace_connect', 'computer_link', 'remote_connect', 'viewer_open', 'update_check', 'update_stage',
  ...HEALTH_FLOWS, ...PRODUCT_USAGE_ONBOARDING_FLOWS, ...PRODUCT_USAGE_DESKTOP_FLOWS] as const
export const PRODUCT_USAGE_FLOW_MEASURES = ['started', 'ok', 'failed', 'cancelled', 'unknown',
  'under_1s', '1s_to_10s', '10s_to_1m', 'over_1m'] as const
export const PRODUCT_USAGE_UI_METRICS = PRODUCT_USAGE_UI_SURFACES.flatMap(surface =>
  PRODUCT_USAGE_FLOWS.flatMap(flow => PRODUCT_USAGE_FLOW_MEASURES.map(measure => `ui_${surface}_${flow}_${measure}` as const)))
export const PRODUCT_USAGE_SETUP_DOWNLOADS = ['opencode', 'codex', 'claude'] as const
export const PRODUCT_USAGE_SETUP_DOWNLOAD_MEASURES = ['started', 'ok', 'failed', 'under_1m', '1m_to_5m', 'over_5m'] as const
// A signed-out report is explicitly enabled on this app. It cannot carry account/work metrics.
export const PRODUCT_USAGE_SETUP_METRICS = [...PRODUCT_USAGE_SURFACES.flatMap(surface =>
  PRODUCT_USAGE_SETUP_FLOWS.flatMap(flow =>
    PRODUCT_USAGE_FLOW_MEASURES.map(measure => `setup_${surface}_${flow}_${measure}` as const))),
  ...(['funnel_setup_seen', 'funnel_sign_in_seen', 'funnel_workspace_ready', 'funnel_first_work', 'funnel_first_response',
    'first_work_under_1m', 'first_work_1m_to_5m', 'first_work_over_5m',
    'first_response_under_1m', 'first_response_1m_to_5m', 'first_response_over_5m'] as const).map(m => `setup_desktop_${m}` as const),
  // A step's tool was not installed yet when Desktop checked, so setup installed it: once per step per
  // setup, beside the step's own outcome. Signed-out only (a signed-in report passes an older CLI).
  ...(['setup_harness', 'setup_tmux', 'setup_clipboard'] as const).map(flow => `setup_desktop_${flow}_missing` as const),
  // The agents a new computer downloads beside setup (desktop/lib/bootstrap/agent_prefetch.dart): whether each
  // download put its agent in place, and how long it took. Engine names only, never a path or log line.
  ...PRODUCT_USAGE_SETUP_DOWNLOADS.flatMap(engine => PRODUCT_USAGE_SETUP_DOWNLOAD_MEASURES
    .map(measure => `setup_desktop_agent_download_${engine}_${measure}` as const)),
  // The phone's first launch after an install, once (a local flag, never sent): the step between a store's
  // download and a sign-in, which nothing else counts. Signed in already at that launch, it is `ui_phone_first_open`.
  'setup_phone_first_open',
] as const
/** A new-harness, create or resume refusal outside the four fixed kinds (setup, auth, unavailable,
 * invalid), by its code: the daemon's own fixed error names, lower-cased. On 2026-10-16 production counted
 * 23 of 25 launch failures, 22 create refusals and 9 resume refusals as `other`, with nothing to say
 * which. `unlisted` is a code not named here, `none` a refusal that named no code; each family adds up to
 * its `_other` total, and the late failures to `launch_late_failed`. A delete or restart refusal is counted
 * by its code whatever its kind, so those two families add up to `delete_failed` and `restart_failed`: on
 * 2026-10-19 the phone's 3 delete refusals were `other` and its 2 restart refusals `setup`, a kind of nine
 * codes (listed below). Codes only, never a message. */
export const LAUNCH_ERROR_CODES = [
  // What a new harness asked for, refused before anything starts (core/agents/launches.ts, lib/engineLaunch.ts).
  'invalid_codex_home', 'invalid_prompt', 'prompt_too_long', 'prompt_unsupported', 'invalid_agent', 'invalid_session',
  'invalid_started_by', 'agent_unsupported', 'invalid_runtime_profile', 'grid_engine_unsupported', 'codex_cli_too_old',
  'invalid_launch_model', 'launch_model_unsupported',
  // A new project's folder (lib/projectFolder.ts) and the launch's durable receipt (lib/agentCreationReceipt.ts).
  'project_exists', 'invalid_repository', 'clone_failed', 'clone_timeout', 'git_unavailable', 'project_preparation_failed',
  'git_project_unavailable', 'branch_exists', 'invalid_branch', 'branch_switch_failed', 'branch_in_use', 'worktree_failed',
  'creation_conflict', 'creation_storage_failed', 'launch_authority_changed', 'internal',
  // The engine itself: preparing it (engines/nativeLaunch.ts) and its start (core/agents/newPane.ts).
  'engine_cannot_run', 'engine_install_failed', 'engine_did_not_start', 'engine_not_installed', 'start_timeout',
  'engine_launch_refused',
  // A Store harness (core/agents/dshThrough.ts, services/storeLaunch.ts).
  'dsh_not_installed', 'dsh_unavailable', 'dsh_runtime_failed',
  // A conversation Harness did not start, opened in it (core/agents/adopt.ts, externalResume.ts, lib/registry.ts).
  'core_not_ready', 'search_unavailable', 'session_in_harness', 'session_not_found', 'session_archived', 'session_folder_gone',
  'session_open_elsewhere', 'session_busy_in_terminal', 'session_open_in_terminal', 'session_changed', 'resume_session_mismatch',
  // A cloud agent (cloud/).
  'not_connected', 'cloud_failed', 'rate_limited', 'unreachable', 'busy', 'invalid_request', 'connections_unavailable',
  // A harness that exists: resumed, restarted, changed, closed or deleted (lib/resumeAgentService.ts, core/agents/).
  'missing_agent_id', 'delete_in_progress', 'agent_busy', 'agent_not_found', 'agent_changed', 'resume_failed', 'resume_unavailable',
  'resume_preparation_failed', 'grid_credential_required', 'permission_change_requires_stop', 'identity_unavailable',
  'restart_failed', 'restart_unsupported_backend', 'retarget_unsupported_backend', 'fork_on_grid_unsupported',
  'no_active_process', 'opencode_sqlite_missing', 'unavailable', 'missing_name', 'missing_update',
  'invalid_close_request', 'invalid_delete_request', 'close_failed', 'delete_failed',
  // A Stop (`agent_delete`) the machine could not confirm, or whose harness changed while it saved
  // (lib/stopAgentService.ts): 3 of the phone's 4 stops on 2026-10-19 were refused as `other`, the kind it falls under.
  'stop_unconfirmed',
  // A guest on a machine shared with it (core/guestPolicy.ts, core/agents/guestCreate.ts, services/guestLaunches.ts).
  'guest_not_allowed', 'guest_unsupported', 'guest_harness', 'guest_unavailable', 'guest_helper_required',
  'guest_engine_unsupported', 'guest_relay_failed', 'guest_folder_unavailable', 'guest_invalid', 'guest_helper_missing',
  'guest_helper_not_authorized', 'guest_helper_failed',
  // The `setup` kind's own codes, named for a delete or restart refusal (cli/src/lib/productUsageSignals.ts).
  'tmux_unavailable', 'pty_host_unavailable', 'tmux_too_old_for_dsh', 'tmux_too_old_for_grid', 'engine_unavailable', 'native_launch_held',
  'dsh_materialize_failed', 'spawn_failed', 'registration_failed', 'grid_config_failed',
  'unlisted', 'none',
] as const
export type LaunchErrorCode = typeof LAUNCH_ERROR_CODES[number]
/** The families counted by code: a launch's failure, its start failing after it was created, the create
 * and resume requests' `other` refusals, and every delete and restart refusal — from any client, and again,
 * apart, those the phone asked for (`phone_`), which a daemon's report otherwise carries mixed with the
 * Desktop's, the TUI's and tools'. Setup reasons have their own families, adding up to `launch_failed_setup`,
 * `create_error_setup` and `request_phone_create_error_setup`; existing `other` families keep their meaning. */
export const LAUNCH_ERROR_FAMILIES = ['launch_failed_code', 'launch_late_failed_code', 'create_error_code', 'resume_error_code',
  'delete_error_code', 'restart_error_code', 'phone_delete_error_code', 'phone_restart_error_code',
  'launch_failed_setup_code', 'create_error_setup_code', 'phone_create_error_setup_code'] as const
/** The engine an installation's first launch asked for; any other engine is `other`. */
export const PRODUCT_USAGE_LAUNCH_ENGINES = ['opencode', 'claude', 'codex', 'other'] as const
export type ProductUsageLaunchEngine = typeof PRODUCT_USAGE_LAUNCH_ENGINES[number]
/** Whether that engine had a credential on this computer, by presence only (cli/src/lib/engineAccount.ts). */
export const PRODUCT_USAGE_ENGINE_ACCOUNTS = ['signed_in', 'signed_out', 'unknown'] as const
export const PRODUCT_USAGE_LAUNCH_METRICS = [
  ...LAUNCH_ERROR_FAMILIES.flatMap(family => LAUNCH_ERROR_CODES.map(code => `${family}_${code}` as const)),
  ...PRODUCT_USAGE_LAUNCH_ENGINES.map(engine => `first_launch_engine_${engine}` as const),
  ...(['claude', 'codex'] as const).flatMap(engine => PRODUCT_USAGE_ENGINE_ACCOUNTS.map(account => `first_launch_${engine}_${account}` as const)),
] as const
export const PRODUCT_USAGE_ACTION_MEASURES = ['requests', 'ok', 'failed', 'pending', 'unknown',
  'error_setup', 'error_auth', 'error_unavailable', 'error_invalid', 'error_other',
  'under_1s', '1s_to_10s', '10s_to_1m', 'over_1m'] as const
export const PRODUCT_USAGE_METRICS = [
  ...PRODUCT_HEALTH_METRICS,
  'active_installation_days', 'working_installation_days', 'first_work_installations',
  'repeat_work_installation_days', 'weekly_working_installations', 'weekly_returning_installations',
  'monthly_working_installations', 'monthly_returning_installations', 'reactivated_after_7d_installations',
  'measurement_v2_installation_days', 'measurement_queue_pruned', 'turn_observation_overflow',
  'turns_started', 'turns_ended', 'turns_interrupted',
  'duration_under_10s', 'duration_10s_to_1m', 'duration_1m_to_5m', 'duration_over_5m',
  'desktop_opens', 'tui_opens',
  'launch_started', 'launch_created', 'launch_failed', 'launch_cancelled', 'launch_unconfirmed', 'launch_unobserved',
  // A created launch whose engine then did not start: one of the launch_created, never also a launch_failed.
  'launch_late_failed',
  'launch_wait_install', 'launch_wait_model', 'launch_wait_native', 'launch_wait_other',
  'launch_failed_setup', 'launch_failed_auth', 'launch_failed_unavailable', 'launch_failed_invalid', 'launch_failed_other',
  'launch_under_10s', 'launch_10s_to_1m', 'launch_1m_to_5m', 'launch_over_5m',
  'turns_with_response', 'turns_with_error', 'turns_ended_without_response', 'turns_waiting_over_1m',
  'response_under_10s', 'response_10s_to_1m', 'response_1m_to_5m', 'response_over_5m',
  'first_launch_installations', 'first_launch_work_24h_installations', 'first_launch_response_24h_installations',
  'first_response_installations', 'd1_returning_work_installations', 'd7_returning_work_installations', 'd28_returning_work_installations',
  ...PRODUCT_USAGE_LAUNCH_METRICS,
  ...PRODUCT_FEEDBACK.map(answer => `feedback_${answer}` as const),
  ...PRODUCT_USAGE_ACTIONS.flatMap(action => PRODUCT_USAGE_ACTION_MEASURES.map(measure => `${action}_${measure}` as const)),
  ...PRODUCT_USAGE_ACTIONS.flatMap(action => PRODUCT_USAGE_FEATURE_MEASURES.map(measure => `${action}_${measure}` as const)),
  ...PRODUCT_USAGE_USER_OPENED_ACTIONS.flatMap(action => (['requests', ...PRODUCT_USAGE_FEATURE_MEASURES] as const)
    .map(measure => `${action}_user_${measure}` as const)),
  ...PRODUCT_USAGE_UI_METRICS,
  ...PRODUCT_USAGE_ONBOARDING_METRICS,
  ...PRODUCT_USAGE_PHONE_LAUNCH_MARKS,
  ...PRODUCT_USAGE_PHONE_SCREEN_METRICS,
  ...PRODUCT_USAGE_ADD_PHONE_METRICS,
  'ui_phone_first_open',
  // Written by the backend itself: a report that named counters this backend does not know yet, which
  // it kept without them (routes/productUsage.ts). One per report, never the names.
  'health_cli_report_unknown_metric', 'health_desktop_report_unknown_metric', 'health_phone_report_unknown_metric',
] as const
export type ProductUsageMetric = typeof PRODUCT_USAGE_METRICS[number]
export interface ProductUsageReport {
  schemaVersion: 1
  context?: ProductUsageContext
  revision: number
  id: string
  day: string
  counters: Partial<Record<ProductUsageMetric, number>>
}
export interface ProductUsageChoice { enabled: boolean; revision: number }
