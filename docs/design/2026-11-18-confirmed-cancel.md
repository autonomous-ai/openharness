# Confirm cancellation through the existing session request

## Design

A device Stop uses the same `cancel` request as the apps. A bounded nonempty `requestId` asks for
`cancel_result { requestId, ok }` after the original input owner confirms Ctrl-C. A request without an
id retains its existing one-way behavior and error presentation. Confirmation is not an engine turn-end
receipt: unknown dispatch, stale authority, transport loss and timeout never become success or a retry.

The core owns session cancellation, its immediate activity/normalizer/question cleanup, and terminal
input. It captures the actual local registration or authenticated remote owner and machine at request
admission, passes current authority through the session operation, and checks it before metadata effects,
terminal dispatch and reply. No request map, feature policy, component query or retained cancellation
catalog is added. Remote request sealing stays unchanged; replies are encrypted to the requester.

WiFi owns the bounded one-shot tool connection, exact machine handshake and exact type/id matching.
Its existing process-wide control-work budget (100 operations / 16 MiB) spans component rebuilds.
The component aborts its pending sockets on disconnect, resume and stop. A 15-second deadline covers
connect, handshake and confirmation; bounded 4 KiB replies are matched by exact type and id.
An unexpected frame or mismatched id invalidates and closes this one-shot connection; it is not ignored.
The owner-tool handshake negotiates question protocol 1 without an observation, suppressing legacy replay. A timeout settles unavailable,
closes the connection and retains capacity until physical close; no effect is replayed. The component's
verified machine/core binding is checked before send and after reply. The private `wifi.stop` door and
its fallbacks are removed together. The remaining create and mixed-host desk doors stay explicit.

Only target/request ids and the result cross this transport; no text, tokens or credentials are logged
or persisted. Errors use fixed names. Existing agent binding, physical connection and gateway owner
checks remain authority; a new connection alone is never permission to finish an old request.

## Validation

The original binding/state and legacy error microtask races were reproduced before their prerequisite
fix. The public request, caller cancellation and reply encryption tests fail on the old one-way door.
Selected source tests cover legacy compatibility, non-owner refusal, current-owner confirmation,
connection/machine/session replacement, bounded concurrent work, timeout and actual close. Packaging and
native checks are coordinated with the daemon-core integration; Windows validation is deferred by the
user, without changing its transport contract.

The unreleased worker contract remains 3. Stop was never a `SERVICE_HOSTS.queries` declaration, so its
removal alone does not change the derived plan and does not prove mixed executed artifacts are refused.
The final combined daemon artifact carries the separately reviewed engine capability/plan change; its
old/new plan refusal is verified at integration. This slice checks current admission and selected-file
drift without claiming a stronger standalone cohort boundary.

Source evidence on the extraction checkpoint: the public behavior RED had seven failures and one legacy
positive control; the component RED had two failures. The first seven-file run had 182 passes and one
Unix-listener fixture failure (`EPERM` under the sandbox), preserved separately. The escalated fixture
passed. The corrected selected gate has 340 core/service tests (six runtime files at 100%), 36 client
tests (the new client at 100%), and 352 caller/architecture/admission tests. Two additional real-key
gateway/plaintext-admission checks pass. The final input-owner coverage includes the already-revoked
caller control: cancellation methods have 55/55 statements, 34/34 branches and 10/10 functions covered;
this is changed-method coverage, not a claim that the existing input controller has whole-file 100%.
Types pass. Failed fixture/type/coverage receipts remain recorded; native packaging and cost acceptance
are still integration work.

The prepared packaged extension adds actual Stop to the existing supervised and inline WiFi cases:
a held turn, the engine's recorded C-c, its interrupted pane, a duplicate idempotency key that emits no
second interrupt, and a subsequent completed turn. It adds no cancel-route instrumentation or product
hook. Native execution remains pending the final combined artifact.
