# Runtime profile removal: former-code baseline

Recorded from main `e130ad8e1`, before any runtime implementation change, under
`TZ=UTC TMPDIR=/tmp`. The existing other-engine matrix was re-recorded against
its current spec strings: imports and unavailable-engine regressions added since
the original recording expand the pane and config inputs. Only the twelve pane
and four config hashes change; all transcript, catalog and switch hashes stay
identical. The complete matrix contains 482 cases. This commit freezes the new
inputs and answers before moving code; the move must keep the fixtures unchanged.

`runtimeProfileState.golden.spec.ts` additionally records public state/control
answers: registry seeds, malformed input, staged hydration, selected profiles,
confirmation, duplicate control, cancellation, waiter timeouts, forget, change
notifications, gateway restrictions and unbound identity. It exercises all
fourteen engines plus the supervised composition without pilot readers. Darwin
and Linux produce identical answers. The earlier matrix pins Linux; both replace
engine homes and commands, and neither uses a host engine executable. No emitted
value depends on a host Node or tmux path.

Both golden files recorded successfully: 18 tests in two files. Verification of
the frozen fixtures, deliberate wiring mutations, the required coverage gates and
isolated runtime e2e lanes follows the implementation. The six unreachable pane
drivers remain, as the owner decided.
