# Connected accounts

The user connects services once, in `harness connections`. Every agent running
as this user gets the same accounts. A connection on another computer does not
grant access here. Never copy tokens between machines, into chat or into
project files, and never read the files under
`~/.local/share/harness-os/connections`.

`harness connections list --json` lists this computer's connections. On the PC
OS, choose **Connections** from the browser's New Tab page, or open
`harness connections` when the user needs to connect or disconnect an account;
`harness connections connect CODE` does the same sign-in from a terminal.

## MCP tools (most services)

Connected services with an MCP server appear as MCP servers named by their code
(`linear`, `notion`, `canva`, `github`…) in Claude Code, Codex and OpenCode.
Their address is the local bridge (`http://127.0.0.1:51793/…`), which adds the
credential and renews it before it expires. Use their tools like any other.
An agent started before a connection was made sees it after it is restarted.

If a tool answers that the service needs to be connected again, ask the user to
reconnect it in `harness connections`. Do not try to sign in from the agent.

## REST calls (services signed in through the Harness account)

GitHub, Slack, Asana, HubSpot, PagerDuty, Google (Gmail, Calendar, Drive,
BigQuery) and Microsoft 365 are signed in through the Harness account. Besides
their MCP tools, their REST APIs can be called without seeing the token:

```sh
harness connections call CODE METHOD https://OFFICIAL-API-HOST/PATH
```

Options: `--query KEY=VALUE`, `--header NAME:VALUE`, `--json BODY` (or
`--json -` for stdin), `--data KEY=VALUE`, `--form KEY=VALUE`. Form uploads
use `KEY=@/path/to/file`. Normal agent approval rules apply. Connecting an
account is not approval to send messages, publish, delete or change
permissions. Ask when the requested action lacks authorization.

| Connection | Read-only starting request |
| --- | --- |
| github | `GET https://api.github.com/user` |
| slack | `GET https://slack.com/api/auth.test` |
| asana | `GET https://app.asana.com/api/1.0/users/me` |
| hubspot | `GET https://api.hubapi.com/crm/v3/objects/contacts?limit=10` |
| pagerduty | `GET https://api.pagerduty.com/users/me` |
| gmail | `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` |
| google_calendar | `GET https://www.googleapis.com/calendar/v3/users/me/calendarList` |
| google_drive | `GET https://www.googleapis.com/drive/v3/files` with `--query pageSize=10` |
| google_bigquery | `GET https://bigquery.googleapis.com/bigquery/v2/projects` |
| microsoft_365 | `GET https://graph.microsoft.com/v1.0/me` |

Check the exit code, response body and a read-back before reporting a write as
successful. A 401 means reconnect; a 403 can mean insufficient permissions;
rate limits and unavailable services are not empty results. Do not repeat a
write after a timeout: check whether it succeeded first.

`harness connections disconnect CODE` removes local access for future requests.
It does not revoke the account at its provider; use the provider's settings.
