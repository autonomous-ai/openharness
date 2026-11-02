# PM switch: fixes from the two security reviews

**Goal:** the switch of #2527, #2528 and #2529 works for real, tells the machine owner, cannot leave no working PM, says only what
is true, and spends another person's account only after that person offered it and while they keep offering it.

**Architecture:** no new flow. The backend gives the host the chat id and keeps the requester through the rebind. The host checks
every account's sign-in before closing, and reports a post-close failure only when the old PM is back. Offers move to their own
file, apart from linked folders. Desktop gets one dialog to offer and withdraw.

## Backend (#2527)
1. Test: the real host row has the PM's chat. Add `ledConversationId`. `leadsConversationId` stays null, because an older host reads
   it as a delivery filter (cli `host.ts`).
2. Test: rebind, then result, tells the machine owner. `switchLanded` keeps `requestedBy`.
3. Test (integration): a quiet owner's Buddy chat takes the second notice; no second chat. `moreNamed` loads it.
4. Test: a failure report after the rebind reads as moved; `down` says the PM has not come back.

## CLI (#2528)
5. Test: the prompt is built from the recorded host row. Read `ledConversationId`.
6. Test: a signed-out default account is refused before the close, outside Team.
7. Tests: after the close, a refused, timed-out or held create posts nothing until the rebind (ok) or the old PM's return past the
   hold (failed), or the end of the adoption window (`down`). This covers both "back on <engine>" findings; polling the creation
   status is not needed, as the rebind reads the daemon's receipts itself.
8. Test: a new request inside an old switch's window is carried out. The change id comes from the request id, so a record names
   its own switch.
9. Test: a fork keeps `claudeHome`.
10. Tests: `lib/accountOffers.ts` and `swarm_account_offer`. Linked and Harness-made folders are not offered (Codex links made in
    New Harness were about to be offered too); a withdraw ends it; a damaged file offers nothing; the owner alone may ask.

## Desktop (#2529)
11. Tests: picking a "Not offered to the Swarm" row runs the pane on it and sends no offer.
12. Tests: "Swarm accounts…" lists this computer's accounts, offers only after the sentence saying who can spend it, withdraws, and
    survives a refusal or an older CLI. Add Claude account says it stays private until offered.

## Not done here
No live switch on this project's PM. Withdrawing does not move a PM already on that account: the dialog says so.
