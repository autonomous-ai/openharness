import 'package:flutter_test/flutter_test.dart';
import 'package:harness/e2ee/keys.dart';
import 'package:harness/viewer/password_link.dart';
import 'package:harness/ws/ws_conn.dart' show declaredAppVersion;

/// A password link's socket says what it is and which build (WebSocket roadmap Phase 0): without the
/// version it counted against the 95% of web-ws connects that must name both.
void main() {
  test('a password link dials saying it is a link, and the build', () async {
    declaredAppVersion = '1.3.64';
    addTearDown(() => declaredAppVersion = null);
    Uri? dialled;
    await expectLater(
      linkWithPassword(
        machineId: 'a' * 32,
        password: 'pw',
        identity: await E2eeIdentity.generate(),
        accessToken: 't',
        wsBaseUrl: 'wss://relay.test',
        autonomousEnv: 'prod',
        socket: (uri, _) {
          dialled = uri;
          throw StateError('no network in tests');
        },
      ),
      throwsStateError,
    );
    expect(
      dialled.toString(),
      'wss://relay.test/api/web-ws?autonomousEnv=prod&client=link&v=1.3.64',
    );
  });
}
