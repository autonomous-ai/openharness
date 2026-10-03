import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import 'viewer_app_fixture.dart';

/// Signing a phone in and out: the viewer build's half of `AppNotifier` —
/// bootstrap with no CLI beside it, the emailed code and the scanned QR, and
/// every late reply that must not outlive the session it was asked for.
void main() {
  group('bootstrap', () {
    test('signed out: the welcome screen, and nothing is fetched', () async {
      final rig = viewerApp(signedIn: false);
      addTearDown(rig.app.dispose);

      await rig.app.bootstrap();

      expect(rig.app.status, AppStatus.unauthenticated);
      expect(rig.api.machineFetches, 0);
      expect(rig.app.currentUser, isNull);
    });

    test('signed in: machines and profile, with no step between', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      final seen = <AppStatus>[];
      rig.app.addListener(() => seen.add(rig.app.status));

      await rig.app.bootstrap();
      await settle();

      expect(rig.app.status, AppStatus.authenticated);
      // A viewer installs nothing: the boot spinner, then the app.
      expect(seen.toSet(), {AppStatus.bootstrapping, AppStatus.authenticated});
      expect(rig.app.machines.map((m) => m.machineId), ['m']);
      expect(rig.app.stateOf('m'), isNotNull);
      expect(rig.app.machinesLoading, isFalse);
      expect(rig.app.bootStatusMessage, isNull);
      expect(rig.app.currentUser?.email, 'pat@example.com');
      expect(rig.api.machineFetches, 1, reason: 'fetched once, not twice');
      expect(rig.app.lastError, isNull);
    });

    test('says what it is doing while the machines are coming', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      final list = Completer<List<Machine>>();
      rig.api.onMachines = () => list.future;
      String? message;
      rig.app.addListener(() => message ??= rig.app.bootStatusMessage);

      final boot = rig.app.bootstrap();
      await settle();

      expect(message, 'Getting your machines…');
      list.complete([remoteMachine('m')]);
      await boot;
      expect(rig.app.bootStatusMessage, isNull);
    });

    test('a session store that cannot be read falls back to sign-in', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.signIn.statusFailure = StateError('keychain locked');

      await rig.app.bootstrap();

      expect(rig.app.status, AppStatus.unauthenticated);
      expect(rig.api.machineFetches, 0);
    });

    test('machines that cannot be read leave the app in, saying so', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => throw StateError('relay down');

      await rig.app.bootstrap();

      expect(rig.app.status, AppStatus.authenticated);
      expect(rig.app.lastError, startsWith('Could not load machines'));
      expect(rig.app.lastErrorRetryable, isTrue);
      expect(rig.app.machinesLoading, isFalse);
    });

    test('a profile the account will not give is not an error', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.profile = null;

      await rig.app.bootstrap();
      await settle();

      expect(rig.app.status, AppStatus.authenticated);
      expect(rig.app.currentUser, isNull);
      expect(rig.app.lastError, isNull);
    });
  });

  group('the emailed code', () {
    test('sends the code, then signs in with it', () async {
      final rig = viewerApp(signedIn: false);
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];

      await rig.app.sendLoginCode('pat@example.com');
      await rig.app.signInWithCode(email: 'pat@example.com', code: '1234');
      await settle();

      expect(rig.viewer.emailLogin.codesSent, ['pat@example.com']);
      expect(rig.viewer.emailLogin.signIns, [('pat@example.com', '1234')]);
      expect(rig.app.status, AppStatus.authenticated);
      expect(rig.app.signingIn, isFalse);
      expect(rig.app.machines, hasLength(1));
    });

    test(
      'a wrong code is thrown to the form, never raised as the app\'s error',
      () async {
        final rig = viewerApp(signedIn: false);
        addTearDown(rig.app.dispose);
        rig.viewer.emailLogin.failure = StateError('That code is wrong');

        await expectLater(
          rig.app.signInWithCode(email: 'pat@example.com', code: '0000'),
          throwsStateError,
        );

        expect(rig.app.status, AppStatus.unauthenticated);
        expect(rig.app.signingIn, isFalse);
        expect(rig.app.lastError, isNull);
        expect(rig.api.machineFetches, 0);
      },
    );

    test('a second press while the first is in the air does nothing', () async {
      final rig = viewerApp(signedIn: false);
      addTearDown(rig.app.dispose);
      final gate = rig.viewer.emailLogin.gate = Completer<void>();

      final first = rig.app.signInWithCode(email: 'a@b.co', code: '1111');
      await rig.app.signInWithCode(email: 'a@b.co', code: '1111');
      expect(rig.viewer.emailLogin.signIns, hasLength(1));
      expect(rig.app.signingIn, isTrue);

      gate.complete();
      await first;
      expect(rig.app.signingIn, isFalse);
    });

    test(
      'signing out while the code is checked keeps the phone signed out',
      () async {
        final rig = viewerApp(signedIn: false);
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [remoteMachine('m')];
        final gate = rig.viewer.emailLogin.gate = Completer<void>();

        final signIn = rig.app.signInWithCode(email: 'a@b.co', code: '1111');
        await settle();
        await rig.app.logout();
        gate.complete();
        await signIn;
        await settle();

        expect(rig.app.status, AppStatus.unauthenticated);
        expect(rig.app.signingIn, isFalse);
        expect(rig.app.machines, isEmpty);
        expect(rig.api.machineFetches, 0);
      },
    );
  });

  group('the scanned QR', () {
    test('signs in with the code, naming this phone', () async {
      final rig = viewerApp(signedIn: false);
      addTearDown(rig.app.dispose);

      // Named before anybody is signed in: the phone's own name, not an account's.
      final named = rig.app.phoneClientDescriptor().name;
      await rig.app.signInWithScan('HANDOFF');
      await settle();

      final (code, label) = rig.viewer.emailLogin.scans.single;
      expect(code, 'HANDOFF');
      expect(label, named);
      expect(rig.app.status, AppStatus.authenticated);
    });

    test('a spent code is thrown for the email fallback', () async {
      final rig = viewerApp(signedIn: false);
      addTearDown(rig.app.dispose);
      rig.viewer.emailLogin.failure = StateError('expired');

      await expectLater(rig.app.signInWithScan('OLD'), throwsStateError);

      expect(rig.app.status, AppStatus.unauthenticated);
      expect(rig.app.signingIn, isFalse);
    });

    test('nothing happens after the app is gone', () async {
      final rig = viewerApp(signedIn: false);
      rig.app.dispose();

      await rig.app.signInWithScan('HANDOFF');
      await rig.app.signInWithCode(email: 'a@b.co', code: '1');

      expect(rig.viewer.emailLogin.scans, isEmpty);
      expect(rig.viewer.emailLogin.signIns, isEmpty);
    });
  });

  group('signing out', () {
    test('forgets the account, its machines and its sockets', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();

      await rig.app.logout();

      expect(rig.app.status, AppStatus.unauthenticated);
      expect(rig.app.machines, isEmpty);
      expect(rig.app.machineStates, isEmpty);
      expect(rig.app.currentUser, isNull);
      expect(rig.app.selectedMachineId, isNull);
      expect(rig.signIn.logouts, 1);
    });

    test('a machine list that lands after sign-out is thrown away', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      final list = Completer<List<Machine>>();
      rig.api.onMachines = () => list.future;

      final boot = rig.app.bootstrap();
      await settle();
      await rig.app.logout();
      list.complete([remoteMachine('m')]);
      await boot;
      await settle();

      expect(rig.app.status, AppStatus.unauthenticated);
      expect(rig.app.machines, isEmpty);
      expect(rig.app.machineStates, isEmpty);
    });

    test('an agent created while signing out does not come back', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();
      final reply = Completer<Map<String, dynamic>>();
      rig.conn('m').answers['agent_create'] = (_) => reply.future;
      final attempt = AgentCreationAttempt();

      final creating = rig.app.createAgent(
        'm',
        engine: 'claude',
        folder: '/work',
        attempt: attempt,
      );
      await settle();
      await rig.app.logout();
      final creationId = rig.conn('m').payloadsOf('agent_create').single;
      reply.complete({
        'creationId': creationId['creationId'],
        'state': 'created',
        'agent': agentJson('new'),
      });

      expect(await creating, isNull, reason: 'the machine did start it');
      expect(attempt.agentId, 'new');
      expect(rig.app.machineStates, isEmpty);
      expect(
        rig.app.allPanes,
        isEmpty,
        reason: 'no terminal for a signed-out phone',
      );
    });

    test(
      'a session revoked under a running app lands on sign-in, once',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.api.onMachines = () async => [remoteMachine('m')];
        await rig.app.bootstrap();
        await settle();
        var redraws = 0;
        rig.app.addListener(() => redraws++);

        rig.app.authFailureForTest('Your sign-in expired. Sign in again.');
        rig.app.authFailureForTest('Your sign-in expired. Sign in again.');

        expect(rig.app.status, AppStatus.unauthenticated);
        expect(rig.app.lastError, 'Your sign-in expired. Sign in again.');
        expect(rig.app.currentUser, isNull);
        expect(redraws, 1, reason: 'several sockets can race to say so');
      },
    );
  });

  group('the token a relay socket dials with', () {
    test('is the session\'s own', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      await rig.app.session.saveLogin(token: 'hna_live', refreshToken: 'r1');

      expect(await rig.app.socketTokenForTest(), 'hna_live');
      expect(
        await rig.app.socketTokenForTest(failedToken: 'hna_older'),
        'hna_live',
        reason: 'someone already refreshed past the one that failed',
      );
    });

    test('no session at all signs the phone out', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);

      await expectLater(
        rig.app.socketTokenForTest(),
        throwsA(isA<WsCredentialRevoked>()),
      );
    });

    test('a refresh the backend refuses signs the phone out', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      await rig.app.session.saveLogin(token: 'hna_old', refreshToken: 'r1');
      rig.viewer.backend.replies['/api/auth/refresh'] = (
        status: 401,
        body: {'success': false},
      );

      await expectLater(
        rig.app.socketTokenForTest(force: true),
        throwsA(isA<WsCredentialRevoked>()),
      );
    });

    test(
      'a refresh that cannot reach the backend is retried, not a sign-out',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        await rig.app.session.saveLogin(token: 'hna_old', refreshToken: 'r1');

        await expectLater(
          rig.app.socketTokenForTest(force: true),
          throwsA(
            isA<Object>().having(
              (error) => error is WsCredentialRevoked,
              'a sign-out',
              isFalse,
            ),
          ),
        );
        expect(await rig.app.session.accessToken(), 'hna_old');
      },
    );
  });
}
