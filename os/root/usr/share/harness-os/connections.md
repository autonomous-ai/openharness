# Connected accounts

Use `harness connections list --json` to discover accounts on this computer.
Every agent running as this user reads the same connection store. A connection
on another computer does not grant access here. Do not copy tokens between
machines or into agent configuration.

On the PC OS, open a browser tab and choose **Connections**, or use
`harness connections` when the user needs to connect or disconnect an
account. Secrets belong in that local form, never in chat, shell arguments or
project files. Read `harness connections info CODE` for account identity,
reported permissions and expiry. Unknown permissions are not unlimited access.

Call the connected service with:

```sh
harness connections call CODE METHOD https://OFFICIAL-API-HOST/PATH
```

Options: `--query KEY=VALUE`, `--header NAME:VALUE`, `--json BODY` (or
`--json -` for stdin), `--data KEY=VALUE`, `--form KEY=VALUE`. Form uploads
use `KEY=@/path/to/file`. Name the connection; do not read its credential file
or construct authorization headers yourself. Normal agent approval rules apply.
Connecting an account is not approval to send messages, publish, delete or
change permissions. Ask when the requested action lacks authorization.

Read the service's current API reference when an endpoint or schema is unknown.
Check the command exit code, response body and a read-back before reporting a
write as successful. GraphQL can return errors with HTTP 200. A 401 means
reconnect; a 403 can mean insufficient permissions or inaccessible content;
rate limits and unavailable services are not empty results. Do not automatically
repeat a write after a timeout: check whether it succeeded first.

## Service entry points

| Connection | Read-only starting request | Notes |
| --- | --- | --- |
| github | `GET https://api.github.com/user` | Repositories: `GET /user/repos`; repository/organization access depends on the token. |
| notion | `GET https://api.notion.com/v1/users/me` | Search: `POST /v1/search` with `--json '{"page_size":10}'`. The helper defaults to Notion-Version 2022-06-28; set a version header explicitly when using a newer schema. |
| linear | `POST https://api.linear.app/graphql` with `--json '{"query":"{ viewer { id name } }"}'` | Read the `errors` array, not only the exit status. Personal keys and OAuth use different auth headers; the helper selects them. |
| asana | `GET https://app.asana.com/api/1.0/users/me` | Discover workspaces before projects/tasks. |
| figma | `GET https://api.figma.com/v1/me` | Requires current_user:read for the connection check. File access depends on the token's scopes. |
| gmail | `GET https://gmail.googleapis.com/gmail/v1/users/me/profile` | OAuth sign-in is not enabled in this build. Google app passwords do not work with this REST helper. |
| google_calendar | `GET https://www.googleapis.com/calendar/v3/users/me/calendarList` | Separate connection and permissions from Gmail. OAuth sign-in pending. |
| google_drive | `GET https://www.googleapis.com/drive/v3/files` with `--query pageSize=10` | Separate connection and permissions. OAuth sign-in pending. |
| facebook | `GET https://graph.facebook.com/me` | Connection setup pending. Page actions need the correct page token and permissions. |
| ahrefs | `GET https://api.ahrefs.com/v3/subscription-info/limits-and-usage` | Connection setup pending; API access depends on the service plan. |

Manual tokens can be connected for GitHub, Notion, Linear, Asana and Figma.
Browser sign-in and automatic renewal are not enabled in this build; expired
accounts must be reconnected. No Intern device, device key or hardware
registration is required. These tools are shared by agents running as the same
local user on an ordinary computer with Harness installed.

`harness connections disconnect CODE` removes local access for future requests.
An in-flight request cannot be recalled. This does not revoke the token at its
provider or remove it on other computers. Use the provider's settings for that.
