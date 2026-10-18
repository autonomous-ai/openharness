# Share a machine

Status: implemented on `feat/share-machine` (2026-10-15).

## Experience

Today a computer can add only the machines signed in to the same account. Now a machine's owner can share
it, and the person it is shared with uses it as their own.

- **Off by default.** In the machine's details, **Share** opens the machine's sharing: email addresses, and
  **Everyone at @company.com**. The second is offered only when the owner's address is not at a public
  domain (gmail.com, outlook.com, icloud.com, Apple's private relay, …).
- **Shared with your email:** the machine appears in your Machines under **Shared with you** and connects
  on its own, like your own machines.
- **Shared with your domain:** the machine is listed in **Add machine** under **Shared with your team** and
  takes one click to add. Only colleagues who add it get it in their list, and only their machines are
  trusted by it. **Remove from my list** takes it back out.
- **Full owner rights.** A shared machine works exactly like one on your own account: its harnesses,
  terminals, new harnesses, models. Renaming it, removing it from the account, billing, its remote password
  and its sharing stay with its owner.
- Stopping sharing, or taking an address off, ends access at once.

Sign-in requires a verified email (confirmed with the SSO side), so an address or a domain names a person.

## How it works

- **Backend.** `MachineShare` holds a machine's policy (addresses, and the owner's domain when the domain is
  on) and `MachineShareAdd` the accounts that added a domain share. `lib/machineAccess.ts` decides who may use
  a machine; `machine_select` on `/api/web-ws` asks it instead of comparing owners, and drops a session when
  the policy stops allowing it. `GET /api/machines` lists the machines shared with you beside your own
  (`sharedMachines`), never with an API key. `routes/machineShares.ts` writes the policy, lists who may use
  a machine with their machines' keys, and adds or removes a domain share.
- **The shared machine's daemon decides.** The owner's policy is kept on the machine itself
  (`services/sharedMachines.ts`, `shared-machines.json`), as Share keeps its grants: the backend's word alone
  cannot grant access. The service reads who may use the machine, checks each address against its own
  policy, and has the gateway trust those accounts' machine keys.
- **The adding machine's daemon** pins the shared machine's key, so its windows connect through the relay
  as they do to their own machines.
- **Kept apart from the trust group.** Shared keys and pins are marked `shared` in `paired.json` and
  `machinePeers.json`. The trust group never exchanges rosters with them, never seeds them, and refuses a
  `group_sync` from them, so sharing one machine never makes a colleague's other machines trusted, or yours
  trusted by theirs. Removing a key rotates the group key, as an unpair does.
- **Daemon changes outside the service:** the gateway's `sharedTrust` call (`gateway/sharedTrust.ts`),
  the service's process and query link, and the trust-group filter. Nothing in the core's request switch.

## Out of scope

The phone app (later), invitation emails, and sharing a machine with only some of its harnesses (Share
already does that, view only).
