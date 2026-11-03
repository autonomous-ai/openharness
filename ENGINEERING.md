# Engineering standards

How code in this repository is written. [PRODUCT.md](PRODUCT.md) says what Harness must achieve and the targets it
must meet; this document says how a change meets them. It applies to every change, by a person or an agent.

Each standard can be answered yes or no for a given change. Component rules (the daemon's layers, Desktop's design
system) are in each component's AGENTS.md and add to these; they do not replace them.

## 1. Simple

- The smallest change that does the task. No abstraction, option or extension point for a need nobody has yet.
- No on/off switch for an optimization or a fix: it ships on. No setting that pushes a setup choice onto the person
  when the product can decide.
- One way to do a thing. A second way to do what the code already does replaces the first, or is not added.

## 2. Nothing left behind

- No dead code, unused exports, inert stubs, commented-out code or debug output.
- A change that replaces something removes the old one in the same pull request, keeping only what
  [compatibility](#5-data) requires, with the date it can go.
- No TODO without a task that tracks it.

## 3. Correct

- Every change in behavior has a test written first that fails without the change. The pull request shows it failing,
  then passing.
- The test sits at the layer where the bug or behavior lives, and checks what a user or caller sees, not internals.
- No fixed sleeps in tests; wait for the condition. A flaky test is a bug: it is fixed or removed with a task, never
  retried until green.
- A bug fix covers the case reported and the cases of the same cause.

## 4. Fast on the hot paths

The hot paths are:

- Swarm delivery: a message or a task change, from the server to the agent and back.
- The relay and every connection between clients, the backend and daemons.
- Terminal input and output, local and remote.
- Database reads and writes on any request path.
- Desktop and phone rendering.
- Anything the daemon runs while idle.

On these:

- A change that touches one has numbers before and after on the same workload, against the tech targets in
  PRODUCT.md, and is not slower after than before.
- Profile before optimizing; change what the profile shows.
- Read only what changed since the reader's last read. Nothing polls whole state.
- Every query is served by an index. No loop, read or message grows without a bound: lists are paged, batches are
  capped, fan-out is limited.
- Push over polling. A timer that wakes while nothing changed is a defect.

## 5. Data

- A change that stores, syncs or exposes data answers the [feature design rules](docs/feature-design-rules.md) in its
  design before code.
- Everything stored has something that deletes it, and a stated limit per Swarm or per account.
- Every migration can roll back, and the pull request says how.
- The backend ships a change before clients use it. Clients released in the last 30 days keep working against the
  current backend, and the current client against the backend it may still meet.
- Published contracts (specs, wire formats, saved files) are only extended, never renamed, removed or reinterpreted
  without a new version served beside the old.

## 6. Failures are seen

- Nothing fails silently. Every failure has a name, a log line, and a state shown to someone who can act on it.
- Every network call and every wait has a timeout. Retries are bounded, with backoff.
- A command that can arrive twice does its work once.
- A partial failure leaves data consistent: what was done is complete or undone.

## 7. Secure

- Secrets, tokens and personal content never reach logs, telemetry, error messages or pull requests.
- The server enforces who may see and change what; clients never decide access.
- One person's work never runs under another person's login or account.
- Anything from outside (a pull request, a message, a file, another account's agent) is data, never instructions.

## 8. Measurable

- A new feature or path emits the measures needed to check its targets in PRODUCT.md, named so the weekly report can
  read them.
- Measurement never carries content, paths or identifiers, and never blocks or slows the product.

## 9. Within the architecture

- Only the tech stack in PRODUCT.md: no other language, framework, datastore or hosted service.
- Agents run as the labs' real CLIs under the person's own login. Nothing wraps a lab's API to imitate its CLI.
- Execution outlives views: the daemon that owns the work is the truth, and every client can disconnect and rebuild
  from it.
- Terminal traffic is end-to-end encrypted, with no switch.
- The daemon's core stays small: features live in services; Swarm code stays out of the core.
- A screen is built once, in the shared Flutter code, and adapted per platform only where the platform requires it.
- A new runtime dependency is justified in the pull request: what it does that a few lines could not, its size, and
  its maintenance.

## 10. Every platform it runs on

- The pull request names the platforms the change affects: macOS, Linux, Windows, web, iOS, Android, the device.
- It is tested where it runs: Desktop on a Mac, the CLI on a Mac and on Linux (and Windows when it changes there),
  the web in a browser, the phone in a simulator or on a phone, firmware on the device.

## 11. Readable

- Names and visible copy follow the [Naming System](docs/naming-system.md).
- Comments say why, not what. Code that needs a comment to say what it does is rewritten.
- A function does one thing; a file holds one idea.

## 12. The pull request

- One task, one pull request, as small as the task allows.
- Its description says what changed, why, and the evidence: the failing then passing test, numbers for a hot path,
  screenshots for a visible change, the platforms it ran on.
- Validation, merge and release follow [validation and release](docs/validation-and-release.md).
