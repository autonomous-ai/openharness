import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/measurement/speed_marks.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/profile_cache.dart';
import 'package:harness/ws/local_cli_discovery.dart';

// Task #3561: the signed-in check (`harness auth status`, ~245 ms on a release build) no longer holds up the window.
// A launch with a kept sign-in opens as that account and the check finishes behind it; whatever the check says then,
// the launch ends where it would have ended had it waited. A memory store and a fake sign-in: nothing here runs the
// real CLI.

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

class _Api extends ApiClient {
  _Api() : super(config: AppConfig.dev, session: AuthSession());
  final profiles = <Completer<Map<String, dynamic>?>>[];
  int desks = 0, lists = 0;
  @override
  Future<Map<String, dynamic>?> desk() async {
    desks++;
    return null;
  }

  @override
  Future<Map<String, dynamic>?> me() {
    final answer = Completer<Map<String, dynamic>?>();
    profiles.add(answer);
    return answer.future;
  }

  @override
  Future<List<Machine>> machines() async {
    lists++;
    return const [];
  }
}

/// `harness auth status`, held until the test answers it.
class _Cli extends CliLogin {
  final answer = Completer<CliAuthStatus>();
  bool fails = false;
  int asked = 0;
  @override
  Future<CliAuthStatus> checkStatus() async {
    asked++;
    if (fails) throw CliNotAvailableException('no CLI');
    return answer.future;
  }

  @override
  Future<void> login({
    void Function(String url)? onAuthorizeUrl,
    SignInProvider? provider,
  }) async {}
  @override
  Future<void> logout() async {}
}

class _Environment extends EnvironmentProvisioner {
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness value) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async {
    final ready = EnvironmentReadiness(
      steps: {
        for (final step in EnvironmentStep.values)
          step: EnvironmentStepStatus.ready,
      },
      phase: EnvironmentSetupPhase.ready,
    );
    onProgress(ready);
    return ready;
  }
}

class _Discovery extends LocalCliDiscovery {
  _Discovery() : super(config: AppConfig.dev);
  @override
  Future<String?> computerId() async => null;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

class _App extends AppNotifier {
  _App(_Cli cli, LocalKeyValueStore storage)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        cliLogin: cli,
        environmentProvisioner: _Environment(),
        localCliDiscovery: _Discovery(),
        paneLayoutStore: PaneLayoutStore(storage: storage),
      );
  Completer<void>? daemon;
  @override
  Future<void> ensureCliDaemonReady() async {
    await daemon?.future;
  }
}

class _Speed implements AppLog {
  _Speed(this.lines);
  final List<String> lines;
  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (category == 'speed') lines.add(message);
  }
}

Future<void> _ticks() async {
  for (var i = 0; i < 30; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

const _ada = CurrentUserProfile(
  id: 'ada',
  email: 'ada@example.invalid',
  name: 'Ada',
);

Map<String, dynamic> _me(String id, String name) => {
  'user': {'id': id, 'email': '$id@example.invalid', 'name': name},
};

/// What RootShell shows: the sign-in page, the workspace, or neither yet.
String _screen(AppNotifier app) {
  if (app.status == AppStatus.unauthenticated) return 'login';
  if (app.status != AppStatus.authenticated) return 'starting';
  return app.signInStepShowing ? 'sign-in' : 'workspace';
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Memory storage;
  late _Cli cli;
  late _Api api;
  late _App app;

  setUp(() {
    storage = _Memory();
    cli = _Cli();
    api = _Api();
    app = _App(cli, storage)..api = api;
    // The CLI's sign-in file is on this computer.
    app.cliSessionOnDisk = () => true;
  });
  tearDown(() => app.dispose());

  Future<void> keptFrom(String machine) =>
      ProfileCache(storage).write(machine, _ada);

  test(
    'signed in: opens on the workspace as the kept account before the check answers',
    () async {
      await keptFrom('machine-a');
      final before = appLog;
      final speed = <String>[];
      appLog = _Speed(speed);
      addTearDown(() => appLog = before);
      speedMarks.restart();

      final boot = app.bootstrap();
      await _ticks();
      expect(cli.answer.isCompleted, isFalse);
      expect(_screen(app), 'workspace');
      expect(app.signedIn, isTrue);
      expect(app.currentUser?.id, 'ada');

      cli.answer.complete(
        const CliAuthStatus(loggedIn: true, machineId: 'machine-a'),
      );
      await boot;
      await _ticks();
      expect(_screen(app), 'workspace');
      expect(app.currentUser?.id, 'ada');
      expect(await ProfileCache(storage).read('machine-a'), isNotNull);

      final steps = [
        for (final line in speed)
          RegExp(r'^launch step=(\S+)').firstMatch(line)?.group(1),
      ];
      expect(steps, containsAll(['window', 'signed-in_check']));
      expect(
        steps.indexOf('window'),
        lessThan(steps.indexOf('signed-in_check')),
        reason: 'the window no longer waits for the signed-in check',
      );
    },
  );

  test(
    'signed out, nothing kept: waits for the check and lands on the sign-in page',
    () async {
      final boot = app.bootstrap();
      await _ticks();
      expect(_screen(app), 'starting');
      cli.answer.complete(const CliAuthStatus(loggedIn: false));
      await boot;
      await _ticks();
      expect(_screen(app), 'sign-in');
      expect(app.signedIn, isFalse);
      expect(app.currentUser, isNull);
    },
  );

  test(
    'a kept profile but no CLI sign-in file (signed out in a terminal) waits for the check',
    () async {
      await keptFrom('machine-a');
      app.cliSessionOnDisk = () => false;
      final boot = app.bootstrap();
      await _ticks();
      expect(_screen(app), 'starting');
      expect(app.currentUser, isNull);
      cli.answer.complete(const CliAuthStatus(loggedIn: false));
      await boot;
      await _ticks();
      expect(_screen(app), 'sign-in');
      expect(storage.values, isNot(contains(ProfileCache.key)));
    },
  );

  test(
    'kept, but the check says signed out: ends on the sign-in page, nobody shown, nothing kept',
    () async {
      await keptFrom('machine-a');
      unawaited(app.bootstrap());
      await _ticks();
      expect(_screen(app), 'workspace');
      cli.answer.complete(const CliAuthStatus(loggedIn: false));
      await _ticks();
      expect(_screen(app), 'sign-in');
      expect(app.signedIn, isFalse);
      expect(app.currentUser, isNull);
      expect(storage.values, isNot(contains(ProfileCache.key)));
    },
  );

  test(
    'kept, and the check says signed out before the window opens: still ends on the sign-in page',
    () async {
      await keptFrom('machine-a');
      app.daemon = Completer<void>();
      final boot = app.bootstrap();
      await _ticks();
      expect(_screen(app), 'starting');
      cli.answer.complete(const CliAuthStatus(loggedIn: false));
      await _ticks();
      app.daemon!.complete();
      await boot;
      await _ticks();
      expect(_screen(app), 'sign-in');
      expect(app.signedIn, isFalse);
      expect(app.currentUser, isNull);
    },
  );

  test(
    'kept, but the check names another machine: signed in, nobody shown until the server answers, the old record gone',
    () async {
      await keptFrom('machine-a');
      unawaited(app.bootstrap());
      await _ticks();
      final first = api.profiles.toList();
      cli.answer.complete(
        const CliAuthStatus(loggedIn: true, machineId: 'machine-b'),
      );
      await _ticks();
      expect(_screen(app), 'workspace');
      expect(app.signedIn, isTrue);
      expect(app.currentUser, isNull);
      expect(storage.values, isNot(contains(ProfileCache.key)));
      // What the server said to the launch that opened as the kept account is not this one's.
      for (final answer in first) {
        answer.complete(_me('ada', 'Ada'));
      }
      await _ticks();
      expect(app.currentUser?.id, isNot('ada'));
    },
  );

  test(
    'kept, but the CLI cannot answer: ends on the login screen, as a launch that waited does',
    () async {
      await keptFrom('machine-a');
      cli.fails = true;
      await app.bootstrap();
      await _ticks();
      expect(_screen(app), 'login');
      expect(app.currentUser, isNull);
    },
  );

  test(
    'nothing of the account is asked before the check proves it: the CLI may be signed in as someone else (review of #3293)',
    () async {
      await keptFrom('machine-a');
      unawaited(app.bootstrap());
      await _ticks();
      expect(_screen(app), 'workspace');
      expect(api.lists, 0, reason: 'no machine list');
      expect(api.desks, 0, reason: 'no desk joined or seeded');
      expect(api.profiles, isEmpty, reason: 'no profile asked');
      cli.answer.complete(
        const CliAuthStatus(loggedIn: true, machineId: 'machine-b'),
      );
      await _ticks();
      // Only the launch that started again from the CLI's answer reads them, as a launch with nothing kept does.
      expect(app.currentUser, isNull);
      expect(storage.values, isNot(contains(ProfileCache.key)));
    },
  );

  test(
    'once the check proves the machine, the account work runs and the server\'s answer is kept',
    () async {
      await keptFrom('machine-a');
      unawaited(app.bootstrap());
      await _ticks();
      expect(api.profiles, isEmpty);
      cli.answer.complete(
        const CliAuthStatus(loggedIn: true, machineId: 'machine-a'),
      );
      await _ticks();
      expect(api.lists, greaterThan(0));
      api.profiles.last.complete(_me('ada', 'Ada Two'));
      await _ticks();
      expect(app.currentUser?.name, 'Ada Two');
      final kept =
          jsonDecode(storage.values[ProfileCache.key]!) as Map<String, dynamic>;
      expect(kept['name'], 'Ada Two');
      expect(kept['machineId'], 'machine-a');
    },
  );

  test(
    'another machine, and the kept record cannot be deleted: the launch starts again once, never from it (review of #3293)',
    () async {
      final stuck = _Undeletable();
      await ProfileCache(stuck).write('machine-a', _ada);
      final again = _App(cli, stuck)..api = api;
      again.cliSessionOnDisk = () => true;
      addTearDown(again.dispose);
      unawaited(again.bootstrap());
      await _ticks();
      cli.answer.complete(
        const CliAuthStatus(loggedIn: true, machineId: 'machine-b'),
      );
      await _ticks();
      expect(_screen(again), 'workspace');
      expect(again.signedIn, isTrue);
      expect(again.currentUser, isNull);
      // The early check, then at most the restarted launch's own.
      expect(cli.asked, lessThanOrEqualTo(2));
    },
  );
}

/// A store whose deletes fail, as a full disk fails the native store's rewrite, while its reads still work.
class _Undeletable extends _Memory {
  @override
  Future<void> delete(String key) async => throw StateError('disk full');
}
