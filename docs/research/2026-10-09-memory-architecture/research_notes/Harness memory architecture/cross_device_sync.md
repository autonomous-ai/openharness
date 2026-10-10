# Cross-device sync with end-to-end encryption for an agent memory store

Research as of 2026-10-09. Every factual claim has an inline source. Opinions and design conclusions are kept in the "Inferences" subsections and marked as such. Repository activity figures come from GitHub's `pushed_at` and release metadata read on 2026-10-09. `pushed_at` counts pushes to any branch, so it shows activity, not release quality.

## Case studies: how shipped personal-data sync systems work (Atuin, Obsidian Sync, Anytype/any-sync, 1Password, Bitwarden, Standard Notes, Apple, Signal, Syncthing, Letta MemFS, Tailscale, Keyhive)

### Takeaway
Atuin's v2 record store is the closest shipped analog for "many small immutable records on many machines, through a server that cannot read plaintext". Each host writes an append-only log per tag with a monotonic index. Sync diffs a `(host, tag) -> last idx` map and uploads or downloads the missing suffix. Deletes are new records. Each record has its own content key, wrapped by the account key, and its header is bound as authenticated data. Atuin also already syncs an `ai-session` record type. The password managers and Apple supply the key-hierarchy and device-enrolment patterns. Most of them document that removing a member or device is enforced by server policy, not cryptography, unless keys are rotated.

### Cited Findings

**Atuin (shell history sync; v2 "record store")**
- Atuin keeps history in an "encrypted, append-only **record store**", and sync exchanges records rather than copying database rows — [Atuin docs: store](https://docs.atuin.sh/main/reference/store/)
- Sync v2 became opt-in with Atuin v18 on 2024-02-05. All machines must run the same sync version, and mixed versions do not sync — [Atuin forum: sync v2](https://forum.atuin.sh/t/sync-v2-testing/124)
- `records.db` is an encrypted on-disk log. For history its records are `Create(History)` or `Delete(HistoryId)`, and the log is "built into" `history.db`, which powers search. Deletion is therefore a log entry, not a removal — [Atuin forum: sync v2](https://forum.atuin.sh/t/sync-v2-testing/124)
- In the source, a history delete record "simply refers to the history by ID". A code comment says per-record encryption was "most of the time a 200k-entry delete spent writing tombstones", which led to parallel encryption of batches — [atuin history/store.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/src/history/store.rs)
- Local table `store(id text primary key -- globally unique ID, idx integer -- incrementing integer ID unique per (host, tag), host, tag, timestamp, version, data blob, cek blob)` has a unique index on `(host, tag, idx)` — [atuin create-store migration](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/record-migrations/20231127090831_create-store.sql)
- The sync state is `RecordStatus { hosts: HashMap<HostId, HashMap<RecordTag, RecordIdx>> }`. `diff()` compares local and remote per `(host, tag)`. If the other side's idx is greater "we need to do some downloading. If it is smaller, then we need to do some uploading". Also, "hosts can only write to their own store" — [atuin record/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs)
- The record header `AdditionalData { id, idx, version, tag, host }` is serialized to JSON and used as the PASETO implicit assertion, so it is authenticated but not encrypted. The source warns: "Do *not* modify this struct... we rely on the serialization staying the same across versions" — [atuin record/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs)
- Each `(host, tag)` series resolves to `Upload`, `Download` or `Noop`. Current sync also ships records in "packfiles" (bundles of records) alongside paginated "loose" pages — [atuin record/sync/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/src/record/sync/mod.rs)
- Encryption is "PASETO v4 / PASERK envelope encryption": every record gets a random content encryption key (CEK), which the master key wraps. The design note says "Rotating a key is as simple as re-encrypting the CEK, and not the message contents" and plans for KMS/HSM wrapping — [atuin paseto_v4.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-common/src/encryption/paseto_v4.rs)
- The 2023 design post moved Atuin from NaCl secretbox to PASETO v4 local (XChaCha20) with PASERK key wrapping. Before that there was no key-upgrade path, so a leaked key meant creating a new account. Local data is "stored unencrypted on your local device in order to perform search queries" — [Atuin blog, 2023-07-07](https://blog.atuin.sh/new-encryption/)
- Store tooling:
  - `verify` checks that every record decrypts with the current key.
  - `purge` deletes undecryptable records locally only.
  - `rekey` re-encrypts the whole local store, and other machines then need the new key.
  - `rebuild` regenerates derived tables from records.
  - `push --force` clears the remote and re-uploads; `pull --force` wipes the local store and re-downloads.

  The docs mark these as potentially unrecoverable — [Atuin docs: store](https://docs.atuin.sh/main/reference/store/)
- Under v1, mixed encryption keys (from a mistyped key, or a machine running without login) broke sync, and the only fix was deleting the remote account. In v2, verify and purge fixed this for users — [Atuin forum: sync v2](https://forum.atuin.sh/t/sync-v2-testing/124)
- The record store now has an `ai-session` tag, and `rebuild` regenerates "the daemon's index of AI agent sessions" from session records — [Atuin docs: store](https://docs.atuin.sh/main/reference/store/)
- `secrets_filter` (default true) "matches history against a set of default regex, and will not save it if we get a match". The defaults cover AWS key IDs, GitHub PATs, Slack OAuth tokens and webhooks, and Stripe keys — [atuin default config.toml](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/config.toml)

**Obsidian Sync**
- Each remote vault uses one of two modes. End-to-end encryption is the default: "no one — not even the Obsidian team — can access your notes". In standard encryption, Obsidian holds the key. Data is encrypted with AES-256-GCM under a key derived with scrypt and a salt. The local vault is not encrypted — [Obsidian help: Sync security](https://obsidian.md/help/sync/security)
- Documented leakage:
  - The server sees "which device uploaded or deleted a file, when it was uploaded".
  - It sees the mapping from encrypted path to encrypted content.
  - File hashes are encrypted deterministically. A server that can force uploads could therefore confirm whether a file matches one the user uploaded before.

  — [Obsidian help: Sync security](https://obsidian.md/help/sync/security)
- If the E2EE password is lost, data "remains encrypted and unusable forever". Obsidian says it has been independently audited — [Obsidian help: Sync security](https://obsidian.md/help/sync/security)
- Conflicts:
  - Markdown files are merged with Google's diff-match-patch, which can "create duplicate text or formatting problems".
  - Other files use "last modified wins".
  - Settings JSON is merged key-by-key with local keys taking precedence.
  - Since Obsidian 1.9.7, a per-device option can create a "Conflicted copy" file instead of merging.

  — [Obsidian help: troubleshoot Sync](https://obsidian.md/help/sync/troubleshoot)

**Anytype / any-sync**
- Objects are stored encrypted, both locally and on sync nodes, using a layered key system with keys generated on the device. Backup nodes hold the first-layer key so they can group an object's changes for restore. They do not hold the second layer, so they "can't read the actual changes" — [Anytype docs: privacy and encryption](https://doc.anytype.io/anytype/data/privacy-and-encryption)
- any-sync stores data "as encrypted Directed Acyclic Graphs (DAGs)". Its CRDT mechanism cryptographically signs every change, and "Each device independently applies and cryptographically verifies CRDT updates". Files are stored externally (e.g. via IPFS) on a separate file node. A consensus node validates ACL changes. Users can switch providers without losing access — [any-sync README](https://github.com/anyproto/any-sync)

**1Password** (Security Design White Paper, release 0.5.2, 2026-03-05)
- Two-secret key derivation (2SKD) mixes the account password with a locally held Secret Key, so data stored on the server cannot be used for cracking attempts — [1Password white paper](https://agilebits.github.io/security-design/)
- New-device enrolment: an already enrolled client generates an add-device link "(possibly in the form of a QR code)" containing the team domain, email and Secret Key. The user adds the account password. The new client authenticates with SRP and then fetches its encrypted personal key set, whose symmetric key is encrypted with the Account Unlock Key — [1Password white paper: deeper look at keys](https://agilebits.github.io/security-design/deepKeys.html)
- Revocation: "Removing someone from a vault, group, or team isn't cryptographically enforced. Cryptographic keys are not changed." The server stops serving the data and tells well-behaved clients to delete keys and data. Someone who copied a vault key beforehand can decrypt future items if they obtain ciphertext. The documented mitigation is to create a new vault (with a new key) and move the items into it — [1Password white paper, Appendix A.4](https://agilebits.github.io/security-design/leopard.html); [1Password white paper: revoking access](https://agilebits.github.io/security-design/revoke-access.html)

**Bitwarden**
- The master password derives a Master Key: PBKDF2 with 600,000 iterations and the email as salt, or Argon2id. HKDF then gives a Stretched Master Key, which wraps a random 512-bit symmetric key (the "account encryption key"). Each item has a random 64-byte Cipher Key, wrapped by the user or organisation key — [Bitwarden security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/)
- "Log in with device": the new client makes a per-request key pair, and a trusted device encrypts the user key to its public key. "Trusted devices" keep a local Device Key, and the server stores the user key wrapped for that device — [Bitwarden security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/)
- Rotating the account key generates a new key, re-encrypts vault data by rewrapping each Cipher Key, and re-shares the key to trusted devices — [Bitwarden security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/)

**Standard Notes (protocol 004)**
- The password goes through Argon2id (64 MiB, 5 iterations), and the output is split into `masterKey` and `serverPassword`. Encryption is XChaCha20-Poly1305. Random "items keys" (not derived from the password) wrap a random key for each item, so a password change re-encrypts only the items keys. Old data is re-encrypted "progressively" or during idle time. The server is "a dumb data-store" — [Standard Notes encryption spec](https://standardnotes.com/help/security/encryption)

**Apple (iCloud Keychain, Advanced Data Protection)**
- Each device creates a P-384 "syncing identity". Devices keep a signed list of peer identities in CloudKit. A new device joins by being sponsored by an existing device, which vouches for it, or through iCloud Keychain recovery. Only items marked `kSecAttrSynchronizable` sync, so device-specific keys stay local. Conflicts: "one or the other is chosen, resulting in eventual consistency" — [Apple Platform Security: keychain syncing](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
- Escrow recovery uses HSM clusters that verify the iCloud security code with SRP. The code "isn't sent to Apple". "After the 10th failed attempt, the HSM cluster destroys the escrow record" — [Apple Platform Security: escrow](https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web)
- With ADP, trusted devices "retain sole access to the encryption keys". Keys held in Apple's HSMs are deleted ("immediate, permanent, and irrevocable") and service keys are rotated. The ADP setting is stored in keychain metadata "signed by device-local keys", which Apple cannot roll back. ADP requires a recovery contact or recovery key. Apple still sees modification dates and the checksums used for de-duplication — [Apple Platform Security: ADP](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web)

**Signal (linked devices)**
- The new device shows a QR code with a provisioning address and a Curve25519 public key. The primary device sends "shared keys, account information, and a one-time-use linking token" encrypted to that key. History moves as a compressed archive encrypted with a "one-time-use 256-bit AES key". Attachments are pointers "fetched on demand". Media older than 45 days cannot be synced because attachments are deleted 45 days after upload. Post dated 2025-01-27 — [Signal blog: synchronized start for linked devices](https://signal.org/blog/a-synchronized-start-for-linked-devices/)

**Syncthing (untrusted encrypted devices)**
- The folder key comes from scrypt over the password, salted with "syncthing" plus the folder ID. Names are encrypted deterministically with AES-SIV, per-file keys come from HKDF, and blocks use XChaCha20-Poly1305. The untrusted device cannot see data, names, mtimes or version vectors. It does see sizes (rounded) and which parts change and when. Metadata that fails to decrypt is a protocol error. The feature is labelled beta — [Syncthing spec: untrusted devices](https://docs.syncthing.net/specs/untrusted.html)

**Letta MemFS (git-based agent memory)**
- Memory is Markdown with YAML frontmatter in a per-agent git repository, and every memory edit is a commit. Cloud agents push to a Letta-hosted repo, while local-only agents commit to a repo on the machine. Background memory subagents use git worktrees to write concurrently. The page does not describe encryption, deletion, or how merge conflicts are resolved — [Letta docs: MemFS](https://docs.letta.com/letta-code/memfs)

**Tailscale (device identity under an untrusted coordinator)**
- Tailnet Lock gives each node a node key plus a Tailnet Lock key. A signed chain, the tailnet key authority, holds the trusted signing keys, and peers accept only node keys signed by them. As a result, "attackers can't send or receive traffic in your tailnet" even if Tailscale is compromised. Pre-signed auth keys let new nodes skip a separate signing step. Revoking a compromised key needs co-signatures. Tailscale advises rotating at most once a year so the authority does not grow without bound. Trust starts as trust-on-first-use — [Tailscale docs: Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)

**Keyhive / Beelay (Ink & Switch research)**
- Keyhive combines a capability system for write access with a group key agreement for read access. Beelay syncs the membership graph before documents, with the goal that the server only holds encrypted data. The code is pre-alpha and was unaudited at release — [Keyhive notebook 01](https://www.inkandswitch.com/keyhive/notebook/01/); [Keyhive notebook 04](https://inkandswitch.com/keyhive/notebook/04)

### Inferences
- (Opinion) Atuin's model fits an agent memory store almost directly. Each machine is the only writer of its own series, so the server needs no merge logic and sync is "give me everything after idx N" per series. Atuin now uses the same store for AI-session records, which suggests the model holds up for agent data.
- (Opinion) Atuin's delete-as-record leaves the original ciphertext on the server. It becomes unreadable only if its key is destroyed, or the remote is rebuilt with `push --force`. That is a weak "forget".
- (Opinion) The password-manager pattern recurs across systems: random data keys wrapped by an account key, which a user secret and/or other devices unlock. Atuin, Bitwarden and Standard Notes all wrap a key per record or item, so key rotation rewraps small keys instead of re-encrypting content.

### Gaps
- Atuin's server-side retention of superseded or deleted records, its packfile compaction, and whether the server rejects a duplicate `(host, tag, idx)` were not confirmed from server code.
- any-sync's ACL record format and member-removal key rotation were not confirmed (tech.anytype.io returned an empty page).
- Letta MemFS conflict handling is undocumented.

## Data models: append-only signed op logs vs state-based CRDTs vs LWW with HLC vs event sourcing

### Takeaway
For immutable records with supersede links and tombstones, the best fit is a log per device of encrypted operations (create, supersede, forget), folded locally into a SQLite view. This is event sourcing with a single writer per log, as in Atuin. Document CRDTs (Automerge, Yjs, Loro) solve concurrent editing of one document, which immutable records do not need. They keep history that works against "forget" unless it is explicitly trimmed. Per-column LWW with HLC (Evolu, Actual Budget) works, but it keeps a full change history and lacks enforced deletion. Hash-linking each device's log, as in Kleppmann's BFT-CRDT hash graph, closes the gap that version vectors leave open: a misbehaving device can equivocate, and a server can withhold or roll back records.

### Cited Findings
- Automerge-repo writes each change as an incremental chunk and periodically compacts the chunks into a snapshot keyed by the document heads. Each process deletes only the chunks it loaded, "what makes it safe to use concurrently". The page does not describe purging data out of history — [Automerge docs: storage](https://automerge.org/docs/reference/under-the-hood/storage/)
- Yjs keeps deletions as a separate state-based "delete set". Deleted items stay in place, flagged. With GC enabled, a deleted item's content is discarded, and items with children become a `GC` stub that records only the length — [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md)
- Loro "shallow snapshots" drop history before a version, like a git shallow clone. Deleting text and exporting a shallow snapshot removes it from history. Peers older than the snapshot point cannot catch up from it, and the docs advise syncing all peers before trimming — [Loro docs: shallow snapshots and redaction](https://www.loro.dev/docs/advanced/shallow_snapshot)
- Evolu synced tables "mark rows as deleted and retain their history so devices can merge changes after reconnecting". Column changes, including `isDeleted`, live in `evolu_history`. On enforcing deletion everywhere: "To enforce true deletion across all devices—even future ones—would require complex logic to reject the data forever, without exposing the original data... This is possible (and planned for Evolu), but it's not trivial." Local tables (`_` prefix) delete permanently and do not sync — [Evolu docs: time travel](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/time-travel/page.mdx)
- Evolu Protocol "implements Range-Based Set Reconciliation" (similar to Negentropy). Timestamps carry milliseconds, a counter and a NodeId. Ranges are compared by fingerprints, which "anyone who can write for an owner can make collide" — [Evolu Protocol.ts](https://github.com/evoluhq/evolu/blob/main/packages/common/src/local-first/Protocol.ts)
- Actual Budget's sync relies on hybrid logical clocks. Each message timestamp combines local time, a counter and a node ID, and "can simply be compared string-wise to determine ordering" — [James Long: Using CRDTs in the Wild](https://jlongster.com/using-crdts-in-the-wild)
- Kleppmann (PaPoC 2022), on version vectors: a Byzantine node "may generate several distinct updates with the same sequence number" (equivocation), and peers with identical version vectors may hold different updates, "Even if updates are signed". The fix is a hash graph: each update carries hashes of its predecessors. Peers with identical head hashes have identical update sets, and mismatched heads are reconciled by graph traversal. This "can tolerate any number of Byzantine nodes" — [Kleppmann, Making CRDTs Byzantine Fault Tolerant](https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf)
- In set CRDTs, adding and removing the same element do not commute. Remove-wins (2P-Set) and add-wins (OR-Set) are the usual answers — [arXiv 2311.13936](https://arxiv.org/pdf/2311.13936)
- The SQLite session extension records changes to tables that have a PRIMARY KEY as changesets or patchsets, which can be applied to another database with the same schema. A conflict handler decides whether to omit, abort or force each change. It is off by default (`SQLITE_ENABLE_SESSION`) and does not capture virtual tables — [SQLite session extension](https://sqlite.org/sessionintro.html)
- iCloud Keychain resolves concurrent item updates by picking one side: "one or the other is chosen" — [Apple Platform Security: keychain syncing](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)

### Inferences
- (Opinion) Memory records that are immutable and linked by `supersedes` behave like a grow-only set plus a remove set: a 2P-Set where "forget" wins. Concurrent supersedes of the same record on two machines should both be kept as "forked heads" for the agent or user to reconcile, as Obsidian's "conflicted copy" or Automerge's multi-value registers do. A silent LWW pick, as in iCloud Keychain or Turso's "last push wins", would lose distilled knowledge.
- (Opinion) A Forget operation must be monotonic: once a device has seen it, no later or older create may resurrect the record. That means every machine has to keep tombstones (record IDs only, no content) for at least the longest offline window it supports. Otherwise there must be an explicit "epoch/horizon" rule, so that a device older than the horizon wipes its store and re-pulls, as Loro's shallow-snapshot limit and Atuin's `pull --force` imply.
- (Opinion) Adding a per-device hash chain (each record carries the hash of the previous record in its series) costs little. It lets clients detect server rollback or withholding, and duplicate idx from cloned machines or restored backups. A restored VM or disk image that reuses a host ID is a realistic way to get equivocation in a fleet of laptops and servers.
- (Opinion) Event sourcing with a rebuildable projection, Atuin's `store rebuild`, gives a recovery path when the derived SQLite or vector index is corrupted or its schema changes.

### Gaps
- No primary source was found on how Atuin handles host-ID collisions (for example cloned machines).
- Evolu's planned enforced-deletion design is not documented yet.

## Key management: per-account keys, adding a device, revocation and rotation, recovery

### Takeaway
Shipped systems converge on four practices:
- An account secret (a mnemonic or password plus Secret Key) unlocks a random account key, which wraps per-record or per-item keys.
- New devices get the account key from an existing device over an authenticated QR or approval channel.
- Device identity keys are signed by the account or by trusted devices, so a malicious server cannot add a device.
- Recovery needs an offline recovery key or HSM escrow.

Revocation is the weak point. Unless data keys are rotated, a removed device that kept the key can read any future ciphertext it obtains.

### Cited Findings
- Atuin uses one symmetric key shared between machines, which can be shown as a mnemonic. `rekey` re-encrypts the local store, and other machines need the new key — [atuin paseto_v4.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-common/src/encryption/paseto_v4.rs); [Atuin docs: store](https://docs.atuin.sh/main/reference/store/)
- Evolu derives every owner key from one owner secret with SLIP-21:
  - the OwnerId the relay sees,
  - a 256-bit XChaCha20-Poly1305 encryption key,
  - a write key that "controls who can write, not who can read".

  `createOwnerSecret` is 32 bytes, shown as a 24-word mnemonic. Evolu notes an attacker "can test guesses offline against the public OwnerId", so entropy matters. The relay "never sees or stores public keys" — [Evolu docs: privacy](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/privacy/page.mdx)
- 1Password adds a device with a QR "add-device link" from an enrolled client plus the account password. Revocation does not change keys — [1Password white paper](https://agilebits.github.io/security-design/deepKeys.html); [Appendix A.4](https://agilebits.github.io/security-design/leopard.html)
- Bitwarden's "log in with device" lets an approving device encrypt the user key to the new device's ephemeral public key. Account key rotation rewraps every item key — [Bitwarden security white paper](https://bitwarden.com/help/bitwarden-security-white-paper/)
- Signal links devices by QR code carrying a Curve25519 key and sends "shared keys" in an encrypted provisioning message — [Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- Apple: an existing device sponsors a new one into the syncing circle and signs a voucher. Peer lists are signed by device keys and "can't be modified without the owning device's private keys" — [Apple: keychain syncing](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
- Tailscale Tailnet Lock: node keys are accepted only when signed by trusted lock keys. Pre-signed auth keys enrol headless nodes. Compromised keys are revoked with co-signatures, and disablement secrets keep a compromised coordinator from turning the lock off — [Tailscale docs: Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock)
- Classic Jazz rotated keys automatically when members were removed from Groups — [Jazz classic FAQ](https://classic.jazz.tools/docs/react/reference/faq). Its 2026 retrospective lists the problems that model caused: "public-key complexity", permission mistakes that were hard to fix later, and heavy replay of CRDT history. Jazz v2 makes the server a "trusted authority" for permissions, with "encrypted columns" for sensitive fields only (2026-04-17) — [Jazz blog: what we learned from classic Jazz](https://jazz.tools/blog/what-we-learned-from-classic-jazz)
- Recovery:
  - Apple requires a recovery contact or recovery key under ADP.
  - Apple's HSM escrow destroys the record after 10 failed attempts.
  - Obsidian and Actual Budget cannot recover a lost E2EE password.

  — [Apple ADP](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web); [Apple escrow](https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web); [Obsidian help](https://obsidian.md/help/sync/security); [Actual Budget docs: sync](https://actualbudget.org/docs/getting-started/sync/)

### Inferences
- (Opinion) For a single-user, many-machine memory store, the simplest secure setup:
  1. One account data key per "epoch", wrapping per-record CEKs (Atuin style).
  2. Each device holds an identity key pair; the account (or a quorum of existing devices) signs its public key, Tailnet Lock or iCloud circle style, so a compromised account server cannot inject a device.
  3. QR or approval pairing delivers the epoch key encrypted to the new device's public key (Signal, Bitwarden).
  4. Headless servers enrol with a short-lived pre-signed token (the Tailscale pre-signed auth key analog).
  5. Phone viewers can receive a read-only key path. Separate read and write keys exist in Evolu's write-key design, though there the write key is a relay-checked token, not a signature.
- (Opinion) Revoking a device should start a new epoch:
  1. Generate a new data key and wrap it only for the remaining devices.
  2. Rewrap or re-encrypt live records into a compacted snapshot.
  3. Have the server delete the old epoch's blobs.

  This is cheaper than it sounds with envelope encryption, because only CEKs are rewrapped (Atuin, Bitwarden). Without it, revocation is server policy only, the 1Password caveat.
- (Opinion) Recovery needs either a printed recovery key or mnemonic (Evolu, Atuin, Apple recovery key), or escrow. Losing every device without a recovery key must be an accepted, explained outcome.

### Gaps
- Atuin's documented new-machine login flow page (docs.atuin.sh/guide/sync/) returned 404 during this research, so exact current onboarding wording is unverified.
- Signal's Secure Backups (2025) details came only from secondary news sources ([AlternativeTo](https://alternativeto.net/news/2025/9/signal-introduces-secure-backups-with-encrypted-message-history-across-devices/)); the Signal primary post was not read.

## Local-first sync engines in 2025–2026: E2EE support and fit for an embedded SQLite store

### Takeaway
None of the mainstream commercial sync engines (ElectricSQL, PowerSync, Zero, Turso Sync) sync server-blind data. They are server-authoritative, read Postgres or SQLite rows, and leave E2EE to the app, which means syncing ciphertext columns that the server cannot index. Evolu is the maintained engine that is SQLite-based and E2EE by default, but it is TypeScript-first. cr-sqlite (CRDT SQLite) is maintained slowly. The SQLite session extension and Litestream are building blocks, not E2EE sync. For a Rust or Node daemon that already owns a SQLite store, building Atuin-style record sync in-house is the lowest-risk route. Evolu's protocol (RBSR plus padding) and Atuin's code are the references to borrow from.

### Cited Findings
- **PowerSync:** E2EE is done at the app layer. The app syncs encrypted data and decrypts it "in memory" or into "a separate local-only table" so it can be queried. Local database encryption (SQLite3MultipleCiphers or SQLCipher) varies by SDK — [PowerSync docs: data encryption](https://docs.powersync.com/client-sdks/advanced/data-encryption). PowerSync is server-authoritative: the server resolves conflicts — [PowerSync docs: local-first](https://docs.powersync.com/resources/local-first-software)
- **ElectricSQL:** now served from electric.ax. It is "a read-path sync engine for Postgres" using "Shapes" over HTTP, and writes go "back through your API". The intro does not mention client-side encryption. Its navigation now includes "Agents" and "Streams" — [Electric docs intro](https://electric.ax/docs/intro)
- **Zero (Rocicorp):** syncs into "a local, normalized client datastore" and "falls back to the server when it needs more". The intro does not mention encryption — [Zero docs](https://zero.rocicorp.dev/docs/introduction)
- **Turso Sync:** writes are local, with explicit `push()` (sends "logical statements") and `pull()`. Conflicts resolve with "last push wins". It is described as the "modern equivalent" of Embedded Replicas with `offline: true`. The page does not mention E2EE — [Turso docs: sync](https://docs.turso.tech/sync)
- **Evolu:**
  - Every synced change is encrypted with XChaCha20-Poly1305. Messages are padded with PADMÉ against traffic analysis. The on-device database is SQLCipher-encrypted on web (and on React Native only if enabled).
  - The relay sees OwnerId, timestamps, NodeId (which "can link those owners"), the write key, IP addresses and padded blobs. It stores these in a plain SQLite file.

  — [Evolu docs: privacy](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/privacy/page.mdx). The relay needs "only SQLite and WebSockets"; apps can use several relays at once, and a per-owner quota (`EVOLU_RELAY_MAX_OWNER_BYTES`) is available — [Evolu docs: relay](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/relay/page.mdx). Latest release @evolu/web 3.5.0 on 2026-10-06 — [evoluhq/evolu releases](https://github.com/evoluhq/evolu/releases)
- **Jazz v2:** the server is trusted for permissions, and only "encrypted columns" are hidden from it (2026-04-17) — [Jazz blog](https://jazz.tools/blog/what-we-learned-from-classic-jazz)
- **cr-sqlite:** the repo was last pushed 2026-08-10, versus pushes in Sept/Oct 2026 for evolu, automerge (js 3.5.0, 2026-09-16), loro (loro.js 0.3.0, 2026-09-30), yjs (v14.0.0-rc.28, 2026-09-29), electric, powersync-service, rocicorp/mono, turso (v0.8.3-pre.1, 2026-10-08), libsql, litestream, keyhive and any-sync. litefs was last pushed 2026-05-11 and triplit 2026-01-19 — [GitHub: vlcn-io/cr-sqlite](https://github.com/vlcn-io/cr-sqlite); [GitHub: aspen-cloud/triplit](https://github.com/aspen-cloud/triplit); [GitHub: superfly/litefs](https://github.com/superfly/litefs) (repo metadata via the GitHub API, 2026-10-09)
- **SQLite session extension:** produces changesets and patchsets from a session. Changesets carry original values for conflict detection, patchsets only primary keys and new values. It needs PRIMARY KEYs and a compile-time flag — [SQLite session extension](https://sqlite.org/sessionintro.html)
- **Keyhive/Beelay:** the only research system aiming at server-blind sync with real access control. Pre-alpha and unaudited — [Keyhive notebook 04](https://inkandswitch.com/keyhive/notebook/04)

### Inferences
- (Opinion) Litestream and LiteFS replicate one SQLite writer's pages or WAL. They cannot merge several machines' writes, so they suit backing up a store, not syncing between peers. This is architecture-level reasoning; their current docs were not fetched in this pass.
- (Opinion) Session-extension changesets could be the payload of an op-log record: capture a changeset per transaction, encrypt it, append it to the device's series. Changesets are schema-bound, though, and need conflict handlers. Logical records with an explicit version field (Atuin's `version`, Evolu's append-only schemas) evolve more safely.
- (Opinion) A store that indexes plaintext locally (FTS or vectors) has to decrypt on arrival anyway, as Atuin does ("stored unencrypted on your local device"). The local database should therefore rely on OS full-disk encryption or SQLCipher, as Evolu does on web.

### Gaps
- No primary current documentation was read for Litestream (whether encryption options still exist after 0.5), LiteFS, Triplit (company status), or cr-sqlite's roadmap. Their status above rests on repository activity only.
- Zero's docs did not confirm its offline-write semantics.

## Partial replication and lazy blobs (sync distilled records everywhere, keep raw evidence on the origin)

### Takeaway
The common pattern is "metadata and pointers sync eagerly; bulky content is fetched on demand and may be absent". Shipped examples include Signal (attachment pointers fetched on demand, expiring after 45 days), git partial clone (promisor remotes fault objects in when needed), any-sync (separate file node), Apple keychain (items opt in to sync), and Evolu (local-only tables never sync). The main pitfall is availability. If only the origin machine holds a transcript and that machine is off, sold, or wiped, the evidence is gone, and git documents that "Users must be online" to reach missing objects.

### Cited Findings
- Signal's history archive does not include media. "Attachments are referenced by pointers and fetched on demand", and media older than 45 days cannot be synced because attachments expire — [Signal blog](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
- Git partial clone omits blobs or trees up front. A "promisor remote" "promises to send the objects when requested", and missing objects are "faulted in" one fetch at a time ("once for each item"), with batch prefetch on checkout. Documented limitations include the need to be online, per-object fetch overhead, over-fetching, and the assumption that promisor remotes are complete — [git docs: partial clone](https://git-scm.com/docs/partial-clone)
- any-sync stores files externally (e.g. IPFS) on a dedicated `any-sync-filenode`, separate from the sync node that holds spaces and objects — [any-sync README](https://github.com/anyproto/any-sync)
- iCloud Keychain syncs only items marked `kSecAttrSynchronizable`. Device-specific items such as iMessage keys stay local — [Apple: keychain syncing](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
- Evolu local tables (names starting with `_`) "delete rows permanently and do not keep sync history", and its FAQ covers storing device-specific data that should not sync — [Evolu docs: time travel](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/time-travel/page.mdx); [Evolu FAQ](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/faq/page.mdx)
- Evolu caps each mutation (`maxMutationSize`) so every change fits one protocol message. Oversized stored changes are skipped and reported as `ProtocolChangeTooLargeError` — [Evolu Protocol.ts](https://github.com/evoluhq/evolu/blob/main/packages/common/src/local-first/Protocol.ts)
- Syncthing's encrypted devices store blocks keyed by encrypted block hashes. These "can serve as stable tokens for reusing blocks", which can reveal repeated content — [Syncthing spec](https://docs.syncthing.net/specs/untrusted.html)
- Obsidian encrypts content hashes deterministically to de-duplicate, which allows confirmation attacks. Apple ADP still exposes de-duplication checksums (convergent encryption) — [Obsidian help](https://obsidian.md/help/sync/security); [Apple ADP](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web)

### Inferences
- (Opinion) Distilled memory records should carry an evidence pointer: origin device ID, a local evidence ID, byte size, and a keyed hash (HMAC under the account key, not a plain hash, to avoid confirmation attacks). The raw transcript stays on the origin. When another machine needs it, that machine sends an encrypted request through the account server. The origin, when online, uploads the evidence encrypted under a one-time key delivered inside an end-to-end encrypted message (Signal's archive-key pattern), with a short server TTL.
- (Opinion) An optional "pin evidence to cloud" flag (encrypted, size-capped) helps when the user wants transcripts to survive loss of the origin machine. Otherwise the UI should say "evidence lives on <machine>" so the user sees the availability risk.
- (Opinion) Phone viewers should sync only the distilled-record series and never request bulk evidence by default, much as Apple keeps device-specific items local.

### Gaps
- No primary source was found for how Obsidian's selective sync (excluded folders or file types) works. The settings page was not fetched.

## Privacy and regulation: erasure with E2EE replicated logs; secrets captured into synced data

### Takeaway
With E2EE and per-record keys, "forget" can be made strong in three layers:
1. Destroy the record's wrapped key on the server and every device (crypto-shredding).
2. Physically delete the ciphertext from the server at the next compaction.
3. Propagate a tombstone that every device applies to its local plaintext projection and indexes.

The weak points are devices that are offline (they hold plaintext until they reconnect), backups, and anything a device decrypted and copied elsewhere. 1Password states the general limit plainly: a recipient "cannot be forced to forget". For secrets, the proven defence is to filter before the write (Atuin `secrets_filter`). Once data has synced, retraction is best effort.

### Cited Findings
- 1Password: "once a secret has been shared the recipient cannot be forced to forget that secret". Removal relies on server policy plus well-behaved clients deleting data — [1Password white paper: revoking access](https://agilebits.github.io/security-design/revoke-access.html)
- Atuin filters common secret formats before saving ("will not save it if we get a match"): AWS key IDs, GitHub PATs, Slack tokens and webhooks, Stripe keys — [atuin config.toml](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/config.toml)
- Atuin `purge` and `rekey` act only on the local machine. Forced push replaces the remote store — [Atuin docs: store](https://docs.atuin.sh/main/reference/store/)
- Evolu keeps synced history for merging. True cross-device deletion is "planned" and "not trivial" — [Evolu docs: time travel](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/time-travel/page.mdx)
- Loro redaction removes deleted content from history only through a shallow snapshot, which older peers cannot sync from — [Loro docs](https://www.loro.dev/docs/advanced/shallow_snapshot)
- Crypto-shredding means "destroying the keys that allow the data to be decrypted". Its acceptance as GDPR erasure is argued by vendors but contested. One commentary calls it an "untested legal theory", and no primary EDPB text was confirmed in this research — [Seald: crypto-shredding](https://prod.discovery.seald.io/blog/data-destruction-using-crypto-shredding); [sota.io blog (vendor, 2026)](https://sota.io/blog/gdpr-right-to-erasure-backup-retention-logs-developer-compliance-2026)
- Academic framing: history-independent data structures reveal current content but not the operations that produced it — [arXiv 2002.10635](https://arxiv.org/pdf/2002.10635). Unbounded delay before deletes are persisted "may lead to a breach of privacy" in LSM stores — [Lethe, arXiv 2006.04777](https://arxiv.org/pdf/2006.04777)
- Metadata stays visible even with E2EE: device IDs and upload/delete times (Obsidian); OwnerId, timestamps and NodeId (Evolu); sizes and change patterns (Syncthing); modification dates and checksums (Apple ADP) — [Obsidian](https://obsidian.md/help/sync/security); [Evolu privacy](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/privacy/page.mdx); [Syncthing](https://docs.syncthing.net/specs/untrusted.html); [Apple ADP](https://support.apple.com/guide/security/advanced-data-protection-for-icloud-sec973254c5f/web)

### Inferences
- (Opinion) Per-record CEKs, which Atuin already uses, make forgetting a single record cheap. Deleting the wrapped CEK row is enough, without rewriting the log. The log still needs a Forget record so devices purge their local plaintext projection and search indexes (FTS and embedding vectors are copies too).
- (Opinion) A machine returning after months must apply pending Forgets before it serves any query. If its series is older than the server's compaction horizon, it must wipe and re-pull. Any un-uploaded local records it holds that reference forgotten IDs must be dropped, not resurrected.
- (Opinion) A secret found after sync should be handled as two actions: forget the record, and tell the user to rotate the leaked credential. Deleting synced data cannot guarantee that no copy remains.
- (Opinion) The server-visible metadata (device IDs, timestamps, record counts, sizes) is still personal data under most privacy regimes. Size padding (Evolu PADMÉ) and coarse timestamps reduce it.

### Gaps
- No primary regulator text (EDPB or ICO) on encrypted-but-retained data or crypto-shredding was read. Legal status should be checked by counsel.

## Best-fit pattern and pitfalls for a per-user agent memory store

### Takeaway
(Opinion, built from the cited systems above.) The best fit is an Atuin-style per-device append-only encrypted record log with these additions:
- Evolu-style owner keys and padding.
- 1Password, Signal or Bitwarden-style QR enrolment.
- Tailscale-style signed device identities.
- Per-record CEKs for cheap rotation and crypto-shredding.
- Hash-chained series, a compaction horizon, and an explicit Forget record that every device must apply.
- Distilled records sync everywhere. Raw transcripts stay on the origin behind pointers fetched on demand.

### Cited Findings
- Each building block appears in shipped or documented systems:
  - per-host append-only series, idx diffing, delete records and envelope CEKs — [Atuin record/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs), [Atuin paseto_v4.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-common/src/encryption/paseto_v4.rs)
  - RBSR sync, a blind relay and padding — [Evolu Protocol.ts](https://github.com/evoluhq/evolu/blob/main/packages/common/src/local-first/Protocol.ts), [Evolu privacy](https://github.com/evoluhq/evolu/blob/main/apps/web/src/app/(docs)/docs/privacy/page.mdx)
  - hash-graph integrity — [Kleppmann 2022](https://martin.kleppmann.com/papers/bft-crdt-papoc22.pdf)
  - QR enrolment — [1Password](https://agilebits.github.io/security-design/deepKeys.html), [Signal](https://signal.org/blog/a-synchronized-start-for-linked-devices/)
  - signed device identities — [Tailscale](https://tailscale.com/kb/1226/tailnet-lock), [Apple](https://support.apple.com/guide/security/secure-keychain-syncing-sec0a319b35f/web)
  - pointers fetched on demand — [Signal](https://signal.org/blog/a-synchronized-start-for-linked-devices/), [git partial clone](https://git-scm.com/docs/partial-clone)
  - history trimming with a peer horizon — [Loro](https://www.loro.dev/docs/advanced/shallow_snapshot)
  - secret filtering at capture — [Atuin config](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/config.toml)
- Documented pitfalls:
  - mixed keys across machines breaking sync — [Atuin forum](https://forum.atuin.sh/t/sync-v2-testing/124)
  - a frozen wire format for authenticated headers — [Atuin record/mod.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-domain/src/record/mod.rs)
  - all machines needing the same sync version — [Atuin forum](https://forum.atuin.sh/t/sync-v2-testing/124)
  - revocation without rotation — [1Password A.4](https://agilebits.github.io/security-design/leopard.html)
  - deterministic hash leakage — [Obsidian](https://obsidian.md/help/sync/security)
  - permission complexity in fully E2EE CRDT systems leading Jazz to re-centralise — [Jazz blog](https://jazz.tools/blog/what-we-learned-from-classic-jazz)
  - per-record encryption cost on mass deletes — [Atuin history/store.rs](https://github.com/atuinsh/atuin/blob/main/crates/atuin-client/src/history/store.rs)
  - unrecoverable data when the password or key is lost — [Obsidian](https://obsidian.md/help/sync/security), [Apple escrow](https://support.apple.com/guide/security/escrow-security-for-icloud-keychain-sec3e341e75d/web)

### Inferences
- (Opinion) Proposed record envelope, per device and per collection. The cleartext header is authenticated as AEAD associated data and frozen from day one:
  - `id`
  - `device_id`
  - `collection`
  - `idx`
  - `prev_hash`
  - `epoch`
  - `schema_version`
  - `hlc_timestamp`

  The body is encrypted with a random CEK. The wrapped CEK, stored separately so it can be shredded, is encrypted under the epoch key. Body kinds: `Create{record}`, `Supersede{old_id, new_record}`, `Forget{ids, reason}`, `EvidenceAvailable{evidence_id, size, keyed_hash}`.
- (Opinion) Server API, as a dumb store:
  - `status()` returns `{device -> {collection -> (idx, head_hash)}}`
  - `upload(series, records)` accepts only the device's own series and contiguous idx
  - `download(series, after_idx)`
  - `delete_cek(ids)`
  - `compact(epoch)` replaces the log with a client-produced, encrypted snapshot

  The server can enforce "only device X writes series X" via device signatures, the analog of Evolu's write key.
- (Opinion) Pitfalls to design for up front:
  1. Freeze the header and wire format (Atuin).
  2. Plan cross-version compatibility so one old laptop does not block sync (Atuin required the same version everywhere).
  3. Define tombstone retention and the horizon for long-offline machines.
  4. Expect host-ID duplication from cloned VMs or restored disks; use a hash chain and detect equivocation.
  5. Rotate keys on device removal.
  6. Keep plaintext indexes on every device in scope for "forget".
  7. Avoid deterministic hashes or convergent encryption in server-visible metadata.
  8. Mass-delete performance (batch CEK operations).
  9. Never let headless servers hold the only copy of the recovery secret.
  10. Accept that once a record has been decrypted on a device, deletion is cooperative, not guaranteed.
- (Opinion) A full CRDT library (Automerge, Yjs, Loro) is unnecessary unless memory records become collaboratively edited documents. If that happens, Loro's shallow snapshots are the only documented redaction path among the three.

### Gaps
- No public, production E2EE system was found that combines all of these. This blueprint is a synthesis, not a documented design.
- Performance at hundreds of thousands of records: Atuin's comment about 200k-entry deletes suggests it is workable with batching, but no benchmark was found.
