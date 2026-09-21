import '../core/host_platform.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../core/harness_cli_runner.dart';

/// The CLI-only installer contract for callers that already own host setup.
/// Desktop verifies tmux, the active Linux clipboard helper and the rest of
/// what the CLI runs before reaching this command, then performs its own
/// complete verification again after Harness lands.
const String kHarnessDesktopInstallCommand =
    'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | '
    '/bin/sh -s -- --desktop';

/// The same installer's host half — tmux and what the CLI runs beside it.
/// On macOS this is how tmux is obtained, in-app: Homebrew's if Homebrew is
/// already there, else the managed build downloaded into `~/.harness/runtime`
/// (no compiler, no package manager, no password). One ladder, implemented
/// once, in the script.
const String kHarnessHostSetupCommand =
    'curl -fsSL https://cdn.autonomous.ai/harness/cli/install.sh | '
    '/bin/sh -s -- --host';

const int _linuxClockSyncFailureExitCode = 31;
const int _linuxAptUpdateFailureExitCode = 32;
const int _linuxAptInstallFailureExitCode = 33;
const String _linuxClockRepairCommand =
    'if command -v chronyc >/dev/null 2>&1; then '
    'sudo chronyc makestep; else sudo timedatectl set-ntp true && '
    'sudo systemctl restart systemd-timesyncd; fi';

/// What Harness Desktop RUNS — the only things readiness is about. Everything
/// else the setup screen ever mentions (Homebrew, the Apple developer tools,
/// apt, curl) is a way of obtaining one of these, appears only in the plan
/// for a step that is missing, and is never probed while the step is ready.
enum EnvironmentStep {
  /// The native image-paste helper of the active Linux display (`wl-copy` /
  /// `xclip`). Not applicable on macOS or a headless Linux host.
  clipboard,

  /// The managed Node runtime and `cli.js` under `~/.harness`.
  harness,

  /// The terminal backend: `tmux`, and on Linux the `ps` the CLI's process
  /// liveness and agent discovery run beside it.
  tmux;

  /// Harness Desktop is only ready when every command in this list works.
  bool get isRequired => true;
}

enum EnvironmentSetupPhase {
  preflight,
  review,
  chooseMethod,
  installing,
  waitingForTerminal,
  verifying,
  ready,
  failed,
}

enum EnvironmentSetupMode { automatic, manual }

/// Identifies which host setup owns a visible Terminal handoff. Only Linux has
/// one now — apt needs a password on a real tty; on macOS nothing does since
/// tmux comes from Homebrew-if-present or the managed download. Linux can wait
/// on the clipboard helper even when tmux itself is already ready, so a
/// resumed failure must not always be attributed to the tmux row.
enum EnvironmentTerminalSetup { linuxHost }

class EnvironmentFailure {
  final EnvironmentStep? step;
  final String title;
  final String detail;
  final String? command;
  final int? exitCode;

  const EnvironmentFailure({
    this.step,
    required this.title,
    required this.detail,
    this.command,
    this.exitCode,
  });
}

enum EnvironmentStepStatus {
  pending,
  running,
  ready,
  needsTerminal,
  failed,

  /// This host has no native clipboard to prepare (for example, headless
  /// Linux). Unlike [unavailable], this is a satisfied, non-blocking state.
  notApplicable,

  /// The host does not support this dependency. All current steps are required,
  /// so this status remains blocking.
  unavailable,
}

/// One thing setup will do to obtain a missing [step], in the order it will
/// be done. Computed by the provisioner from what it actually probed, so the
/// screen renders it rather than inferring it — a plan that names Xcode is a
/// plan for a computer where Homebrew was found missing, never a guess.
class EnvironmentPlanItem {
  final EnvironmentStep step;
  final String title;
  final String detail;
  final String command;

  /// Needs a real tty for a password or an OS dialog, so automatic setup
  /// hands it to a visible Terminal window.
  final bool requiresTerminal;

  /// Linux: the apt packages this item installs, so a resumed Terminal
  /// handoff can name what is still missing without re-probing.
  final List<String> packages;

  const EnvironmentPlanItem({
    required this.step,
    required this.title,
    required this.detail,
    required this.command,
    this.requiresTerminal = false,
    this.packages = const [],
  });

  /// The items a plan is assembled from, written down once. tmux on macOS
  /// is a single in-app step whichever way it is obtained; the detail says
  /// which, because that is the one thing the person reading the plan may
  /// care about.
  static const tmuxViaHomebrew = EnvironmentPlanItem(
    step: EnvironmentStep.tmux,
    title: 'tmux',
    detail: 'Installs with the Homebrew already on this Mac',
    command: kHarnessHostSetupCommand,
  );

  static const tmuxManaged = EnvironmentPlanItem(
    step: EnvironmentStep.tmux,
    title: 'tmux',
    detail: 'Downloads a verified build into ~/.harness/runtime',
    command: kHarnessHostSetupCommand,
  );

  static const harnessCli = EnvironmentPlanItem(
    step: EnvironmentStep.harness,
    title: 'Managed Node 20+ & Harness CLI',
    detail: '~/.harness only',
    command: kHarnessDesktopInstallCommand,
  );
}

class EnvironmentReadiness {
  final Map<EnvironmentStep, EnvironmentStepStatus> steps;
  final String? message;
  final List<String> output;
  final EnvironmentSetupPhase phase;
  final EnvironmentSetupMode? mode;
  final EnvironmentFailure? failure;
  final String? terminalLogPath;
  final String? terminalResultPath;
  final EnvironmentTerminalSetup? terminalSetup;

  /// What setup will install, in order — empty when everything runs.
  final List<EnvironmentPlanItem> plan;

  const EnvironmentReadiness({
    required this.steps,
    this.message,
    this.output = const [],
    this.phase = EnvironmentSetupPhase.preflight,
    this.mode,
    this.failure,
    this.terminalLogPath,
    this.terminalResultPath,
    this.terminalSetup,
    this.plan = const [],
  });

  factory EnvironmentReadiness.initial() => EnvironmentReadiness(
    steps: {
      for (final step in EnvironmentStep.values)
        step: EnvironmentStepStatus.pending,
    },
  );

  bool get isReady =>
      phase == EnvironmentSetupPhase.ready &&
      failure == null &&
      _requiredStepsReady;

  bool get _requiredStepsReady => EnvironmentStep.values.every(
    (step) =>
        steps[step] == EnvironmentStepStatus.ready ||
        steps[step] == EnvironmentStepStatus.notApplicable,
  );

  /// Every step but the Harness CLI itself is satisfied — the point at which
  /// automatic setup can run the CLI installer without another host prompt.
  bool get hostReady => steps.entries.every(
    (entry) =>
        entry.key == EnvironmentStep.harness ||
        entry.value == EnvironmentStepStatus.ready ||
        entry.value == EnvironmentStepStatus.notApplicable,
  );

  bool get needsTerminal =>
      phase == EnvironmentSetupPhase.waitingForTerminal ||
      steps.values.any(
        (status) => status == EnvironmentStepStatus.needsTerminal,
      );

  /// The plan items serving one step, in order.
  List<EnvironmentPlanItem> planFor(EnvironmentStep step) =>
      plan.where((item) => item.step == step).toList();

  /// The plan with one step's items done.
  List<EnvironmentPlanItem> planWithout(EnvironmentStep step) =>
      plan.where((item) => item.step != step).toList();

  EnvironmentReadiness copyWith({
    Map<EnvironmentStep, EnvironmentStepStatus>? steps,
    String? message,
    List<String>? output,
    EnvironmentSetupPhase? phase,
    EnvironmentSetupMode? mode,
    EnvironmentFailure? failure,
    String? terminalLogPath,
    String? terminalResultPath,
    EnvironmentTerminalSetup? terminalSetup,
    List<EnvironmentPlanItem>? plan,
    bool clearFailure = false,
    bool clearTerminalHandoff = false,
  }) => EnvironmentReadiness(
    steps: steps ?? this.steps,
    message: message ?? this.message,
    output: output ?? this.output,
    phase: phase ?? this.phase,
    mode: mode ?? this.mode,
    failure: clearFailure ? null : failure ?? this.failure,
    terminalLogPath: clearTerminalHandoff
        ? null
        : terminalLogPath ?? this.terminalLogPath,
    terminalResultPath: clearTerminalHandoff
        ? null
        : terminalResultPath ?? this.terminalResultPath,
    terminalSetup: clearTerminalHandoff
        ? null
        : terminalSetup ?? this.terminalSetup,
    plan: plan ?? this.plan,
  );
}

typedef ProcessRunner = Future<ProcessResult> Function(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
});

typedef TerminalLauncher = Future<void> Function(String scriptPath);

typedef ProcessStarter = Future<Process> Function(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
});

class _EnvironmentProbeTimeout implements Exception {
  const _EnvironmentProbeTimeout(this.label, this.step);
  final String label;
  final EnvironmentStep? step;

  @override
  String toString() => 'The check for $label did not finish.';
}

/// The progress callback `ensureReady` builds for itself, named so the per-host paths below can be
/// separate methods rather than one very long function.
typedef EmitStep = void Function({
  EnvironmentStep? step,
  EnvironmentStepStatus? status,
  String? message,
  String? output,
});

Future<ProcessResult> _defaultRun(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
}) => Process.run(executable, arguments, environment: environment);

Future<Process> _defaultStart(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
}) => Process.start(executable, arguments, environment: environment);

/// macOS opens a real Terminal.app window. Linux has no single canonical
/// terminal, so this tries the Debian/Ubuntu `update-alternatives` target
/// first, then the two most common emulators, and gives up only if none of
/// them exist on the box.
Future<void> _defaultOpenTerminal(String scriptPath) async {
  if (Platform.isMacOS) {
    await Process.start('/usr/bin/open', ['-a', 'Terminal', scriptPath]);
    return;
  }
  final candidates = <List<String>>[
    ['x-terminal-emulator', '-e', scriptPath],
    ['gnome-terminal', '--', scriptPath],
    ['xterm', '-e', scriptPath],
  ];
  for (final candidate in candidates) {
    try {
      await Process.start(candidate.first, candidate.skip(1).toList());
      return;
    } on ProcessException {
      continue;
    }
  }
  throw StateError(
    'Could not find a terminal emulator to launch (tried x-terminal-emulator, '
    'gnome-terminal, xterm)',
  );
}

/// Prepares the only system dependencies required by the desktop transport.
///
/// Node lives beneath [harnessHome] rather than in Homebrew/nvm/PATH. The
/// CLI launcher is written against that exact binary, so launching Harness
/// from Finder and from Terminal has identical runtime behavior.
class EnvironmentProvisioner {
  final Directory harnessHome;
  final ProcessRunner _run;
  final ProcessStarter? _start;
  final TerminalLauncher _openTerminal;
  final bool _isMacOS;
  final bool _isLinux;
  final bool _isWindows;
  final Map<String, String> _platformEnvironment;
  final Duration probeTimeout;

  EnvironmentProvisioner({
    Directory? harnessHome,
    ProcessRunner? run,
    ProcessStarter? start,
    TerminalLauncher? openTerminal,
    bool? isMacOS,
    bool? isLinux,
    bool? isWindows,
    Map<String, String>? platformEnvironment,
    this.probeTimeout = const Duration(seconds: 10),
  }) : harnessHome = harnessHome ?? Directory(_defaultHarnessHome()),
       _run = run ?? _defaultRun,
       _start = start ?? (run == null ? _defaultStart : null),
       _openTerminal = openTerminal ?? _defaultOpenTerminal,
       _isMacOS = isMacOS ?? Platform.isMacOS,
       _isLinux = isLinux ?? Platform.isLinux,
       _isWindows = isWindows ?? Platform.isWindows,
       _platformEnvironment = platformEnvironment ?? Platform.environment;

  /// HOME, then USERPROFILE. Windows sets only the latter, so a launch from Explorer used to throw
  /// out of this constructor before a single frame could render.
  static String? userHome() {
    final home = Platform.environment['HOME'];
    if (home != null && home.isNotEmpty) return home;
    final profile = Platform.environment['USERPROFILE'];
    if (profile != null && profile.isNotEmpty) return profile;
    return containerHome;
  }

  static String _defaultHarnessHome() {
    final home = userHome();
    if (home == null) {
      throw StateError('Could not resolve the current user home directory');
    }
    return '$home${Platform.pathSeparator}.harness';
  }

  /// Checks the complete environment, and mutates it only when [install] is explicitly true.
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final retryingFailedSetup =
        install && resumeFrom?.phase == EnvironmentSetupPhase.failed;
    var state = (resumeFrom ?? EnvironmentReadiness.initial()).copyWith(
      phase: install
          ? EnvironmentSetupPhase.installing
          : EnvironmentSetupPhase.preflight,
      mode: mode,
      clearFailure: true,
      clearTerminalHandoff: retryingFailedSetup,
    );
    void emit({
      EnvironmentStep? step,
      EnvironmentStepStatus? status,
      String? message,
      String? output,
      EnvironmentSetupPhase? phase,
      EnvironmentFailure? failure,
      String? terminalLogPath,
      String? terminalResultPath,
      EnvironmentTerminalSetup? terminalSetup,
      List<EnvironmentPlanItem>? plan,
    }) {
      final next = Map<EnvironmentStep, EnvironmentStepStatus>.from(
        state.steps,
      );
      if (step != null && status != null) next[step] = status;
      final lines = [...state.output];
      if (output != null && output.trim().isNotEmpty) {
        if (output.startsWith('Terminal log:\n')) {
          lines.removeWhere((line) => line.startsWith('Terminal log:\n'));
        }
        lines.add(output.trim());
        if (lines.length > 200) lines.removeRange(0, lines.length - 200);
      }
      state = EnvironmentReadiness(
        steps: next,
        message: message ?? state.message,
        output: lines,
        phase: phase ?? state.phase,
        mode: mode ?? state.mode,
        failure: failure ?? state.failure,
        terminalLogPath: terminalLogPath ?? state.terminalLogPath,
        terminalResultPath: terminalResultPath ?? state.terminalResultPath,
        terminalSetup: terminalSetup ?? state.terminalSetup,
        plan: plan ?? state.plan,
      );
      onProgress(state);
    }

    // One read-only look at the computer, reported step by step, with the
    // plan it implies. Called for the pre-flight and again for the final
    // verification, so both answer the same question the same way.
    Future<_HostProbe> probeAndReport() async {
      final probe = await _probe();
      emit(
        step: EnvironmentStep.tmux,
        status: probe.terminalReady
            ? EnvironmentStepStatus.ready
            : EnvironmentStepStatus.failed,
        message: probe.tmuxMessage,
        output: probe.tmuxOutput,
      );
      emit(
        step: EnvironmentStep.clipboard,
        status: !probe.clipboardApplicable
            ? EnvironmentStepStatus.notApplicable
            : probe.clipboardRuns
            ? EnvironmentStepStatus.ready
            : EnvironmentStepStatus.failed,
        message: probe.clipboardApplicable
            ? probe.clipboardRuns
                  ? 'Native image clipboard is ready.'
                  : '${probe.clipboardPackage} is required for native image paste.'
            : _isLinux
            ? 'Native image clipboard is not applicable on a headless Linux host.'
            : null,
        output: probe.clipboardApplicable
            ? probe.clipboardRuns
                  ? '✓ native image clipboard · ${probe.clipboardCommand}'
                  : '✗ native image clipboard · ${probe.clipboardCommand}'
            : _isLinux
            ? '– native image clipboard N/A (headless)'
            : null,
      );
      emit(
        step: EnvironmentStep.harness,
        status: probe.harnessRuns
            ? EnvironmentStepStatus.ready
            : EnvironmentStepStatus.failed,
        message: probe.harnessRuns
            ? 'Harness CLI and managed Node are ready.'
            : 'Harness CLI or its managed Node runtime is missing.',
        output: probe.harnessRuns
            ? '✓ managed Node >= 20 · harness version'
            : '✗ managed Node >= 20 · harness version',
        plan: probe.plan,
      );
      return probe;
    }

    try {
      final previousTerminalLog = state.terminalLogPath;
      var previousTerminalLogText = '';
      EnvironmentTerminalSetup? completedTerminalSetup;
      if (previousTerminalLog != null) {
        try {
          final recent = await _readTerminalLogTail(previousTerminalLog);
          previousTerminalLogText = recent.text;
          final snapshot =
              'Terminal log:\n'
              '${recent.truncated ? '[Earlier output omitted. Full log: $previousTerminalLog]\n' : ''}'
              '${recent.text.trim()}';
          if (recent.text.trim().isNotEmpty &&
              !state.output.contains(snapshot)) {
            emit(output: snapshot);
          }
        } on FileSystemException {
          // The terminal may not have created its log yet.
        }
      }
      final previousTerminalResult = state.terminalResultPath;
      var terminalResultPending = false;
      if (previousTerminalResult != null) {
        // Missing, unreadable, or partially written results are still pending.
        // Only a complete exit code can finish the handoff; live probes below
        // can independently establish that the required tools are ready.
        terminalResultPending = true;
        if (!await File(previousTerminalResult).exists()) {
          // `terminal.exit` is a handoff hint, not the source of truth. Some
          // Linux terminal emulators keep the launched shell/window alive after
          // apt has already finished, and an interrupted EXIT trap can omit the
          // file entirely. Continue into the read-only command probes below so
          // the 5-second poll (and the user's Recheck button) can observe that
          // the host is actually ready instead of waiting forever for a file a
          // cold app launch does not need either.
          emit(
            message:
                state.message ?? 'Complete the visible prompts in Terminal.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
          );
        }
        try {
          final exitCode = int.tryParse(
            (await File(previousTerminalResult).readAsString()).trim(),
          );
          if (exitCode != null) terminalResultPending = false;
          if (exitCode != null && exitCode != 0) {
            // The only Terminal handoff left is Linux's apt transaction.
            final clipboardFailed =
                state.steps[EnvironmentStep.clipboard] ==
                EnvironmentStepStatus.needsTerminal;
            final tmuxFailed =
                state.steps[EnvironmentStep.tmux] ==
                EnvironmentStepStatus.needsTerminal;
            if (clipboardFailed) {
              emit(
                step: EnvironmentStep.clipboard,
                status: EnvironmentStepStatus.failed,
              );
            }
            if (tmuxFailed) {
              emit(
                step: EnvironmentStep.tmux,
                status: EnvironmentStepStatus.failed,
              );
            }
            final classifiedFailure = _classifiedLinuxPackageFailure(
              exitCode,
              previousTerminalLogText,
            );
            emit(
              message: 'The Terminal setup exited with code $exitCode.',
              phase: EnvironmentSetupPhase.failed,
              failure: EnvironmentFailure(
                step: clipboardFailed
                    ? EnvironmentStep.clipboard
                    : tmuxFailed
                    ? EnvironmentStep.tmux
                    : null,
                title:
                    classifiedFailure?.title ??
                    'System package installation failed',
                detail:
                    classifiedFailure?.detail ??
                    'Terminal exited with code $exitCode. Review the setup details below.',
                command:
                    classifiedFailure?.command ??
                    await _linuxHostManualCommand(_aptPackagesOf(state.plan)),
                exitCode: exitCode,
              ),
            );
            return state;
          }
          if (exitCode == 0) completedTerminalSetup = state.terminalSetup;
        } on FileSystemException {
          // The result can disappear between exists() and readAsString(). The
          // live dependency probes below remain the authoritative fallback.
        }
      }
      onProgress(state);

      if (!_isMacOS && !_isLinux) {
        if (_isWindows) {
          await _verifyWindows(emit);
          return state;
        }
        emit(
          step: EnvironmentStep.harness,
          status: EnvironmentStepStatus.failed,
          message: 'Automatic environment setup is currently available on macOS and Linux only.',
          phase: EnvironmentSetupPhase.failed,
        );
        return state;
      }

      // The one thing every step needs and no plan can install.
      if (!await _hasWritableHome()) {
        const failure = EnvironmentFailure(
          title: 'Home directory is not writable',
          detail: 'Harness needs to write ~/.harness and ~/.local/bin.',
        );
        emit(
          message: failure.detail,
          phase: EnvironmentSetupPhase.failed,
          failure: failure,
        );
        return state;
      }

      var probe = await probeAndReport();
      if (state._requiredStepsReady) {
        emit(
          message: 'All required tools passed verification.',
          phase: EnvironmentSetupPhase.ready,
        );
        return state;
      }

      if (!install) {
        if (terminalResultPending && !state.hostReady) {
          emit(
            message:
                state.message ?? 'Complete the visible prompts in Terminal.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
          );
          return state;
        }
        if (completedTerminalSetup != null && !state.hostReady) {
          emit(
            message: 'The Linux host dependency install finished, but verification still found missing packages.',
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              step: !probe.terminalReady
                  ? EnvironmentStep.tmux
                  : !probe.clipboardRuns
                  ? EnvironmentStep.clipboard
                  : null,
              title: 'Host dependency verification failed',
              detail:
                  'Still missing: ${probe.missingHostNames.join(', ')}. Review the Terminal log, then retry when ready.',
              command: await _linuxHostManualCommand(probe.aptPackages),
            ),
          );
          return state;
        }
        emit(
          message: _isLinux && probe.aptPackages.isNotEmpty
              ? 'Linux host packages required: ${probe.aptPackages.join(', ')}.'
              : 'Review what Harness will install before continuing.',
          phase: EnvironmentSetupPhase.review,
        );
        return state;
      }

      // Strict dependency order: one host-package transaction (tmux, ps, the
      // active clipboard helper and, when the CLI must be downloaded, the
      // tools that download it) -> managed Node/Harness.
      if (_isLinux && probe.aptPackages.isNotEmpty) {
        var packages = probe.aptPackages;
        if (!await _hasAptGet()) {
          final command = await _linuxHostManualCommand(packages);
          emit(
            message: 'Automatic Linux package installation supports apt-based distributions only.',
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              title: 'Unsupported Linux package manager',
              detail:
                  'Install ${packages.join(', ')} with this distribution\'s package manager, then recheck.',
              command: command,
            ),
          );
          return state;
        }

        ProcessResult? backgroundInstall;
        if (await _canInstallAptUnattended()) {
          for (final step in probe.missingHostSteps) {
            emit(step: step, status: EnvironmentStepStatus.running);
          }
          emit(message: 'Installing Linux system packages…');
          try {
            backgroundInstall = await _shellStreaming(
              _linuxAptInstallCommand(packages, nonInteractiveSudo: true),
              onOutput: (line) => emit(
                message:
                    line.contains('Enabling automatic time synchronization')
                    ? 'Synchronizing the system clock before retrying Ubuntu packages…'
                    : null,
                output: line,
              ),
            );
          } catch (error) {
            emit(output: 'Background Linux package install failed: $error');
          }

          probe = await probeAndReport();
          final classifiedBackgroundFailure = backgroundInstall == null
              ? null
              : _classifiedLinuxPackageFailure(
                  backgroundInstall.exitCode,
                  _resultText(backgroundInstall),
                );
          if (classifiedBackgroundFailure != null) {
            emit(
              message: classifiedBackgroundFailure.detail,
              phase: EnvironmentSetupPhase.failed,
              failure: EnvironmentFailure(
                step: probe.missingHostSteps.firstOrNull,
                title: classifiedBackgroundFailure.title,
                detail: classifiedBackgroundFailure.detail,
                command: classifiedBackgroundFailure.command,
                exitCode: classifiedBackgroundFailure.exitCode,
              ),
            );
            return state;
          }
          if (probe.aptPackages.isEmpty) {
            emit(
              message: 'Linux system packages are ready.',
              output: '✓ Linux host dependencies installed and verified',
            );
          } else {
            if (backgroundInstall != null) {
              emit(
                output: backgroundInstall.exitCode == 0
                    ? 'apt finished, but Linux host dependencies did not pass verification.'
                    : 'Background apt install exited ${backgroundInstall.exitCode}: '
                          '${_resultText(backgroundInstall)}',
              );
            }
            packages = probe.aptPackages;
          }
        }

        if (probe.aptPackages.isNotEmpty) {
          final terminal = await _launchLinuxHostSetup(packages);
          for (final step in probe.missingHostSteps) {
            emit(step: step, status: EnvironmentStepStatus.needsTerminal);
          }
          emit(
            message: 'Complete the visible Linux package prompts in Terminal. Harness never sees your password.',
            output: backgroundInstall == null
                ? 'Terminal opened to install Linux host dependencies.'
                : 'Background install was incomplete; Terminal opened to finish Linux host dependencies.',
            phase: EnvironmentSetupPhase.waitingForTerminal,
            terminalLogPath: terminal.log.path,
            terminalResultPath: terminal.result.path,
            terminalSetup: EnvironmentTerminalSetup.linuxHost,
          );
          return state;
        }
      }

      if (_isMacOS && !probe.tmuxRuns) {
        // One in-app step whichever rung applies: the installer's host half
        // uses the Homebrew already here or downloads the managed build.
        // Neither needs a password, so no Terminal window and no waiting.
        emit(
          step: EnvironmentStep.tmux,
          status: EnvironmentStepStatus.running,
          message: probe.homebrewInstallsTmux
              ? 'Installing tmux via Homebrew…'
              : 'Downloading the managed tmux…',
        );
        ProcessResult? installResult;
        try {
          installResult = await _shellStreaming(
            'set -e; $kHarnessHostSetupCommand',
            onOutput: (line) => emit(output: line),
          );
        } catch (error) {
          emit(output: 'tmux install failed: $error');
        }
        if (installResult?.exitCode == 0 && await _hasTmux()) {
          emit(
            step: EnvironmentStep.tmux,
            status: EnvironmentStepStatus.ready,
            message: 'tmux is ready.',
            output: '✓ tmux installed',
            plan: state.planWithout(EnvironmentStep.tmux),
          );
        } else {
          final detail = installResult == null
              ? 'The tmux installer could not be started.'
              : installResult.exitCode == 0
              ? 'The installer finished, but tmux did not pass verification.'
              : 'The tmux installer exited ${installResult.exitCode}: '
                    '${_resultText(installResult)}';
          emit(
            step: EnvironmentStep.tmux,
            status: EnvironmentStepStatus.failed,
            message: detail,
            phase: EnvironmentSetupPhase.failed,
            failure: EnvironmentFailure(
              step: EnvironmentStep.tmux,
              title: 'tmux could not be installed',
              detail: detail,
              command: _manualCommandFor(EnvironmentStep.tmux),
              exitCode: installResult?.exitCode,
            ),
          );
          return state;
        }
      }

      if (!probe.harnessRuns) {
        emit(
          step: EnvironmentStep.harness,
          status: EnvironmentStepStatus.running,
          message: 'Installing managed Node and Harness CLI…',
        );
        await _ensureHarness((line) => emit(output: line));
        emit(
          step: EnvironmentStep.harness,
          status: EnvironmentStepStatus.ready,
          output: '✓ Harness CLI ready',
        );
      }

      emit(
        message: 'Verifying every required command…',
        phase: EnvironmentSetupPhase.verifying,
      );
      await probeAndReport();
      if (!state._requiredStepsReady) {
        final failed = state.steps.entries
            .where((entry) => entry.value == EnvironmentStepStatus.failed)
            .map((entry) => entry.key)
            .firstOrNull;
        throw StateError(
          '${failed?.name ?? 'environment'} did not pass final version verification.',
        );
      }
      emit(message: 'Environment ready.', phase: EnvironmentSetupPhase.ready);
      return state;
    } catch (error) {
      final probeTimeout = error is _EnvironmentProbeTimeout ? error : null;
      final failed =
          probeTimeout?.step ??
          state.steps.entries
              .where((entry) => entry.value == EnvironmentStepStatus.running)
              .map((entry) => entry.key)
              .firstOrNull ??
          state.steps.entries
              .where((entry) => entry.value == EnvironmentStepStatus.failed)
              .map((entry) => entry.key)
              .firstOrNull;
      emit(
        step: failed,
        status: EnvironmentStepStatus.failed,
        message: install
            ? 'Environment setup failed: $error'
            : 'Computer check failed: $error',
        phase: EnvironmentSetupPhase.failed,
        failure: EnvironmentFailure(
          step: failed,
          title: probeTimeout != null
              ? 'Checking this computer took too long'
              : install
              ? 'Setup could not finish'
              : 'Could not check this computer',
          detail: probeTimeout != null
              ? '$error Retry to check again.'
              : '$error',
          command: probeTimeout != null || !install || failed == null
              ? null
              : _manualCommandFor(failed),
        ),
      );
      return state;
    }
  }

  /// Polling a long-running installer must not reread and lay out its complete
  /// log every five seconds. Preserve the original file for troubleshooting.
  Future<({String text, bool truncated})> _readTerminalLogTail(
    String path,
  ) async {
    const maxBytes = 64 * 1024;
    const maxLines = 200;
    final file = await File(path).open();
    try {
      final length = await file.length();
      final offset = length > maxBytes ? length - maxBytes : 0;
      await file.setPosition(offset);
      var text = utf8.decode(
        await file.read(length - offset),
        allowMalformed: true,
      );
      var truncated = offset > 0;
      if (truncated) {
        // The byte limit may cut a UTF-8 character or a line. Prefer complete
        // lines, but keep the tail if the whole chunk is one long line.
        final firstNewline = text.indexOf('\n');
        if (firstNewline >= 0 &&
            text.substring(firstNewline + 1).trim().isNotEmpty) {
          text = text.substring(firstNewline + 1);
        }
      }
      final lines = const LineSplitter().convert(text);
      if (lines.length > maxLines) {
        text = lines.skip(lines.length - maxLines).join('\n');
        truncated = true;
      }
      return (text: text, truncated: truncated);
    } finally {
      await file.close();
    }
  }

  /// One read-only look at what this computer runs, and the plan for what it
  /// does not — each rung probed only when the one above it is missing.
  Future<_HostProbe> _probe() async {
    final plan = <EnvironmentPlanItem>[];
    if (_isMacOS) {
      final tmuxRuns = await _hasTmux();
      var homebrewInstallsTmux = false;
      if (!tmuxRuns) {
        // Asked only to word the plan: the installer decides the same way.
        homebrewInstallsTmux = await _hasHomebrew();
        plan.add(
          homebrewInstallsTmux
              ? EnvironmentPlanItem.tmuxViaHomebrew
              : EnvironmentPlanItem.tmuxManaged,
        );
      }
      final harnessRuns = await _hasHarness();
      if (!harnessRuns) plan.add(EnvironmentPlanItem.harnessCli);
      return _HostProbe(
        tmuxRuns: tmuxRuns,
        clipboardApplicable: false,
        clipboardRuns: true,
        harnessRuns: harnessRuns,
        homebrewInstallsTmux: homebrewInstallsTmux,
        plan: plan,
      );
    }

    final tmuxRuns = await _hasTmux();
    final psRuns = await _hasCommand('ps');
    final clipboardCommand = _linuxClipboardCommand();
    final clipboardRuns =
        clipboardCommand == null || await _hasCommand(clipboardCommand);
    final harnessRuns = await _hasHarness();
    final apt = <String>[
      if (!tmuxRuns) 'tmux',
      if (!psRuns) 'procps',
      if (!clipboardRuns) _linuxClipboardPackage()!,
    ];
    if (!harnessRuns) {
      // The installer downloads the runtime with these; a minimal Ubuntu can
      // lack curl. Asked about only because there is a download coming.
      if (!await _hasCommand('curl')) apt.add('curl');
      if (!await _hasCommands(_linuxDownloadToolPackages.keys)) {
        for (final entry in _linuxDownloadToolPackages.entries) {
          if (!await _hasCommand(entry.key)) apt.add(entry.value);
        }
      }
    }
    if (apt.isNotEmpty) {
      plan.add(
        EnvironmentPlanItem(
          step: !tmuxRuns || !psRuns
              ? EnvironmentStep.tmux
              : !clipboardRuns
              ? EnvironmentStep.clipboard
              : EnvironmentStep.harness,
          title: 'Linux host dependencies',
          detail: '${apt.join(', ')} · one apt transaction',
          command: 'sudo apt-get install -y ${apt.join(' ')}',
          requiresTerminal: true,
          packages: apt,
        ),
      );
    }
    if (!harnessRuns) plan.add(EnvironmentPlanItem.harnessCli);
    return _HostProbe(
      tmuxRuns: tmuxRuns,
      psRuns: psRuns,
      clipboardApplicable: clipboardCommand != null,
      clipboardRuns: clipboardRuns,
      clipboardCommand: clipboardCommand,
      clipboardPackage: _linuxClipboardPackage(),
      harnessRuns: harnessRuns,
      aptPackages: apt,
      plan: plan,
    );
  }

  /// Windows gets a VERIFY pass rather than the install pass above.
  ///
  /// Every installer this class drives is a POSIX shell script — `install.sh` piped into `/bin/sh`,
  /// a `zsh`/`bash` login shell for each probe, `brew`, `apt-get` — and none of it exists here. So
  /// instead of refusing to boot a Windows box that is in fact provisioned, this checks what is
  /// actually on it and names the command for whatever is missing. Windows packaging remains out
  /// of scope for this release.
  Future<void> _verifyWindows(EmitStep emit) async {
    emit(
      step: EnvironmentStep.clipboard,
      status: EnvironmentStepStatus.notApplicable,
    );
    emit(
      step: EnvironmentStep.harness,
      status: EnvironmentStepStatus.running,
      message: 'Checking the Harness CLI…',
    );
    var harnessReady = false;
    try {
      final runner = HarnessCliRunner(
        harnessHome: harnessHome,
        runProcess: _probeHarnessCommand,
      );
      final status = await runner.run(['auth', 'status', '--json']);
      harnessReady =
          status.exitCode == 0 && (status.stdout as String).trim().isNotEmpty;
    } on ProcessException {
      harnessReady = false;
    } on StateError {
      // No managed node/cli.js pair recorded under ~/.harness yet.
      harnessReady = false;
    }
    if (!harnessReady) {
      emit(
        step: EnvironmentStep.harness,
        status: EnvironmentStepStatus.failed,
        message:
            'The Harness CLI is not installed for this user. There is no Windows installer yet — '
            'from a checkout of the CLI run: npm install && npm run bundle && '
            'bash scripts/install-cli.sh — then click Recheck.',
      );
      return;
    }
    emit(
      step: EnvironmentStep.harness,
      status: EnvironmentStepStatus.ready,
      output: 'Harness CLI ready',
    );

    emit(
      step: EnvironmentStep.tmux,
      status: EnvironmentStepStatus.unavailable,
      output:
          'tmux does not exist on Windows — terminals come from Herdr instead.',
    );
  }

  Future<bool> _hasWritableHome() async {
    final writable = await _probeShell(
      'test -w "\$HOME"',
      'your home directory',
    );
    return writable.exitCode == 0;
  }

  Future<bool> _hasCommand(String command) async {
    final probe = await _probeShell(
      'command -v $command >/dev/null 2>&1',
      command,
    );
    return probe.exitCode == 0;
  }

  /// All of [commands] resolve. One shell for the lot: `command -v a b`
  /// answers "any" in bash, so it is a loop rather than a list.
  Future<bool> _hasCommands(Iterable<String> commands) async {
    final probe = await _probeShell(
      'for c in ${commands.join(' ')}; do command -v "\$c" >/dev/null 2>&1 || exit 1; done',
      commands.join(', '),
    );
    return probe.exitCode == 0;
  }

  /// What the CLI installer downloads and unpacks the runtime with, by the
  /// apt package that provides it. `curl` is probed on its own first, since
  /// it is the one a minimal Ubuntu actually lacks.
  static const _linuxDownloadToolPackages = <String, String>{
    'tar': 'tar',
    'sed': 'sed',
    'awk': 'gawk',
    'sha256sum': 'coreutils',
  };

  /// Clipboard selection intentionally matches osClipboard.ts: Wayland wins
  /// when both display variables exist, X11 is the fallback, and a headless
  /// machine has no native clipboard requirement to satisfy.
  String? _linuxClipboardCommand() {
    if (!_isLinux) return null;
    if ((_platformEnvironment['WAYLAND_DISPLAY'] ?? '').isNotEmpty) {
      return 'wl-copy';
    }
    if ((_platformEnvironment['DISPLAY'] ?? '').isNotEmpty) return 'xclip';
    return null;
  }

  String? _linuxClipboardPackage() => switch (_linuxClipboardCommand()) {
    'wl-copy' => 'wl-clipboard',
    'xclip' => 'xclip',
    _ => null,
  };

  /// The apt packages a plan still owes, for a failure's manual command.
  static List<String> _aptPackagesOf(List<EnvironmentPlanItem> plan) =>
      plan.expand((item) => item.packages).toSet().toList();

  Future<bool> _hasAptGet() async {
    final result = await _probeShell(
      'command -v apt-get >/dev/null 2>&1',
      'apt-get',
    );
    return result.exitCode == 0;
  }

  Future<bool> _canInstallAptUnattended() async {
    final user = await _probeShell('id -u', 'your user account');
    if (user.exitCode == 0 && '${user.stdout}'.trim() == '0') return true;
    final sudo = await _probeShell(
      'command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1',
      'sudo access',
    );
    return sudo.exitCode == 0;
  }

  bool _isLinuxClockSkewOutput(String output) {
    final normalized = output.toLowerCase();
    return normalized.contains('is not valid yet') ||
        normalized.contains('certificate is not yet valid');
  }

  EnvironmentFailure? _classifiedLinuxPackageFailure(
    int exitCode,
    String output,
  ) {
    if (exitCode == _linuxClockSyncFailureExitCode ||
        _isLinuxClockSkewOutput(output)) {
      return const EnvironmentFailure(
        title: 'System clock could not be synchronized',
        detail: 'Ubuntu reports that repository metadata is in the future relative to this computer. Enable automatic time synchronization, confirm the clock is correct, then retry.',
        command: _linuxClockRepairCommand,
        exitCode: _linuxClockSyncFailureExitCode,
      );
    }
    if (exitCode == _linuxAptUpdateFailureExitCode) {
      return const EnvironmentFailure(
        title: 'Package repository refresh failed',
        detail: 'Ubuntu could not refresh its package indexes, so Harness stopped instead of retrying with stale package data.',
        command: 'sudo apt-get update',
        exitCode: _linuxAptUpdateFailureExitCode,
      );
    }
    return null;
  }

  String _linuxAptInstallCommand(
    List<String> packages, {
    required bool nonInteractiveSudo,
  }) {
    final names = packages.toSet().join(' ');
    final sudoFlag = nonInteractiveSudo ? '-n ' : '';
    return '''set -o pipefail
export LC_ALL=C
run_as_root() {
  if [ "\$(id -u)" -eq 0 ]; then
    "\$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo $sudoFlag"\$@"
  else
    echo 'Installing Linux system packages needs root access, but sudo is unavailable.' >&2
    return 126
  fi
}
apt_as_root() {
  run_as_root env DEBIAN_FRONTEND=noninteractive apt-get "\$@"
}
repair_system_clock() {
  if command -v chronyc >/dev/null 2>&1; then
    echo 'Repository metadata is ahead of this computer. Enabling automatic time synchronization with chrony…'
    run_as_root chronyc online >/dev/null 2>&1 || true
    run_as_root chronyc burst 4/4 >/dev/null 2>&1 || true
    clock_attempt=0
    while :; do
      chrony_tracking="\$(chronyc tracking 2>/dev/null || true)"
      if printf '%s\n' "\$chrony_tracking" | grep -Eq 'Leap status[[:space:]]*:[[:space:]]*Normal'; then
        if run_as_root chronyc makestep; then
          echo 'System clock stepped with chrony.'
          return 0
        fi
        echo 'chrony has a synchronized source but could not step the system clock.' >&2
        break
      fi
      clock_attempt=\$((clock_attempt + 1))
      if [ "\$clock_attempt" -ge 15 ]; then
        echo 'chrony did not obtain a synchronized source within 30 seconds.' >&2
        break
      fi
      sleep 2
    done
  fi
  if ! command -v timedatectl >/dev/null 2>&1; then
    echo 'System clock is behind repository metadata, but no usable time synchronization service was found.' >&2
    return $_linuxClockSyncFailureExitCode
  fi
  echo 'Repository metadata is ahead of this computer. Enabling automatic time synchronization…'
  run_as_root timedatectl set-ntp true || return $_linuxClockSyncFailureExitCode
  if command -v systemctl >/dev/null 2>&1; then
    run_as_root systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  fi
  clock_attempt=0
  while [ "\$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)" != 'yes' ]; do
    clock_attempt=\$((clock_attempt + 1))
    if [ "\$clock_attempt" -ge 15 ]; then
      echo 'Automatic time synchronization did not become ready within 30 seconds.' >&2
      return $_linuxClockSyncFailureExitCode
    fi
    sleep 2
  done
  echo 'System clock synchronized.'
}
refresh_package_indexes() {
  apt_update_log="\${TMPDIR:-/tmp}/harness-apt-update-\$\$.log"
  if apt_as_root update 2>&1 | tee "\$apt_update_log"; then
    rm -f "\$apt_update_log"
    return 0
  fi
  if grep -Eiq 'is not valid yet|certificate is not yet valid' "\$apt_update_log"; then
    rm -f "\$apt_update_log"
    if ! repair_system_clock; then
      echo 'System clock could not be synchronized automatically.' >&2
      return $_linuxClockSyncFailureExitCode
    fi
    if ! apt_as_root update; then
      echo 'Package repository refresh still failed after clock synchronization.' >&2
      return $_linuxAptUpdateFailureExitCode
    fi
    return 0
  fi
  rm -f "\$apt_update_log"
  echo 'Package repository refresh failed. Harness will not retry with stale package indexes.' >&2
  return $_linuxAptUpdateFailureExitCode
}
install_linux_packages() {
  apt_as_root install -y $names && return 0
  echo 'Refreshing package indexes before retrying…'
  refresh_package_indexes || return \$?
  if ! apt_as_root install -y $names; then
    echo 'Package installation still failed after a successful repository refresh.' >&2
    return $_linuxAptInstallFailureExitCode
  fi
}
if install_linux_packages; then
  :
else
  install_status=\$?
  exit "\$install_status"
fi''';
  }

  Future<String> _linuxHostManualCommand(List<String> packages) async {
    final names = packages.toSet().join(' ');
    if (names.isEmpty) return 'Recheck Linux system dependencies.';
    if (!await _hasAptGet()) {
      return 'Install with your distribution package manager: $names';
    }
    return 'sudo apt-get install -y $names';
  }

  Future<bool> _hasHarness() async {
    final currentNode = File('${harnessHome.path}/runtime/current-node');
    if (!await currentNode.exists()) return false;
    final nodePath = (await currentNode.readAsString()).trim();
    if (nodePath.isEmpty || !File(nodePath).existsSync()) return false;
    final runtimeRoot = '${harnessHome.absolute.path}/runtime/';
    if (!File(nodePath).absolute.path.startsWith(runtimeRoot)) return false;
    final node = await _runProbe(
      nodePath,
      ['--version'],
      label: 'the managed Node runtime',
      step: EnvironmentStep.harness,
    );
    if (node.exitCode != 0) return false;
    final match = RegExp(r'^v?(\d+)').firstMatch('${node.stdout}'.trim());
    if (match == null || int.parse(match.group(1)!) < 20) return false;
    try {
      final cli = File('${harnessHome.path}/cli/cli.js');
      if (!await cli.exists()) return false;
      final version = await _probeHarnessCommand(nodePath, [
        cli.path,
        'version',
      ]);
      return version.exitCode == 0;
    } on ProcessException {
      return false;
    } on StateError {
      return false;
    }
  }

  Future<void> _ensureHarness(void Function(String line) onOutput) async {
    final runner = HarnessCliRunner(
      harnessHome: harnessHome,
      runProcess: _probeHarnessCommand,
    );
    if (await _hasHarness()) return;
    // No interpreter is named here. install.sh provisions the same
    // checksum-verified Node under `~/.harness/runtime` when the computer has
    // none, records it in `current-node`, and bakes its absolute path into the
    // `~/.local/bin/harness` launcher — which is what makes a Finder launch,
    // where PATH is launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, still find
    // a Node. Doing it there rather than here keeps ONE implementation of that,
    // shared with everyone who installs the CLI from a terminal.
    final install = await _shellStreaming(
      // Served off the CDN-fronted public bucket (autonomous-code: apps/web/scripts/cli-install.sh,
      // published with `make upload-cli-install-sh`), not by the web app. The old web-app URL,
      // https://harness.autonomous.ai/cli/install.sh, still redirects here, but pointing at the CDN
      // URL directly avoids that extra hop.
      // A stale URL is worse here than anywhere else: a 404 piped into bash still exits 0 (measured),
      // so the `install.exitCode != 0` check below would pass and the failure would only surface as
      // the confusing "CLI did not start after installation" a few lines further down.
      'set -e; $kHarnessDesktopInstallCommand',
      onOutput: onOutput,
    );
    if (install.exitCode != 0) {
      throw StateError(
        'Harness installer exited ${install.exitCode}: ${_resultText(install)}',
      );
    }
    final verified = await runner.run(['version']);
    if (verified.exitCode != 0 || !await _hasHarness()) {
      throw StateError(
        'Harness CLI verification exited ${verified.exitCode}: ${_resultText(verified)}',
      );
    }
  }

  Future<({File log, File result})> _launchLinuxHostSetup(
    List<String> packages,
  ) => _launchTerminalSetup(linuxPackages: packages);

  Future<({File log, File result})> _launchTerminalSetup({
    List<String> linuxPackages = const [],
  }) async {
    // Package-manager installs can ask for a password. Always hand them to a
    // visible OS terminal instead of guessing whether this particular run will
    // prompt in a headless Process.run child.
    final script = await _writeTerminalBootstrapScript(
      linuxPackages: linuxPackages,
    );
    await _openTerminal(script.path);
    return (
      log: File('${script.parent.path}/terminal.log'),
      result: File('${script.parent.path}/terminal.exit'),
    );
  }

  Future<bool> _hasTmux() async {
    final result = await _probeShell(
      'command -v tmux >/dev/null && tmux -V',
      'tmux',
      step: EnvironmentStep.tmux,
    );
    return result.exitCode == 0;
  }

  Future<bool> _hasHomebrew() async {
    final result = await _probeShell(
      'command -v brew >/dev/null && brew --version',
      'Homebrew',
      step: EnvironmentStep.tmux,
    );
    return result.exitCode == 0;
  }

  /// The Linux apt transaction as a script for a real terminal — the one
  /// host step left that needs a password on a tty.
  Future<File> _writeTerminalBootstrapScript({
    List<String> linuxPackages = const [],
  }) async {
    final directory = Directory(
      '${harnessHome.path}/desktop-app-v2/setup-runs/${DateTime.now().millisecondsSinceEpoch}',
    );
    await directory.create(recursive: true);
    await _run('/bin/chmod', ['700', directory.path]);
    final packageList = linuxPackages.isEmpty
        ? const ['tmux']
        : linuxPackages.toSet().toList();
    final packages = packageList.join(' ');
    const packageCommands = <String, String>{
      'curl': 'curl',
      'tar': 'tar',
      'sed': 'sed',
      'gawk': 'awk',
      'coreutils': 'sha256sum',
      'tmux': 'tmux',
      'procps': 'ps',
      'xclip': 'xclip',
      'wl-clipboard': 'wl-copy',
    };
    final verification = packageList
        .map((package) => packageCommands[package])
        .whereType<String>()
        .map(
          (command) => command == 'tmux'
              ? 'command -v tmux >/dev/null 2>&1 && tmux -V'
              : 'command -v $command >/dev/null 2>&1',
        )
        .join('\n');
    final aptInstallCommand = _linuxAptInstallCommand(
      packageList,
      nonInteractiveSudo: false,
    );
    final script = File('${directory.path}/install-linux-dependencies.sh');
    await script.writeAsString('''#!/bin/bash
set -eu
umask 077
LOG_FILE="${directory.path}/terminal.log"
RESULT_FILE="${directory.path}/terminal.exit"
exec > >(tee -a "\$LOG_FILE") 2>&1

finish() {
  status=\$?
  printf '%s\\n' "\$status" > "\$RESULT_FILE"
  if [ "\$status" -ne 0 ]; then
    echo
    echo 'Linux package installation failed. Review the error above, then try again.'
    read -r -p 'Press Enter to close this window…' || true
  fi
  return "\$status"
}
trap finish EXIT

if command -v apt-get >/dev/null 2>&1; then
  echo 'Installing Linux host dependencies (you may be asked for your password)…'
  $aptInstallCommand
  $verification
  echo 'Installed packages: $packages'
  echo 'Linux host dependencies are ready. This window will close automatically in 5 seconds.'
  sleep 5
else
  echo 'Automatic Linux package installation only supports apt-based distributions (Ubuntu/Debian).'
  echo 'Install these packages with your distribution package manager: $packages'
  exit 1
fi
''', flush: true);
    await _run('/bin/chmod', ['700', script.path]);
    return script;
  }

  List<String> _shellArguments(String command) => [
    '-l',
    '-c',
    // The Homebrew prefixes are named rather than trusted to be on PATH:
    // `-l` is a LOGIN shell but not an interactive one, so it reads
    // `~/.zprofile` and never `~/.zshrc`
    // — which is where `brew shellenv` sits on plenty of machines. A Finder
    // launch then starts from launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`
    // and this probe reports tmux missing on a computer that has it, then
    // "installs" it through whichever `brew` it can see. Measured: an Apple
    // Silicon Mac with both Homebrews picked up Intel `/usr/local/bin/brew`
    // and built openssl@3 from source under Rosetta, holding the boot open
    // on "Checking tmux…" for as long as that took. Apple Silicon first, so
    // a machine with both never installs through the Intel one. The CLI
    // closed the same gap in `lib/tmuxOnPath.ts`.
    'export PATH="\$HOME/.local/bin${_isMacOS ? ':/opt/homebrew/bin:/usr/local/bin' : ''}:\$PATH"; $command',
  ];

  Future<ProcessResult> _probeShell(
    String command,
    String label, {
    EnvironmentStep? step,
  }) => _runProbe(
    _isMacOS ? '/bin/zsh' : '/bin/bash',
    _shellArguments(command),
    label: label,
    step: step,
  );

  Future<ProcessResult> _probeHarnessCommand(
    String executable,
    List<String> arguments, {
    Map<String, String>? environment,
  }) => _runProbe(
    executable,
    arguments,
    environment: environment,
    label: 'the Harness CLI',
    step: EnvironmentStep.harness,
  );

  /// A check owns its process and waits for at most one short deadline,
  /// including process startup and output-pipe closure. Installers use the
  /// separate streaming path: a slow version check must never look like a
  /// missing tool or leave another check running every time Retry is pressed.
  Future<ProcessResult> _runProbe(
    String executable,
    List<String> arguments, {
    required String label,
    EnvironmentStep? step,
    Map<String, String>? environment,
  }) async {
    final timeout = _EnvironmentProbeTimeout(label, step);
    final start = _start;
    if (start == null) {
      // Existing run-only test doubles do not own operating-system processes.
      return _run(
        executable,
        arguments,
        environment: environment,
      ).timeout(probeTimeout, onTimeout: () => throw timeout);
    }
    final result = Completer<ProcessResult>();
    Process? process;
    StreamSubscription<List<int>>? output;
    StreamSubscription<List<int>>? errors;
    final stdout = BytesBuilder();
    final stderr = BytesBuilder();
    int? exitCode;
    var exited = false;
    var outputClosed = false;
    var errorsClosed = false;

    void fail(Object error, StackTrace stack) {
      if (!result.isCompleted) result.completeError(error, stack);
    }

    void collect(BytesBuilder buffer, List<int> bytes) {
      const maxOutputBytes = 64 * 1024;
      final available = maxOutputBytes - buffer.length;
      if (available > 0) {
        buffer.add(
          bytes.length > available ? bytes.sublist(0, available) : bytes,
        );
      }
    }

    void finish() {
      if (result.isCompleted || !exited || !outputClosed || !errorsClosed) {
        return;
      }
      result.complete(
        ProcessResult(
          process!.pid,
          exitCode!,
          utf8.decode(stdout.takeBytes(), allowMalformed: true),
          utf8.decode(stderr.takeBytes(), allowMalformed: true),
        ),
      );
    }

    final timer = Timer(probeTimeout, () => fail(timeout, StackTrace.current));
    unawaited(() async {
      try {
        final child = await start(
          executable,
          arguments,
          environment: environment,
        );
        // A late launch must also be stopped; the timeout may have already
        // returned control to the user and allowed a replacement check.
        if (result.isCompleted) {
          child.kill(ProcessSignal.sigkill);
          await child.stdout.listen(null, onError: (Object _) {}).cancel();
          await child.stderr.listen(null, onError: (Object _) {}).cancel();
          await child.stdin.close();
          return;
        }
        process = child;
        // Probes never ask for input, including through shell startup files.
        unawaited(
          child.stdin.close().then<void>((_) {}, onError: (Object _) {}),
        );
        output = child.stdout.listen(
          (bytes) => collect(stdout, bytes),
          onError: fail,
          onDone: () {
            outputClosed = true;
            finish();
          },
        );
        errors = child.stderr.listen(
          (bytes) => collect(stderr, bytes),
          onError: fail,
          onDone: () {
            errorsClosed = true;
            finish();
          },
        );
        unawaited(
          child.exitCode.then<void>((value) {
            exited = true;
            exitCode = value;
            finish();
          }, onError: fail),
        );
      } catch (error, stack) {
        fail(error, stack);
      }
    }());
    try {
      return await result.future;
    } finally {
      timer.cancel();
      if (!exited) process?.kill(ProcessSignal.sigkill);
      await output?.cancel();
      await errors?.cancel();
    }
  }

  Future<ProcessResult> _shell(
    String command, {
    Map<String, String>? environment,
    Duration? timeout,
  }) {
    final run = _run(
      _isMacOS ? '/bin/zsh' : '/bin/bash',
      _shellArguments(command),
      environment: environment,
    );
    if (timeout == null) return run;
    // The child keeps running — Process.run gives us no handle to kill. That is
    // the intent: a slow install finishes in the background and the next launch
    // finds it, while this one stops waiting.
    return run.timeout(
      timeout,
      onTimeout: () => ProcessResult(0, 124, '', 'timed out after $timeout'),
    );
  }

  Future<ProcessResult> _shellStreaming(
    String command, {
    required void Function(String line) onOutput,
    Duration? timeout,
  }) async {
    final shell = _isMacOS ? '/bin/zsh' : '/bin/bash';
    if (_start == null) {
      final result = await _shell(command, timeout: timeout);
      for (final line in '${result.stdout}\n${result.stderr}'.split('\n')) {
        if (line.trim().isNotEmpty) onOutput(line);
      }
      return result;
    }

    final process = await _start(shell, _shellArguments(command));
    final stdoutLines = <String>[];
    final stderrLines = <String>[];
    final stdoutSubscription = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          stdoutLines.add(line);
          onOutput(line);
        });
    final stderrSubscription = process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          stderrLines.add(line);
          onOutput(line);
        });
    final stdoutDone = stdoutSubscription.asFuture<void>();
    final stderrDone = stderrSubscription.asFuture<void>();
    var timedOut = false;
    final exit = timeout == null
        ? await process.exitCode
        : await process.exitCode.timeout(
            timeout,
            onTimeout: () {
              timedOut = true;
              process.kill();
              return 124;
            },
          );
    if (timedOut) {
      await stdoutSubscription.cancel();
      await stderrSubscription.cancel();
    } else {
      await Future.wait([stdoutDone, stderrDone]);
    }
    return ProcessResult(
      process.pid,
      exit,
      stdoutLines.join('\n'),
      stderrLines.join('\n'),
    );
  }

  String _manualCommandFor(EnvironmentStep step) => switch (step) {
    EnvironmentStep.clipboard =>
      'sudo apt-get install -y ${_linuxClipboardPackage() ?? 'xclip or wl-clipboard'}',
    EnvironmentStep.tmux =>
      _isMacOS
          ? '$kHarnessHostSetupCommand && tmux -V'
          : 'sudo apt-get install -y tmux && tmux -V',
    EnvironmentStep.harness =>
      '$kHarnessDesktopInstallCommand && harness version',
  };

  String _resultText(ProcessResult result) {
    final text = '${result.stderr}\n${result.stdout}'.trim();
    return text.length <= 700 ? text : text.substring(text.length - 700);
  }
}

extension on Iterable<EnvironmentStep> {
  EnvironmentStep? get firstOrNull => isEmpty ? null : first;
}

/// The result of one read-only look at the computer: which required commands
/// run, and the plan for the ones that do not.
class _HostProbe {
  final bool tmuxRuns;
  final bool psRuns;
  final bool clipboardApplicable;
  final bool clipboardRuns;
  final String? clipboardCommand;
  final String? clipboardPackage;
  final bool harnessRuns;

  /// macOS: Homebrew is present, so tmux installs in-app without a password.
  final bool homebrewInstallsTmux;

  /// Linux: the one apt transaction, in install order. Empty when nothing
  /// needs apt.
  final List<String> aptPackages;
  final List<EnvironmentPlanItem> plan;

  const _HostProbe({
    required this.tmuxRuns,
    this.psRuns = true,
    required this.clipboardApplicable,
    required this.clipboardRuns,
    this.clipboardCommand,
    this.clipboardPackage,
    required this.harnessRuns,
    this.homebrewInstallsTmux = false,
    this.aptPackages = const [],
    required this.plan,
  });

  List<EnvironmentPlanItem> planFor(EnvironmentStep step) =>
      plan.where((item) => item.step == step).toList();

  /// The terminal backend as a whole: tmux, and on Linux `ps` beside it.
  bool get terminalReady => tmuxRuns && psRuns;

  /// The host steps (everything but the Harness CLI) that are not ready.
  List<EnvironmentStep> get missingHostSteps => [
    if (!terminalReady) EnvironmentStep.tmux,
    if (clipboardApplicable && !clipboardRuns) EnvironmentStep.clipboard,
  ];

  /// What is still missing, by command name, for a failure detail.
  List<String> get missingHostNames => [
    if (!tmuxRuns) 'tmux',
    if (!psRuns) 'ps',
    if (clipboardApplicable && !clipboardRuns) ?clipboardCommand,
  ];

  String get tmuxMessage {
    if (terminalReady) return 'tmux is ready.';
    if (aptPackages.isNotEmpty) {
      return '${psRuns ? 'tmux' : 'tmux and ps'} will be installed with apt.';
    }
    return homebrewInstallsTmux
        ? 'tmux will be installed with Homebrew.'
        : 'tmux will be downloaded into ~/.harness/runtime.';
  }

  String get tmuxOutput {
    if (terminalReady) return '✓ tmux --version';
    final lines = <String>[tmuxRuns ? '✓ tmux --version' : '✗ tmux --version'];
    if (!psRuns) lines.add('✗ ps');
    if (aptPackages.isEmpty) {
      lines.add(
        homebrewInstallsTmux ? '✓ brew --version' : '– managed tmux download',
      );
    }
    return lines.join(' · ');
  }
}
