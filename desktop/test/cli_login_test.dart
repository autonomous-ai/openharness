import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/harness_cli_runner.dart';

class _Runner extends HarnessCliRunner {
  final starts = <Completer<Process>>[];
  @override
  Future<Process> start(List<String> arguments) {
    // The entry point rides along so login tracking can tell an app sign-in from a terminal one.
    expect(arguments, ['login', '--force', '--json', '--entry-point=desktop']);
    final start = Completer<Process>();
    starts.add(start);
    return start.future;
  }
}

class _Process implements Process {
  final output = StreamController<List<int>>();
  final errors = StreamController<List<int>>();
  final ended = Completer<int>();
  var kills = 0;
  void emit(Map<String, dynamic> event) =>
      output.add(utf8.encode('${jsonEncode(event)}\n'));
  void finish([int exitCode = 0]) {
    unawaited(output.close());
    unawaited(errors.close());
    if (!ended.isCompleted) ended.complete(exitCode);
  }

  @override
  Stream<List<int>> get stdout => output.stream;
  @override
  Stream<List<int>> get stderr => errors.stream;
  @override
  Future<int> get exitCode => ended.future;
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    kills++;
    // A signalled process need not exit synchronously. Tests explicitly finish
    // it later, including after a replacement sign-in has already started.
    return true;
  }

  @override
  int get pid => 1;
  @override
  IOSink get stdin => throw UnimplementedError();
}

class _LogoutRunner extends HarnessCliRunner {
  _LogoutRunner(this.process)
    : super(runTimeout: const Duration(milliseconds: 30));
  final _Process process;
  final arguments = <List<String>>[];
  @override
  Future<Process> start(List<String> command) async {
    arguments.add(command);
    return process;
  }

  @override
  Future<ProcessResult> run(List<String> command) async {
    // The original fire-and-forget run path reports this as success.
    return ProcessResult(1, 1, '', 'Fixture failure');
  }
}

class _TimeoutProcess extends _Process {
  @override
  bool kill([ProcessSignal signal = ProcessSignal.sigterm]) {
    final killed = super.kill(signal);
    finish(1);
    return killed;
  }
}

void main() {
  test('logout reports a nonzero CLI exit as a failure', () async {
    final process = _Process()..finish(1);
    final runner = _LogoutRunner(process);
    await expectLater(CliLogin(runner: runner).logout(), throwsStateError);
  });

  test(
    'logout drains output and finishes before permitting another command',
    () async {
      final process = _Process();
      final runner = _LogoutRunner(process);
      var finished = false;
      final pending = CliLogin(runner: runner)
          .logout()
          .then((_) => finished = true);
      await Future<void>.delayed(Duration.zero);
      expect(finished, isFalse);
      process.emit({'fixture': 'output'});
      process.errors.add(utf8.encode('fixture diagnostic'));
      process.finish();
      await pending;
      expect(runner.arguments, [
        ['logout'],
      ]);
    },
  );

  test(
    'a timed-out logout stops its process before returning failure',
    () async {
      final process = _TimeoutProcess();
      final runner = _LogoutRunner(process);
      await expectLater(CliLogin(runner: runner).logout(), throwsStateError);
      expect(process.kills, 1);
      expect(process.ended.isCompleted, isTrue);
    },
  );

  test(
    'cancel while the CLI starts ignores its late URL and stops that process',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final login = cli.login(onAuthorizeUrl: urls.add);
      final result = expectLater(login, throwsStateError);
      cli.cancel();
      final process = _Process();
      process.emit({
        'type': 'authorize_url',
        'url': 'https://auth.example/old',
      });
      process.emit({'type': 'result', 'status': 'success'});
      runner.starts.single.complete(process);
      process.finish();
      await result;
      expect(process.kills, 1);
      expect(urls, isEmpty);
    },
  );

  test(
    'a cancelled process cannot clear or complete its replacement',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final first = cli.login(onAuthorizeUrl: urls.add);
      final firstResult = expectLater(first, throwsStateError);
      final old = _Process();
      runner.starts.first.complete(old);
      await Future<void>.delayed(Duration.zero);
      cli.cancel();
      final second = cli.login(onAuthorizeUrl: urls.add);
      final secondResult = expectLater(second, throwsStateError);
      final current = _Process();
      runner.starts.last.complete(current);
      await Future<void>.delayed(Duration.zero);
      old.emit({'type': 'authorize_url', 'url': 'https://auth.example/old'});
      old.emit({'type': 'result', 'status': 'success'});
      old.finish();
      await firstResult;
      expect(urls, isEmpty);
      cli.cancel();
      expect(current.kills, 1);
      current.finish();
      await secondResult;
    },
  );

  test(
    'successful CLI sign-in still publishes its URL and completes',
    () async {
      final runner = _Runner();
      final cli = CliLogin(runner: runner);
      final urls = <String>[];
      final login = cli.login(onAuthorizeUrl: urls.add);
      final process = _Process();
      runner.starts.single.complete(process);
      process.emit({
        'type': 'authorize_url',
        'url': 'https://auth.example/current',
      });
      process.emit({'type': 'result', 'status': 'success'});
      process.finish();
      await login;
      cli.cancel();
      expect(urls, ['https://auth.example/current']);
      expect(process.kills, 0);
    },
  );

  group('CliAuthStatus.fromJson', () {
    test('parses a full logged-in payload', () {
      final status = CliAuthStatus.fromJson({
        'loggedIn': true,
        'computerId': 'a' * 32,
        'machineId': 'm_123',
        'autonomousEnv': 'prod',
        'expiresAt': 1234567890,
      });
      expect(status.loggedIn, isTrue);
      expect(status.computerId, 'a' * 32);
      expect(status.machineId, 'm_123');
      expect(status.autonomousEnv, 'prod');
    });

    test('reads the CLI\'s offline flag: signed in, backend out of reach', () {
      final status = CliAuthStatus.fromJson({
        'loggedIn': true,
        'offline': true,
        'machineId': 'm_123',
      });
      expect(status.loggedIn, isTrue);
      expect(status.offline, isTrue);
      expect(CliAuthStatus.fromJson({'loggedIn': true}).offline, isFalse);
    });

    test('parses a logged-out payload with no other fields', () {
      final status = CliAuthStatus.fromJson({'loggedIn': false});
      expect(status.loggedIn, isFalse);
      expect(status.computerId, isNull);
      expect(status.machineId, isNull);
      expect(status.autonomousEnv, isNull);
    });

    test('treats a missing/non-true loggedIn field as logged out', () {
      expect(CliAuthStatus.fromJson({}).loggedIn, isFalse);
      expect(CliAuthStatus.fromJson({'loggedIn': 'true'}).loggedIn, isFalse);
    });
  });
}
