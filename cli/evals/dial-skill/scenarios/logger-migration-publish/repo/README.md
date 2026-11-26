# acme-packages

The twelve small libraries the Acme apps share, one per folder in `packages/`. Each is published to the team registry
(https://registry.acme.invalid) as `@acme/<folder>`.

## Develop

    npm test

runs every package's tests with Node's test runner; nothing to install.

## Logging

Packages log through `lib/`. The old logger is being replaced: see MIGRATION.md.

## Publish

    pkgpub publish packages/<name>

publishes one package at the version in its `package.json`. A change that keeps a package's API goes out as a patch
release: bump the last number of its `version` before publishing.
