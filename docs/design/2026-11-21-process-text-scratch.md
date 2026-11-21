# Bounded process-text copy storage

## Design

V35 still holds Close and Resume against the original baseline. V12 profiles
nominate process-row parsing, and Resume still requests full censuses. Each
returned identity field must own its text: borrowing ps substrings previously
retained whole snapshots. UTF-8 and JSON scalar replacements regressed Unicode;
joining a whole row regressed large arguments. Those experiments stay rejected.

Use one private 8 KiB UTF-16 scratch buffer for synchronous copies of fields that
fit. Each decode creates the independently owned string before another field
writes the buffer. Larger fields use the original Buffer roundtrip. No process
facts, completed rows or strings are cached. Parser, selection, identity,
command-path validation, native requests and all authority checks stay unchanged.

- Growth and deletion: exactly 8 KiB per loaded module, never resized, reclaimed
  with that module/process. No new collection, file or dependency. Large inputs
  have the existing allocation cost and native output limit.
- Concurrency: a copy contains no await or application callback. JavaScript
  serializes the write and decode on its thread. Worker modules own separate
  buffers. Returned immutable strings must not alias reusable byte storage.
- Read cost and scale: avoid creating a Buffer for every small field. Raw direct
  copy probes nominate this only; ASCII/astral and large-Unicode results were
  inconclusive. Require actual-reader comparisons including full callers and
  large inputs. No production performance claim from helper numbers.
- Compatibility: UTF-16 preserves every code unit, including unpaired
  surrogates. No public protocol or storage changes. Reverting restores the
  previous copy implementation without migration.
- Audience and identity: no additional inputs, access, signals, logs or content
  exposure. Existing immutable identities still own each field. No new trust
  decision or optional feature policy enters core.
- Failure: parsing and native failures keep their current behavior. The scratch
  capacity is checked in bytes; no truncated copy may become identity evidence.
- Platforms: platform-independent Node Buffer behavior; native POSIX reader
  checks remain required. Windows source is unchanged; native Windows remains
  user-deferred. Mobile is outside this work.

Checks chosen before implementation: actual parser resource RED (no new Buffer
per small field); exact Unicode and capacity boundary controls; old-row stability
after buffer reuse; existing whole-snapshot and actual-reader heap controls;
admission tests observe decoded field copies rather than Buffer allocation;
affected tests/types, independent review, native private-child proof, and fixed
reader costs before a production comparison. All original holds remain open.
