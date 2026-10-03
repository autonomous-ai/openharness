# Native Team verification — September 27, 2026

Status: **The complete Claude → Codex/Grok → Claude acceptance passed.** Grok's login was
renewed by the user before the full run. The fixture exited successfully and recorded
`passed: true` and `fullAcceptance: true`.

The approved test used disposable project directories, a separate tmux server, the actual
Claude Code 2.1.283, Codex 0.154.0, and Grok 1.0.34 binaries, the production session-input controller,
the production transcript normalizers, the real local daemon WebSocket, and durable Team
records. Claude was not given either peer project's contents. Each peer's `FACT.txt` held a
different new random string known to the test verifier.

| Evidence | Recorded value |
| --- | --- |
| Team | `7fda3704c78f71fd272019b8c482b945` |
| Question to Grok | `11111111111111111111111111111111` |
| Question to Codex | `22222222222222222222222222222222` |
| Asking member | Claude |
| Addressed members | Grok and Codex |
| Question text | What is the exact content of your FACT.txt? |
| Grok's explicit agent reply | `GROK_FACT_29d8f96797908344` |
| Codex's explicit agent reply | `CODEX_FACT_e85e3f8ae7796361` |
| Claude's `RESULT.txt` | Both exact values, one per line |
| Question states | Both `answered` |
| Question receipts | Both `received`; Grok read its inbox, Codex replied to the delivered question |
| Return receipts | Both `received` through Claude's `wait` commands |
| Introduction receipts | All three reached `started`; Grok and Claude later reached `received` |
| Observed Grok turns | 2 started, 2 ended |
| Observed Codex turns | 3 started, 3 ended |
| Observed Claude turns | 2 started; output written during the second turn |
| Fixture cleanup | Servers stopped; dedicated Grok socket and copied Codex/Grok authentication files absent |
| Full three-engine acceptance | `true` |

Each answer was attributed to the addressed agent and correlated with its original question.
Claude's observed tool calls asked both peers, waited for their correlated answers, then
used `printf` to write both values into `RESULT.txt` and read the result back. No tool call
read either peer's directory. This demonstrates continuation of the original task. The test
ended once that artifact and its corresponding explicit answers were verified; it did not
wait for Claude's final conversational response. No existing user session was connected or
restarted, and no release was deployed.

The local evidence bundle is at
`/private/var/folders/4c/lq3h60sn5l53hs3s21nzpqzw0000gn/T/harness-team-native-hxn1ml/evidence.json`.
The raw provider conversations remain in their disposable project/session locations. This
document intentionally contains no authentication tokens or membership keys.

Earlier diagnostic runs exposed a Codex empty-composer detection issue and Claude paste-envelope
attribution issue. Both were fixed with regression tests based on the observed terminal/transcript forms.
The complete Team/input/encryption regression run after those fixes passed 96 tests, and the
CLI plus native-test script passed typechecking. The full live run used both fixes: every
introduction was attributed to a matching native turn. The remaining manual UI and physical
remote-device verification limits are listed in [the operating guide](agent-teams.md#verification-status).

To reproduce the full run with authorized provider usage and working provider logins:

```sh
cd cli
HARNESS_TEAM_LIVE=1 npx tsx scripts/team-native-e2e.ts
```

The earlier two-engine diagnostic also passed, with evidence at
`/private/var/folders/4c/lq3h60sn5l53hs3s21nzpqzw0000gn/T/harness-team-native-Y2OPl4/evidence.json`.
`HARNESS_TEAM_ENGINES=codex,claude` selects that partial mode; its evidence reports
`fullAcceptance: false` and does not replace the complete three-engine gate.
