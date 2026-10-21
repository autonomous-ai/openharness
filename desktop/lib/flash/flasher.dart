import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../core/harness_cli_runner.dart';
import '../core/runtime_platform.dart';
import '../core/serial_port_lease.dart';

/// How the flash dialog names the computer the dial is plugged into.
String flashHostName({bool? windows}) =>
    (windows ?? RuntimePlatform.isWindows) ? 'this computer' : 'this Mac';

/// What a line of flasher output is.
///
/// The script prints a flat stream; the shape is carried by the prefix. `>> `
/// opens a step, an indented line details the step in progress, and anything on
/// stderr is trouble. Nothing here re-orders or drops a line — the raw log stays
/// the record, and this only decides what the UI emphasises.
enum FlashLineKind { step, detail, warning, error }

class FlashLine {
  final String text;
  final FlashLineKind kind;

  const FlashLine(this.text, this.kind);

  /// The step title without its `>> ` marker, for the step list.
  String get title => text.startsWith('>> ') ? text.substring(3) : text;
}

/// Outcome of a finished run.
class FlashResult {
  final int exitCode;
  final bool cancelled;

  const FlashResult({required this.exitCode, this.cancelled = false});

  bool get ok => exitCode == 0 && !cancelled;
}

/// What `--detect-only` found.
class FlashProbe {
  /// Ports the script recognised as an ESP32-S3.
  final List<String> ports;

  /// Set when it refused for a reason the user can act on.
  final String? problem;

  /// Everything it printed, kept for the log pane.
  final List<FlashLine> log;

  const FlashProbe({required this.ports, required this.log, this.problem});

  bool get found => ports.isNotEmpty;
}

/// Runs the published flasher through the installed `harness` CLI.
///
/// The app deliberately does NOT fetch or cache `flash-circle.sh` itself.
/// `harness flash` already owns which script to run and how to get it, and the
/// script owns every number that decides whether a board survives the write —
/// the chip, the app offset, the otadata region, the sha256 checks. A second
/// copy of any of that here is a bricked board the day the two disagree. This
/// class owns one thing: turning that command's output into something a window
/// can draw.
class Flasher {
  Flasher({
    this.startProcess = harnessCliStart,
    bool? windows,
    this.cancelDirectory,
    this.killAfter = const Duration(seconds: 15),
    Future<void> Function(int pid)? killTree,
    Future<ProcessResult> Function(String, List<String>) runProcess =
        Process.run,
  }) : _windows = windows ?? RuntimePlatform.isWindows,
       _killTree = killTree ?? ((pid) => _taskkillTree(pid, runProcess));

  /// Overridden in tests.
  final Future<Process> Function(
    List<String> arguments, {
    Map<String, String>? environment,
  })
  startProcess;

  /// How long a cancelled Windows flash has to stop before its process tree is ended.
  final Duration killAfter;

  /// Where the Windows cancel file goes; defaults to the flasher's folder.
  final String? cancelDirectory;
  final bool _windows;
  final Future<void> Function(int pid) _killTree;
  Timer? _killTimer;
  Future<void>? _forcedStop;

  String get scriptName => _windows ? 'flash-circle.ps1' : 'flash-circle.sh';

  static Future<void> _taskkillTree(
    int pid,
    Future<ProcessResult> Function(String, List<String>) runProcess,
  ) async {
    // `harness flash` runs PowerShell, which runs esptool; killing only the parent leaves writers alive.
    final arguments = ['/PID', '$pid', '/T', '/F'];
    final result = await runProcess('taskkill', arguments);
    if (result.exitCode != 0) {
      throw ProcessException(
        'taskkill',
        arguments,
        result.stderr.toString().trim(),
        result.exitCode,
      );
    }
  }

  Process? _running;
  void Function(FlashLine)? _onLine;
  bool _cancelled = false;

  bool get isRunning => _running != null;

  /// Looks for a plugged-in board without touching it.
  ///
  /// `--detect-only` returns before the script would stop the Harness daemon,
  /// so opening the dialog costs nothing: no daemon bounce, no write, no
  /// download.
  Future<FlashProbe> probe() async {
    final log = <FlashLine>[];
    final ports = <String>[];
    String? problem;

    final code = await _run(['flash', '--detect-only'], (line) {
      log.add(line);
      final text = line.text;
      const marker = '>> board: ';
      if (text.startsWith(marker)) {
        ports.add(text.substring(marker.length).trim());
      } else if (text.startsWith('more than one ESP32-S3')) {
        problem = 'more than one board is connected';
      } else if (text.contains('no permission')) {
        problem = 'no permission to open the serial port';
      }
    });

    if (code != 0 && problem == null) {
      problem = _errorFrom(log) ?? 'could not look for a board';
    }
    return FlashProbe(ports: ports, log: log, problem: problem);
  }

  /// Writes the latest release to [port], or to whatever the script picks.
  ///
  /// `--yes` is not optional. The script asks for confirmation on `/dev/tty`,
  /// and an app launched from Finder has none — without it the run dies with
  /// "not a terminal" before writing anything. The dialog's Flash button IS
  /// that confirmation.
  Future<FlashResult> flash({String? port, void Function(FlashLine)? onLine}) {
    final command = ['flash', '--yes'];
    if (port != null && port.isNotEmpty) command.addAll(['--port', port]);
    // Held for the WHOLE run, not just the write. The script stops the daemon itself and starts it
    // again at the end; between those two the port belongs to esptool, and the app's own daemon
    // supervisor — a five-second timer that restarts anything it finds missing — would otherwise take
    // it back and kill the flash a few tens of kilobytes in.
    return SerialPortLease.hold(() async {
      final code = await _run(command, (line) => onLine?.call(line));
      return FlashResult(exitCode: code, cancelled: _cancelled);
    });
  }

  /// Asks a running flash to stop, and lets it unwind.
  ///
  /// SIGTERM, never SIGKILL. The script arms
  /// `trap start_harness_after_flash EXIT INT TERM`, and that trap is the only
  /// thing that brings the Harness daemon back after the script stopped it to
  /// free the serial port. Killing it outright leaves the computer with no
  /// daemon and the dial dark — worse than never having flashed at all.
  ///
  /// Windows Process.kill skips flash-circle.ps1's `finally`, its one way of starting Harness
  /// again. Ask by file so the script can unwind, then end its tree only after [killAfter].
  /// Releasing the lease lets this app's supervision start the daemon on its next tick.
  void cancel() {
    final process = _running;
    if (process == null) return;
    _cancelled = true;
    if (!_windows) {
      process.kill(ProcessSignal.sigterm);
      return;
    }
    try {
      final dir = Directory(
        cancelDirectory ?? SerialPortLease.flasherDirectory(),
      )..createSync(recursive: true);
      File('${dir.path}${Platform.pathSeparator}cancel')
          .writeAsStringSync('${DateTime.now().millisecondsSinceEpoch}');
    } catch (_) {
      // A filesystem failure must not skip the script's chance to finish and restart Harness.
    }
    _killTimer?.cancel();
    _killTimer = Timer(killAfter, () {
      if (identical(_running, process) && _forcedStop == null) {
        _forcedStop = _endTree(process);
      }
    });
  }

  Future<void> _endTree(Process process) async {
    try {
      await _killTree(process.pid);
      await process.exitCode;
      // The script's finally could not run. Only this invocation's unguessable lease name is ours;
      // a terminal/older script's shared marker and every other app run must be left alone.
      final lease = _ownedLease;
      if (lease != null && lease.existsSync()) lease.deleteSync();
    } catch (error) {
      // A failed kill leaves the writer alive: report it without releasing its serial lease.
      if (identical(_running, process)) {
        _onLine?.call(
          FlashLine(
            'error: could not stop the flash: $error',
            FlashLineKind.error,
          ),
        );
      }
    }
  }

  File? _ownedLease;

  Future<int> _run(
    List<String> command,
    void Function(FlashLine) onLine,
  ) async {
    if (_running != null) throw StateError('a flash is already running');
    _cancelled = false;
    _forcedStop = null;
    final random = _windows ? Random.secure() : null;
    final runId = _windows
        ? List.generate(
            16,
            (_) => random!.nextInt(256).toRadixString(16).padLeft(2, '0'),
          ).join()
        : null;
    final cache = cancelDirectory ?? SerialPortLease.flasherDirectory();
    _ownedLease = runId == null ? null : File('$cache/flashing.$runId');
    final process = await startProcess(
      command,
      environment: runId == null
          ? null
          : {'HARNESS_FLASH_RUN_ID': runId, 'HARNESS_FLASHER_CACHE': cache},
    );
    _running = process;
    _onLine = onLine;
    try {
      final pumps = <Future<void>>[
        _pump(process.stdout, onLine, stderr: false),
        _pump(process.stderr, onLine, stderr: true),
      ];
      final code = await process.exitCode;
      _killTimer?.cancel();
      // Parent EOF can arrive while taskkill is still ending descendants. Retire the persisted
      // lease and finish that termination attempt before SerialPortLease.hold releases supervision.
      await _forcedStop;
      // Drain first: the last lines can still be in flight when the process
      // has already gone, and losing them loses the reason it failed.
      await Future.wait(pumps);
      return code;
    } finally {
      _killTimer?.cancel();
      _killTimer = null;
      _onLine = null;
      _running = null;
      _ownedLease = null;
    }
  }

  Future<void> _pump(
    Stream<List<int>> source,
    void Function(FlashLine) onLine, {
    required bool stderr,
  }) {
    return source
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .forEach((raw) => onLine(classifyFlashLine(raw, stderr: stderr)));
  }

  static String? _errorFrom(List<FlashLine> log) {
    for (final line in log.reversed) {
      if (line.kind == FlashLineKind.error) {
        return line.text.replaceFirst(RegExp(r'^error:\s*'), '');
      }
    }
    return null;
  }
}

/// Decides what a raw output line is.
///
/// Pure, so the rule can be tested without spawning anything.
FlashLine classifyFlashLine(String raw, {required bool stderr}) {
  final text = raw.trimRight();
  if (text.startsWith('error:')) return FlashLine(text, FlashLineKind.error);
  if (text.startsWith('>> ')) return FlashLine(text, FlashLineKind.step);
  // Indented lines detail the running step. On stderr they are the script's
  // warnings — same shape, but they must not read as routine.
  if (stderr) return FlashLine(text, FlashLineKind.warning);
  return FlashLine(text, FlashLineKind.detail);
}

/// Starts `harness flash` with the managed runtime. [HarnessCliRunner] also
/// puts the legacy launcher directory on PATH for the child script, so the
/// flasher can stop and restart its daemon reliably without zsh.
Future<Process> harnessCliStart(
  List<String> arguments, {
  Map<String, String>? environment,
}) =>
    HarnessCliRunner(environment: {...Platform.environment, ...?environment})
        .start(arguments);
