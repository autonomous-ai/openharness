# Feature reach for the Store and model lists, counted when a person opens them

Status: approved in conversation on 2026-10-14 (approach A).

## Why

#1313 stopped counting feature reach (`*_installation_days`, `*_first_installations`,
`*_repeat_installation_days`) for the four reads the apps make on their own: `history`
(`agent_recent`), `history_page` (`session_tail`), `store_list` (`dsh_list`) and `model_list`
(`models_list`, `grid_models_list`). Their reliability counts stay. Since then the report cannot say how
many installations open the Store or a model list.

What starts each request:

| Action | Started by a person? |
|---|---|
| `history` | No. Search previews, task routing and the change-agent handoff read it. |
| `history_page` | No. Session activity labels and Community publishing read it. |
| `store_list` | Sometimes. Opening the Store does, but so do the Store's one-minute refresh, reconnects and the New Harness probes. |
| `model_list` | Sometimes. Opening the Models panel (desktop) or a model sheet (phone) does, but so does every surface that shows models. |

`history` and `history_page` stay reliability-only: no person's action stands behind them, and
`search` and `resume` already measure finding and reopening a conversation.

## Design

1. **Contract** (`cli/src/lib/productUsageContract.ts` = `backend/src/types/productUsage.ts`):
   `PRODUCT_USAGE_USER_OPENED_ACTIONS = ['store_list', 'model_list']`. The new metrics are
   `<action>_user_requests`, `<action>_user_installation_days`, `<action>_user_first_installations` and
   `<action>_user_repeat_installation_days`. They are new names because clients released before #1313 still
   send `store_list_installation_days` for every automatic read.
2. **App**: the request that opening the screen sends carries `userAction: true` in its payload.
   - Desktop: `AppNotifier.openStore` leaves a one-shot mark. The Store tab's first ask takes it
     (`takeStoreOpened`), so a Store tab restored at launch is not counted and no extra request is sent.
     Opening the Models panel asks this computer's `grid_models_list` (`markModelsOpened`), and the
     panel's own refresh joins that read.
   - Phone: a model sheet opening (new agent, change model, and Find's `:` models mode, which shares the
     change-model controller) asks the machine's `grid_models_list`. Desktop's ⌘P models mode and pane
     pickers are not marked, so desktop and phone reach are not directly comparable.
   - The Store's periodic refresh, reconnect probes, pickers and previews send no flag.
3. **Daemon**: `productUsageRequest` emits `<action>_user_requests` beside `<action>_requests` when the
   payload carries `userAction: true` and the action is user-opened. The gateway counts reach from that
   metric, once per installation per UTC day. It keeps its own `first` and `repeat` state, apart from
   the old automatic reach.
4. **Report**: `review.features` reads reach for `store_list` and `model_list` from the `_user_` metrics
   and adds `userRequests`. A count is a lower bound. Older apps and daemons send no flag. A flagged
   request that joins one already in flight loses its flag.

## Rollout

The backend schema is strict and rejects a report that holds a metric it does not know. So release the
backend before the CLI. The CLI and the apps can then ship in any order. An old daemon ignores the
payload field, and an app without the flag simply contributes no reach.

## Tests

- CLI `productUsageSignals.spec.ts`: a flagged `dsh_list`/`grid_models_list` emits `_user_requests`;
  an unflagged one and a flagged `agent_recent` or `session_tail` do not.
- CLI `gateway/productUsage.spec.ts`: `_user_requests` counts reach once a day with first/repeat;
  plain `store_list_requests` still counts none.
- Backend `dailyProductReview.test.ts`: reach for `store_list` comes only from the `_user_` metrics;
  `history` stays null.
- Desktop: after `openStore`, the Store tab's first `dsh_list` is flagged and its later asks are not. A
  restored tab takes no mark. Opening the Models panel sends a flagged `grid_models_list`.
- Phone: opening the model sheet sends a flagged `grid_models_list`.
