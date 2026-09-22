import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/dsh_catalog.dart';
import '../core/test_run.dart';
import '../shared/theme/app_theme.dart' as grid;

/// What the New Agent dialog shows while a harness installs on a machine
/// (mockup/dsh-install-progress.html).
///
/// The daemon narrates three phases — fetch, set up, check — and, throttled,
/// the line each one is on. This draws them as steps with the current line
/// under the active one, a small tail of the log, the elapsed time, and, when
/// it fails, the machine's own `miss` line turned into a sentence with the
/// fix it names. Before this the button said "Installing Solid…" for one to
/// five minutes and nothing else.
class DshInstallPanel extends StatefulWidget {
  const DshInstallPanel({
    super.key,
    required this.run,
    required this.harnessName,
    required this.machineName,
  });

  final DshInstallRun run;
  final String harnessName;
  final String machineName;

  @override
  State<DshInstallPanel> createState() => _DshInstallPanelState();
}

class _DshInstallPanelState extends State<DshInstallPanel> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // The elapsed clock. Not under test: a periodic timer is a pumpAndSettle
    // that never settles, and the tests drive the run by hand.
    _tick = kUnderTest ? null : _startClock();
  }

  // coverage:ignore-start
  // Never runs under flutter test (see initState), where coverage is measured.
  Timer _startClock() => Timer.periodic(const Duration(seconds: 1), (_) {
    if (mounted && widget.run.inProgress) setState(() {});
  });
  // coverage:ignore-end

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  static String _clock(Duration d) {
    final m = d.inMinutes;
    final s = d.inSeconds % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  static String _short(Duration d) =>
      d.inSeconds < 60 ? '${d.inSeconds}s' : _clock(d);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final run = widget.run;
    final elapsed =
        (run.phases.isEmpty
                ? DateTime.now()
                : run.inProgress
                ? DateTime.now()
                : run.phases.last.at)
            .difference(run.startedAt);
    final steps = [
      _Step('clone', 'Fetch ${widget.harnessName}'),
      _Step('setup', 'Set up the toolchain'),
      _Step('doctor', 'Check this machine'),
    ];
    // Which step failed: the last real phase before `failed`.
    final failedPhase = run.failed && run.phases.length >= 2
        ? run.phases[run.phases.length - 2].phase
        : null;
    final failure = run.failed
        ? describeInstallFailure(run, widget.harnessName)
        : null;

    return Container(
      key: const Key('dsh-install-panel'),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: grid.AppSurface.recess,
        border: Border.all(color: grid.AppGlass.hair),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  run.done
                      ? '${widget.harnessName} installed on ${widget.machineName}'
                      : 'Installing ${widget.harnessName} on ${widget.machineName}',
                  style: grid.AppType.heading(
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
              ),
              Text(
                _clock(elapsed),
                style: grid.AppType.monoMeta(color: grid.AppPalette.textFaint),
              ),
            ],
          ),
          const SizedBox(height: 10),
          for (final step in steps) ...[
            _StepRow(
              step: step,
              state: run.failed && failedPhase == step.phase
                  ? _StepState.failed
                  : run.done || run.took(step.phase) != null
                  ? (run.reached(step.phase)
                        ? _StepState.done
                        : _StepState.pending)
                  : run.phase == step.phase
                  ? _StepState.active
                  : _StepState.pending,
              sub: _subFor(run, step.phase),
              took: run.took(step.phase),
            ),
            const SizedBox(height: 7),
          ],
          // The tail of what the install printed, whenever there is one. It
          // was behind a "Show log" toggle; the toggle read as a button that
          // did nothing, and the lines are the part that says the install is
          // alive.
          if (run.log.isNotEmpty && !run.done) ...[
            const SizedBox(height: 4),
            _LogTail(lines: run.log),
          ],
          if (failure != null) ...[
            const SizedBox(height: 6),
            _FailureCard(failure: failure),
          ],
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: Text(
                  run.failed
                      ? 'The download and the toolchain are kept; Retry runs the check again.'
                      : run.done
                      ? 'Starting the harness…'
                      : 'The first install takes a few minutes. You can keep using Harness.',
                  style: grid.AppType.body(color: grid.AppPalette.textFaint),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// The line under a step: the current output for the active step, the
  /// doctor's verdicts for the check step, nothing for the rest.
  String? _subFor(DshInstallRun run, String phase) {
    if (phase == 'doctor' && (run.reached('doctor'))) {
      final checks = run.checks;
      if (checks.isNotEmpty) {
        final oks = checks.where((c) => c.startsWith('ok')).length;
        final misses = checks.where((c) => c.startsWith('miss')).length;
        if (run.failed) return '$oks of ${checks.length} checks passed';
        return checks
                .map(
                  (c) =>
                      '${c.replaceFirst(RegExp(r'^\w+\s+'), '').split(' (').first} ${c.startsWith('ok')
                          ? '✓'
                          : c.startsWith('miss')
                          ? '✗'
                          : '!'}',
                )
                .join(' · ')
                .replaceAll(RegExp(r'\s+'), ' ') +
            (misses == 0 && run.inProgress ? ' …' : '');
      }
    }
    if (run.phase != phase || !run.inProgress) return null;
    if (run.line != null) return run.line;
    // [phase] is one of the three steps, so the last arm is the check.
    return switch (phase) {
      'clone' => run.detail ?? 'Fetching…',
      'setup' => 'Setting up the toolchain…',
      _ => 'Checking the machine…',
    };
  }
}

/// What a failed install means for the person, from the machine's `miss` line.
///
/// What kind of thing went wrong, for the one decision a person makes at a
/// failed install: try again, or fix something first.
enum InstallFailureKind {
  /// The download — the connection, a resolver, a 5xx. Trying again is the fix.
  network,

  /// The package itself: no manifest, the wrong id, an unknown catalog entry.
  /// Trying again answers the same; it needs a fix in the Store.
  package,

  /// This machine: a tool the toolchain needs, a setup that failed, a doctor
  /// that found something missing.
  runtime,

  /// Another install of the same package is under way on the machine.
  busy,

  unknown,
}

/// The doctor's lines name the missing tool and a URL; this turns the common
/// ones into a sentence and the command that fixes it. Anything it does not
/// know is shown as the machine wrote it.
class InstallFailure {
  const InstallFailure({
    required this.title,
    this.body,
    this.command,
    this.hint,
    this.kind = InstallFailureKind.unknown,
  });
  final String title;
  final String? body;
  final String? command;

  /// What to do about it, when [kind] settles that — "Try again", "Retrying
  /// will not help". Null when the [title]/[body] already say.
  final String? hint;
  final InstallFailureKind kind;
}

/// The wording git and curl use for the connection, as opposed to the
/// repository: the same list the daemon retries on. Read here only for a
/// daemon old enough to send no code.
final _transientGit = RegExp(
  r'\bcurl \d+\b|RPC failed|early EOF|unexpected disconnect|remote end hung up|'
  r'Could not resolve host|Connection (?:reset|refused|timed out)|Operation too slow|'
  r'Timeout was reached|Failed to connect to|returned error: 5\d\d|'
  r'GnuTLS recv error|SSL_read|TLS connect error|Empty reply from server',
  caseSensitive: false,
);

final _gaveUp = RegExp(r'gave up after (\d+) attempts');

InstallFailure describeInstallFailure(DshInstallRun run, String harnessName) {
  final miss =
      run.checks.where((c) => c.startsWith('miss')).firstOrNull ??
      run.detail?.split(' · ').where((p) => p.startsWith('miss')).firstOrNull;
  final text = (miss ?? run.detail ?? 'Install failed').replaceFirst(
    RegExp(r'^miss\s+'),
    '',
  );
  final lower = text.toLowerCase();
  final code = run.code;
  // The code first, where there is one: it says which step failed without
  // reading git's wording, and a `miss` line only exists once the doctor ran.
  switch (code) {
    case 'DSH_BUSY':
      return InstallFailure(
        kind: InstallFailureKind.busy,
        title: 'Already installing $harnessName on this machine.',
        body: text,
        hint: 'Wait for it to finish.',
      );
    case 'CONNECTION':
    case 'TIMEOUT':
      // This app's own sentence about the request, not the machine's — a
      // doctor line heard before the socket went must not replace it.
      return InstallFailure(
        kind: InstallFailureKind.network,
        title: run.detail ?? text,
      );
    case 'INVALID_MANIFEST':
    case 'PACKAGE_ID_MISMATCH':
    case 'PACKAGE_KIND_MISMATCH':
    case 'INVALID_DSH':
    case 'INVALID_SOURCE':
    case 'SOURCE_NOT_FOUND':
      return InstallFailure(
        kind: InstallFailureKind.package,
        title: 'The $harnessName package is broken.',
        body: text,
        hint: 'Trying again will not help — this needs a fix in the Store.',
      );
    case 'CLONE_FAILED':
      return _downloadFailure(text, harnessName);
  }
  if (lower.startsWith('codex')) {
    return InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'Codex is not installed on this machine.',
      body: '$harnessName runs on Codex. Install it, then retry.',
      command: 'npm install -g @openai/codex',
    );
  }
  if (lower.startsWith('claude')) {
    return InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'Claude Code is not installed on this machine.',
      body: '$harnessName runs on Claude Code. Install it, then retry.',
      command: 'npm install -g @anthropic-ai/claude-code',
    );
  }
  if (lower.startsWith('uv')) {
    return const InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'uv is not installed on this machine.',
      body: 'The toolchain is a Python environment that uv builds. Install it, then retry.',
      command: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    );
  }
  if (lower.startsWith('node')) {
    return InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'Node.js is missing or too old.',
      body: text,
      command: 'brew install node@22',
    );
  }
  if (lower.contains('doctor still running')) {
    return const InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'The check is taking longer than five minutes.',
      body: 'Usually the first load of a large toolchain. Retry runs only the check again.',
    );
  }
  if (lower.contains('clone') || lower.contains('git ')) {
    return _downloadFailure(text, harnessName);
  }
  if (miss != null) {
    // A doctor line this does not know a command for: still what is missing,
    // said as that rather than as the bare check line.
    return InstallFailure(
      kind: InstallFailureKind.runtime,
      title: 'Missing on this machine: $text',
      hint: 'Install it, then try again.',
    );
  }
  if (code == 'SETUP_FAILED' || code == 'DOCTOR_FAILED') {
    return InstallFailure(
      kind: InstallFailureKind.runtime,
      title: code == 'SETUP_FAILED'
          ? 'Setting up the $harnessName toolchain failed on this machine.'
          : '$harnessName is installed, but the check found something missing.',
      body: text,
    );
  }
  return InstallFailure(title: text);
}

/// A failed download: the network when git said so (or when the daemon
/// already retried it, which it does only for the network), else whatever git
/// said — a repository that is not there, a ref that is not.
InstallFailure _downloadFailure(String text, String harnessName) {
  final tries = _gaveUp.firstMatch(text)?.group(1);
  final transient = tries != null || _transientGit.hasMatch(text);
  return InstallFailure(
    kind: transient ? InstallFailureKind.network : InstallFailureKind.unknown,
    title: 'Could not download $harnessName.',
    body: text,
    hint: tries != null
        ? 'Tried $tries times. Check the connection on this machine, then try again.'
        : transient
        ? 'Usually the network. Try again.'
        : null,
  );
}

class _Step {
  const _Step(this.phase, this.name);
  final String phase;
  final String name;
}

enum _StepState { pending, active, done, failed }

class _StepRow extends StatelessWidget {
  const _StepRow({
    required this.step,
    required this.state,
    required this.sub,
    required this.took,
  });

  final _Step step;
  final _StepState state;
  final String? sub;
  final Duration? took;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final muted = state == _StepState.pending;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 18,
          height: 18,
          child: switch (state) {
            _StepState.done => Container(
              decoration: BoxDecoration(
                color: grid.AppPalette.online,
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.check, size: 12, color: Colors.black),
            ),
            _StepState.failed => Container(
              decoration: BoxDecoration(
                color: grid.AppPalette.dangerFill,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.priority_high,
                size: 12,
                color: Colors.white,
              ),
            ),
            _StepState.active => Padding(
              padding: const EdgeInsets.all(1.5),
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: grid.AppPalette.accentOnSurface,
              ),
            ),
            _StepState.pending => Container(
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(
                  color: grid.AppPalette.textFaint,
                  width: 1.5,
                ),
              ),
            ),
          },
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                step.name,
                style: grid.AppType.label(
                  color: muted
                      ? grid.AppPalette.textFaint
                      : grid.AppPalette.textPrimary,
                ),
              ),
              if (sub != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    sub!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.body(
                      color: state == _StepState.active
                          ? grid.AppPalette.textSecondary
                          : grid.AppPalette.textFaint,
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (took != null) ...[
          const SizedBox(width: 10),
          Text(
            _DshInstallPanelState._short(took!),
            style: grid.AppType.monoMeta(color: grid.AppPalette.textFaint),
          ),
        ],
      ],
    );
  }
}

class _LogTail extends StatelessWidget {
  const _LogTail({required this.lines});
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final tail = lines.length > 6 ? lines.sublist(lines.length - 6) : lines;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: grid.AppTheme.pick(
          const Color(0xFFF2F2F1),
          const Color(0xFF0F0F0F),
        ),
        border: Border.all(color: grid.AppGlass.hair),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < tail.length; i++)
            Text(
              tail[i],
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: grid.AppType.monoLabel(
                fontWeight: FontWeight.w400,
                height: 1.5,
                color: i == tail.length - 1
                    ? grid.AppPalette.textSecondary
                    : grid.AppPalette.textFaint,
              ),
            ),
        ],
      ),
    );
  }
}

class _FailureCard extends StatelessWidget {
  const _FailureCard({required this.failure});
  final InstallFailure failure;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final danger = grid.AppPalette.dangerFill;
    return Container(
      key: const Key('dsh-install-failure'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: danger.withValues(alpha: 0.10),
        border: Border.all(color: danger.withValues(alpha: 0.35)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            failure.title,
            style: grid.AppType.label(
              fontWeight: grid.AppFont.semibold,
              color: grid.AppPalette.textPrimary,
            ),
          ),
          for (final line in [failure.body, failure.hint])
            if (line != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(
                  line,
                  style: grid.AppType.body(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
          if (failure.command != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: SelectableText(
                failure.command!,
                style: grid.AppType.monoLabel(
                  fontWeight: FontWeight.w400,
                  color: grid.AppPalette.textPrimary,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
