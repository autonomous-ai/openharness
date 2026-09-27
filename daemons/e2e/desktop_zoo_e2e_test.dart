// The desktop's own zoo client against a real harnessd in the daemons sandbox (daemons/e2e/sandbox.mjs).
//
// It lives here, beside the sandbox, because the desktop's daemons client is on its own branch: copy it into
// that build's desktop/test/ and point it at the sandbox's harnessd (never the one serving your harnesses):
//
//   cp daemons/e2e/desktop_zoo_e2e_test.dart <desktop build>/desktop/test/
//   HARNESS_DAEMONS_E2E_PORT=<sandbox harnessd port> HARNESS_DAEMONS_E2E_EXPECT=on|off \
//     flutter test test/desktop_zoo_e2e_test.dart
//
// `on`: the window shows the account's zoo. `off` (the server's switch off, harnessd's kill switch, or a
// harnessd from before daemons): nothing daemon-related is drawn — no daemon, no egg, no first-egg hint.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/daemons/zoo_controller.dart';

class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  final port = Platform.environment['HARNESS_DAEMONS_E2E_PORT'];
  final expected = Platform.environment['HARNESS_DAEMONS_E2E_EXPECT'];
  if (port == null || (expected != 'on' && expected != 'off')) {
    test(
      'the zoo client against a real harnessd',
      () {},
      skip: 'Set HARNESS_DAEMONS_E2E_PORT and HARNESS_DAEMONS_E2E_EXPECT=on|off.',
    );
    return;
  }

  test('the zoo client against a real harnessd: daemons $expected', () async {
    final store = _Memory();
    final api = ApiClient(
      config: AppConfig(
        apiBaseUrl: 'http://127.0.0.1:9',
        localCliBaseUrl: 'http://127.0.0.1:$port',
      ),
      session: AuthSession(storage: store),
    );
    final zoo = ZooController(storage: store);
    addTearDown(zoo.dispose);
    zoo.bind('account:e2e', remote: ApiZooTransport(api));
    final deadline = DateTime.now().add(const Duration(seconds: 20));
    while (!zoo.loaded && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    // Long enough for a retry or a guest fallback to land, too.
    await Future<void>.delayed(const Duration(seconds: 2));
    final drawn =
        zoo.loaded &&
        (zoo.zoo.daemons.isNotEmpty ||
            zoo.zoo.eggs.isNotEmpty ||
            zoo.needsHint);
    // ignore: avoid_print
    print(
      'zoo: loaded=${zoo.loaded} source=${zoo.source.name} '
      'daemons=${zoo.zoo.daemons.length} eggs=${zoo.zoo.eggs.length} '
      'hint=${zoo.needsHint} drawn=$drawn',
    );
    if (expected == 'on') {
      expect(zoo.source, ZooSource.account);
    } else {
      expect(
        zoo.source,
        isNot(ZooSource.account),
        reason: 'off: no account zoo',
      );
      expect(
        drawn,
        isFalse,
        reason: 'off: no daemon, egg or first-egg hint is drawn',
      );
    }
  });
}
