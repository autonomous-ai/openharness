import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/viewer/direct_auth_api.dart';
import 'package:harness_mobile/viewer/viewer_key_store.dart';
import 'package:harness_mobile/viewer/viewer_services.dart';
import 'package:harness_mobile/ws/terminal_transport_plugin.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;

/// What a phone runs in place of the harness CLI, built once — and the parts of the CLI's
/// sign-in contract a phone still answers (whether it is signed in; signing out).
void main() {
  const config = AppConfig(
    apiBaseUrl: 'https://h.invalid',
    autonomousEnv: 'stag',
  );

  test('one session and one key store behind every service', () async {
    final session = AuthSession(storage: MemoryKeyValueStore());
    final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
    final services = ViewerServices(
      config: config,
      session: session,
      keys: keys,
    );

    expect(services.keys, same(keys));
    expect(services.auth.session, same(session));
    expect(services.login.auth, same(services.auth));
    expect(services.emailLogin.auth, same(services.auth));
    expect(services.links.keys, same(keys));
    expect(services.links.config.autonomousEnv, 'stag');
    // No machine linked yet: nothing to open a session with.
    expect(await services.relayCodecs('m'), isNull);
  });

  test('the second wire is the one main() set, unless one is given', () {
    final session = AuthSession(storage: MemoryKeyValueStore());
    final keys = ViewerKeyStore(storage: MemoryKeyValueStore());
    final previous = harnessTransportPlugins;
    addTearDown(() => harnessTransportPlugins = previous);

    harnessTransportPlugins = null;
    expect(
      ViewerServices(
        config: config,
        session: session,
        keys: keys,
      ).transportPlugins,
      isNull,
    );

    TerminalTransportPlugin set(TerminalTransportHost host, String id) =>
        throw UnimplementedError();
    TerminalTransportPlugin given(TerminalTransportHost host, String id) =>
        throw UnimplementedError();
    harnessTransportPlugins = set;
    expect(
      ViewerServices(
        config: config,
        session: session,
        keys: keys,
      ).transportPlugins,
      same(set),
    );
    expect(
      ViewerServices(
        config: config,
        session: session,
        keys: keys,
        transportPlugins: given,
      ).transportPlugins,
      same(given),
    );
  });

  group('the sign-in client', () {
    test('is signed in exactly when a token is saved', () async {
      final session = AuthSession(storage: MemoryKeyValueStore());
      final login = ViewerServices(
        config: config,
        session: session,
        keys: ViewerKeyStore(storage: MemoryKeyValueStore()),
      ).login;
      expect((await login.checkStatus()).loggedIn, isFalse);
      await login.auth.signIn(const IssuedTokens(token: 't'));
      expect((await login.checkStatus()).loggedIn, isTrue);

      await login.logout();
      expect((await login.checkStatus()).loggedIn, isFalse);
      expect(await session.accessToken(), isNull);
    });
  });
}
