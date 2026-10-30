import 'dart:convert';
import 'dart:io';

/// Starts console programs (`node.exe`, `harness.exe`, `powershell.exe`)
/// from this app without a console window ever showing.
///
/// The Windows runner is a GUI-subsystem program with no console of its own,
/// so a console child started carelessly gets a new console, and its window
/// flashes up. Dart already takes care of that in one mode: in
/// [ProcessStartMode.normal], `Process.start` and `Process.run` pass
/// `CREATE_NO_WINDOW` to `CreateProcessW`, with the child's stdio on pipes (Dart
/// SDK `runtime/bin/process_win.cc`, `ProcessStarter::Start`: "for gui
/// applications (flutter on windows) console might be absent, will be created
/// by CreateProcessW below. When that happens we ensure that console window
/// doesn't pop up"). The other choices do not:
/// - [ProcessStartMode.inheritStdio] passes no flag, so a console child of
///   this GUI app gets a new, visible console;
/// - the detached modes pass `DETACHED_PROCESS`: the child has no console, and
///   every console program it starts opens a visible window;
/// - `runInShell` puts `cmd.exe` in between, which re-parses `&`, `%` and `!`
///   in arguments such as a profile path.
/// These are the plain calls with those choices fixed, so no FFI is needed.
/// `test/hidden_process_test.dart` checks on Windows that the child has no
/// console window.
///
/// On Windows [runHidden] reads output as UTF-8, as Node and `harness.exe`
/// write it to a pipe, where `Process.run` would read the ANSI code page and
/// garble a name such as `Nguyễn`. Elsewhere its default stays.
Future<Process> startHidden(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
  String? workingDirectory,
}) => Process.start(
  executable,
  arguments,
  environment: environment,
  workingDirectory: workingDirectory,
  runInShell: false,
  mode: ProcessStartMode.normal,
);

/// [startHidden], waited for, with its output collected.
Future<ProcessResult> runHidden(
  String executable,
  List<String> arguments, {
  Map<String, String>? environment,
  String? workingDirectory,
}) => Process.run(
  executable,
  arguments,
  environment: environment,
  workingDirectory: workingDirectory,
  runInShell: false,
  stdoutEncoding: _outputEncoding,
  stderrEncoding: _outputEncoding,
);

Encoding get _outputEncoding =>
    Platform.isWindows ? const Utf8Codec(allowMalformed: true) : systemEncoding;
