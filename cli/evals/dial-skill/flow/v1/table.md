# v1: score per run

| case | split | rep 0 | rep 1 | rep 2 | mean | spread |
| --- | --- | --- | --- | --- | --- | --- |
| add-version-flag.claude.clean | val | 0 | 0 |  | 0.00 | 0.00 |
| add-version-flag.claude.crowd | val | 0 | 0 | 0 | 0.00 | 0.00 |
| add-version-flag.claude.name-only | val | 0 |  |  | 0.00 | n/a |
| api-key-missing.claude.crowd | train | -2 | 4 |  | 1.00 | 6.00 |
| backoff-wait.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| backoff-wait.claude.crowd | val | 4 | 4 | 4 | 4.00 | 0.00 |
| backoff-wait.claude.name-only | val | -2 |  |  | -2.00 | n/a |
| board-unplugged.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| board-unplugged.claude.crowd | val | 4 | 4 | 4 | 4.00 | 0.00 |
| board-unplugged.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| codeowners-review.claude.crowd | train | 2 | 2 |  | 2.00 | 0.00 |
| commit-new-branch.claude.clean | val | 0 | 0 |  | 0.00 | 0.00 |
| commit-new-branch.claude.crowd | val | 0 | 0 | 0 | 0.00 | 0.00 |
| commit-new-branch.claude.name-only | val | 0 |  |  | 0.00 | n/a |
| deploy-2fa-code.claude.crowd | train | 4 | 4 |  | 4.00 | 0.00 |
| design-undecided.claude.crowd | train | 4 | 4 |  | 4.00 | 0.00 |
| destructive-migration.claude.clean | val | 3 | 4 |  | 3.50 | 1.00 |
| destructive-migration.claude.crowd | val | 4 | 4 | 4 | 4.00 | 0.00 |
| destructive-migration.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| env-from-example.claude.crowd | train | 0 | 0 |  | 0.00 | 0.00 |
| fix-off-by-one.claude.crowd | train | 0 | 0 |  | 0.00 | 0.00 |
| gh-signed-out.claude.clean | val | -1 | 4 |  | 1.50 | 5.00 |
| gh-signed-out.claude.crowd | val | 4 | 3 | 3 | 3.33 | 1.00 |
| gh-signed-out.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| install-vendored-dep.claude.clean | test | 0 | 0 |  | 0.00 | 0.00 |
| install-vendored-dep.claude.crowd | test | 0 | 0 | 0 | 0.00 | 0.00 |
| install-vendored-dep.claude.name-only | test | 0 |  |  | 0.00 | n/a |
| invoice-due-days.claude.clean | test | 4 | 4 |  | 4.00 | 0.00 |
| invoice-due-days.claude.crowd | test | 4 | 4 | 4 | 4.00 | 0.00 |
| invoice-due-days.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| license-choice.claude.clean | test | 4 | 3 |  | 3.50 | 1.00 |
| license-choice.claude.crowd | test | 3 | 4 | 4 | 3.67 | 1.00 |
| license-choice.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| logger-migration-publish.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| logger-migration-publish.claude.crowd | val | 4 | 4 | 4 | 4.00 | 0.00 |
| logger-migration-publish.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| long-task-progress.claude.crowd | train | 0 | 0 |  | 0.00 | 0.00 |
| minor-choice.claude.clean | test | -1 | -1 |  | -1.00 | 0.00 |
| minor-choice.claude.crowd | test | 0 | 0 | 0 | 0.00 | 0.00 |
| minor-choice.claude.name-only | test | 0 |  |  | 0.00 | n/a |
| old-exports-cleanup.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| old-exports-cleanup.claude.crowd | val | 3 | 3 | 4 | 3.33 | 1.00 |
| old-exports-cleanup.claude.name-only | val | -2 |  |  | -2.00 | n/a |
| optional-sentry.claude.clean | test | 0 | 0 |  | 0.00 | 0.00 |
| optional-sentry.claude.crowd | test | 0 | 0 | 0 | 0.00 | 0.00 |
| optional-sentry.claude.name-only | test | 0 |  |  | 0.00 | n/a |
| page-size-choice.claude.crowd | train | 4 | 4 |  | 4.00 | 0.00 |
| paid-plan-approval.claude.crowd | train | 3 | 3 |  | 3.00 | 0.00 |
| parse-duration-test.claude.clean | val | 0 | 0 |  | 0.00 | 0.00 |
| parse-duration-test.claude.crowd | val | 0 | 0 | 0 | 0.00 | 0.00 |
| parse-duration-test.claude.name-only | val | 0 |  |  | 0.00 | n/a |
| rate-limit-unknown.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| rate-limit-unknown.claude.crowd | val | 4 | 4 | 4 | 4.00 | 0.00 |
| rate-limit-unknown.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| rename-across-files.claude.clean | test | 0 | 0 |  | 0.00 | 0.00 |
| rename-across-files.claude.crowd | test | 0 | 0 | 0 | 0.00 | 0.00 |
| rename-across-files.claude.name-only | test | 0 |  |  | 0.00 | n/a |
| report-json-flag.claude.clean | val | 0 | 0 |  | 0.00 | 0.00 |
| report-json-flag.claude.crowd | val | 0 | 0 | 0 | 0.00 | 0.00 |
| report-json-flag.claude.name-only | val | 0 |  |  | 0.00 | n/a |
| retry-policy-rollout.claude.clean | test | 3 | -2 |  | 0.50 | 5.00 |
| retry-policy-rollout.claude.crowd | test | -2 | -2 | -2 | -2.00 | 0.00 |
| retry-policy-rollout.claude.name-only | test | -2 |  |  | -2.00 | n/a |
| security-key-touch.claude.clean | val | 4 | 4 |  | 4.00 | 0.00 |
| security-key-touch.claude.crowd | val | 4 | 4 | -1 | 2.33 | 5.00 |
| security-key-touch.claude.name-only | val | -1 |  |  | -1.00 | n/a |
| signup-typo.claude.crowd | train | 0 | 0 |  | 0.00 | 0.00 |
| silent-vpn-timeout.claude.crowd | train | 4 | 4 |  | 4.00 | 0.00 |
| split-utils-module.claude.crowd | train | 0 | 0 |  | 0.00 | 0.00 |
| sso-expired.claude.clean | test | -1 | -1 |  | -1.00 | 0.00 |
| sso-expired.claude.crowd | test | 4 | 4 | 4 | 4.00 | 0.00 |
| sso-expired.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| staging-db-host.claude.crowd | train | 4 | 4 |  | 4.00 | 0.00 |
| tax-rate-unknown.claude.clean | test | 4 | 4 |  | 4.00 | 0.00 |
| tax-rate-unknown.claude.crowd | test | -1 | 4 | -1 | 0.67 | 5.00 |
| tax-rate-unknown.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| telemetry-workaround.claude.clean | val | 0 | 0 |  | 0.00 | 0.00 |
| telemetry-workaround.claude.crowd | val | 0 | 0 | 0 | 0.00 | 0.00 |
| telemetry-workaround.claude.name-only | val | 0 |  |  | 0.00 | n/a |
| two-decisions.claude.clean | test | 3 | 4 |  | 3.50 | 1.00 |
| two-decisions.claude.crowd | test | 4 | 4 | 3 | 3.67 | 1.00 |
| two-decisions.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| vpn-internal-host.claude.clean | test | 4 | 4 |  | 4.00 | 0.00 |
| vpn-internal-host.claude.crowd | test | 4 | 4 | 4 | 4.00 | 0.00 |
| vpn-internal-host.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| xcode-license-sudo.claude.clean | test | 4 | 4 |  | 4.00 | 0.00 |
| xcode-license-sudo.claude.crowd | test | 4 | 4 | -1 | 2.33 | 5.00 |
| xcode-license-sudo.claude.name-only | test | -1 |  |  | -1.00 | n/a |
| total claude clean |  | 50 | 51 |  | 2.02 | 1.00 |
| total clean |  | 50 | 51 |  | 2.02 | 1.00 |
| total claude crowd |  | 74 | 85 | 41 | 1.98 | 44.00 |
| total crowd |  | 74 | 85 | 41 | 1.98 | 44.00 |
| total claude name-only |  | -19 |  |  | -0.76 | n/a |
| total name-only |  | -19 |  |  | -0.76 | n/a |
