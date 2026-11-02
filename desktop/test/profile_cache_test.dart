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
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/state/profile_cache.dart';
import 'package:harness/ws/local_cli_discovery.dart';

// Task #2169: the last profile of the same signed-in account shows at once, and another account's never does. A machine
// row has one owner, and a new sign-in writes a session with no machine id until its own is resolved, so the machine id
// `harness auth status` names proves the account with no network.

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
  @override
  Future<Map<String, dynamic>?> desk() async => null;
  @override
  Future<Map<String, dynamic>?> me() {
    final answer = Completer<Map<String, dynamic>?>();
    profiles.add(answer);
    return answer.future;
  }

  @override
  Future<List<Machine>> machines() async => const [];
}

class _Cli extends CliLogin {
  _Cli(this.status);
  CliAuthStatus status;
  @override
  Future<CliAuthStatus> checkStatus() async => status;
  @override
  Future<void> login({void Function(String url)? onAuthorizeUrl, SignInProvider? provider}) async {}
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
      steps: {for (final step in EnvironmentStep.values) step: EnvironmentStepStatus.ready},
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
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async => null;
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
  CurrentUserProfile? atDaemon;
  @override
  Future<void> ensureCliDaemonReady() async {
    await Future<void>.delayed(Duration.zero);
    atDaemon = currentUser;
    await daemon?.future;
  }
}

Map<String, dynamic> _me(String id) => {
  'user': {'id': id, 'email': '$id@example.invalid', 'name': id},
};

Future<void> _ticks() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late _Memory storage;
  final apps = <_App>[];
  final apis = <_Api>[];

  Future<({_App app, _Api api})> open(String? machine, {bool loggedIn = true}) async {
    final api = _Api();
    final app = _App(_Cli(CliAuthStatus(loggedIn: loggedIn, machineId: machine)), storage)..api = api;
    apps.add(app);
    apis.add(api);
    await app.bootstrap();
    await _ticks();
    return (app: app, api: api);
  }

  setUp(() => storage = _Memory());
  tearDown(() {
    for (final app in apps) {
      app.dispose();
    }
    apps.clear();
  });

  Future<void> signedInBefore(String machine, String id) async {
    final first = await open(machine);
    first.api.profiles.single.complete(_me(id));
    await _ticks();
    expect(first.app.currentUser?.id, id);
  }

  test('the same machine shows the last profile before the daemon, the server or anything else answers', () async {
    await signedInBefore('machine-a', 'ada');
    final again = await open('machine-a');
    expect(again.app.atDaemon?.id, 'ada');
    expect(again.app.currentUser?.email, 'ada@example.invalid');
  });

  test('refreshes it behind: the server\'s answer replaces what shows, and what is kept', () async {
    await signedInBefore('machine-a', 'ada');
    final again = await open('machine-a');
    again.api.profiles.single.complete({
      'user': {'id': 'ada', 'email': 'ada@example.invalid', 'name': 'Ada Lovelace'},
    });
    await _ticks();
    expect(again.app.currentUser?.name, 'Ada Lovelace');
    final third = await open('machine-a');
    expect(third.app.atDaemon?.name, 'Ada Lovelace');
  });

  test('another machine id shows nobody, and removes what was kept', () async {
    await signedInBefore('machine-a', 'ada');
    final other = await open('machine-b');
    expect(other.app.atDaemon, isNull);
    expect(other.app.currentUser, isNull);
    expect(await ProfileCache(storage).read('machine-a'), isNull);
  });

  test('a session with no machine id yet, or an older CLI, shows nobody', () async {
    await signedInBefore('machine-a', 'ada');
    final other = await open(null);
    expect(other.app.atDaemon, isNull);
    expect(other.app.currentUser, isNull);
  });

  test('never keeps a profile with no machine id to prove it', () async {
    final first = await open(null);
    first.api.profiles.single.complete(_me('ada'));
    await _ticks();
    expect(storage.values, isNot(contains(ProfileCache.key)));
  });

  test('if the server names another account, it wins, and the old one is not kept', () async {
    await signedInBefore('machine-a', 'ada');
    final again = await open('machine-a');
    again.api.profiles.single.complete(_me('grace'));
    await _ticks();
    expect(again.app.currentUser?.id, 'grace');
    expect((await ProfileCache(storage).read('machine-a'))?.id, 'grace');
  });

  test('a signed-out computer shows nobody and removes it', () async {
    await signedInBefore('machine-a', 'ada');
    final out = await open(null, loggedIn: false);
    expect(out.app.currentUser, isNull);
    expect(storage.values, isNot(contains(ProfileCache.key)));
  });

  test('signing out removes it, and a late answer from before does not bring it back', () async {
    await signedInBefore('machine-a', 'ada');
    final again = await open('machine-a');
    await again.app.logout();
    expect(storage.values, isNot(contains(ProfileCache.key)));
    again.api.profiles.single.complete(_me('ada'));
    await _ticks();
    expect(storage.values, isNot(contains(ProfileCache.key)));
  });

  group('what is kept on disk', () {
    final good = {'machineId': 'machine-a', 'id': 'ada', 'email': 'ada@example.invalid', 'name': 'Ada', 'avatarUrl': null};
    for (final (name, stored) in [
      ('not JSON', 'not json'),
      ('not an object', '[]'),
      ('with no id', jsonEncode({...good, 'id': null})),
      ('with an empty id', jsonEncode({...good, 'id': ''})),
      ('with no email', jsonEncode({...good, 'email': null})),
      ('of a wrong type', jsonEncode({...good, 'name': 7})),
    ]) {
      test('reads as none when it is $name', () async {
        storage.values[ProfileCache.key] = stored;
        expect(await ProfileCache(storage).read('machine-a'), isNull);
      });
    }

    test('holds no more than who the person is', () async {
      await ProfileCache(storage).write('machine-a', const CurrentUserProfile(id: 'ada', email: 'a@example.invalid', name: 'Ada'));
      expect((jsonDecode(storage.values[ProfileCache.key]!) as Map).keys.toSet(), {'machineId', 'id', 'email', 'name', 'avatarUrl'});
    });

    test('a store that fails reads as none, and a failed write changes nothing', () async {
      expect(await ProfileCache(null).read('machine-a'), isNull);
      await ProfileCache(null).write('machine-a', const CurrentUserProfile(id: 'ada', email: 'a@example.invalid'));
      await ProfileCache(null).clear();
    });
  });
}
