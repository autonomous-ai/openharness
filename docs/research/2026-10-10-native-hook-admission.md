# Native hook admission and atomic registration

Work in progress after saved-binding recovery (#1133). The former core HTTP hook
admission golden was recorded from main `c7d460b1d` in `d331c49a4`; its artifact is
also carried unchanged by #1133. The additional former registration golden,
`dba98c53d`, records twenty Linux/macOS observations of first bind, repeat bind,
rotation, terminal promotion, active and dormant ownership transfer, delegated
rejection, and resulting live/durable rows. Both platform values are explicit;
host binaries are forbidden, with UTC time and private temporary roots.

## Confirmed gaps

- `registry.register` currently adopts a terminal and releases a previous owner
  before saving; its ordinary save contains write failures. A failed durable write
  can therefore report a new live binding or leave a displaced owner changed.
- `validTranscriptPath` and the old child check do not prove the announced native
  header completely. The shared fresh file/root/header proofs now exist, but new
  registration still needs to use them and verify again under its durable lock.
- `knownTranscriptFor` catches failed native correction and returns the original
  announcement. Incomplete native evidence is not positive admission evidence.
- Ordinary prompt hooks credit `onPromptSubmitted` before registration. The
  detached missing-file loop gives up after twenty attempts and retains no durable
  delivery. Process-resolution waits acknowledge a pending ordinary hook before
  such a queue exists.
- Hermes pending admission advances its accepted order and removes jobs before
  the registration callback commits. A callback failure can lose the candidate.
- Bound hook mutation checks engine and conversation after asynchronous process
  resolution without an immutable binding/revision fence.

## Implementation boundary

Registration must prepare candidate rows without changing any live index, displaced
owner, terminal promotion or launch state. Under the registry lock, compare the
original durable owners, recheck complete native evidence, validate the combined
rows and write atomically. Publish live state only after that commit. Confirmed
invalid or delegated evidence can refuse admission; unavailable evidence holds it.
Discovery already contains a thrown admission failure and retries with a visible
reason. Hook callers must own pending delivery before acknowledging it and must
credit the prompt only after a successful durable binding.

Pending hook ownership needs immutable process provenance, original delivery order
and body, bounded storage, durable acknowledgement, and retry without readiness or
sibling waits. A stale completion cannot bind a replacement process. A pending
candidate does not establish that the currently bound conversation is invalid.
The displayed admission reason must not manufacture binding authority or make the
queue revoke itself when it reports a hold. Repeated prompt deliveries must not be
collapsed merely because they name the same conversation. Read/commit uncertainty
must retain the delivery and its reason; no background registry fallback may race
an acknowledged live-core admission.

## Validation plan

Preserve the two former goldens unchanged. Add direct registry failure cases for
incomplete headers, changing proofs, failed atomic writes and changed durable
ownership; each must preserve both live and durable prior state. Exercise actual
HTTP admission through an unavailable source and recovery, prompt credit ordering,
queue pressure, superseding process ownership and core restart. Deliberately break
the proof, commit, delivery and callback wiring and require assertion failures.
Run types, architecture, affected hook/registry/notify specs, per-file core/services
and harnessd coverage, affected private discovery/machine/chaos lanes and composed
resume. Measure matched complete registration/admission workloads, including held
retries. Freeze the head for independent review and all required CI before merge.
No release is authorized.
