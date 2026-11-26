import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/chat/engine_sign_in.dart';

import '../phone_edge/edge_fixture.dart';

const _localPage =
    'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A57823%2Fcallback&state=s';
const _codePage =
    'https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';

/// A machine's sign-in, answering from [answers] in turn (the last one again once they run out).
class _Machine {
  _Machine(this.answers);
  final List<Map<String, dynamic>> answers;
  final asked = <Map<String, dynamic>>[];
  int signedIn = 0;
  String? opened;
  Future<void> Function(String caught)? deliver;

  EngineSignIn signIn({String engine = 'claude', String? folder}) =>
      EngineSignIn(
    engine: engine,
    folder: folder,
    ask: (payload) async {
      asked.add(payload);
      return answers.length > 1 ? answers.removeAt(0) : answers.first;
    },
    open: (url, deliver) async {
      opened = url;
      this.deliver = deliver;
    },
    signedIn: () async => signedIn++,
    pause: Duration.zero,
  );
}

void main() {
  // Pixel, 2026-11-26: a Claude harness started signed out showed an empty chat over Claude Code's theme picker.
  group('signing an engine in from Chat UI', () {
    test('opens the page the machine answers, hands its redirect back, and starts the harness again once done', () async {
      final machine = _Machine([
        {'ok': true, 'state': 'starting'},
        {'ok': true, 'state': 'page', 'url': _localPage, 'codeUrl': _codePage},
        {'ok': true, 'state': 'checking'},
        {'ok': true, 'state': 'done'},
      ]);
      final signIn = machine.signIn();
      await signIn.start();
      expect(machine.opened, _localPage);
      expect(signIn.opened, isTrue);
      expect(signIn.needsCode, isFalse);
      expect(machine.asked.first['engine'], 'claude');
      final id = machine.asked.first['operationId'];
      expect(
        machine.asked.every((asked) => asked['operationId'] == id),
        isTrue,
      );

      await machine.deliver!('http://localhost:57823/callback?code=c&state=s');
      expect(
        machine.asked[2]['callback'],
        'http://localhost:57823/callback?code=c&state=s',
      );
      expect(signIn.done, isTrue);
      expect(machine.signedIn, 1);
      expect(signIn.error, isNull);
    });

    // MSI, 2026-11-26: Codex took the sign-in while the machine's answer to the redirect came after the phone gave up.
    test('asks again when the redirect\'s answer did not come, and is signed in once the machine says so', () async {
      final machine = _Machine([
        {'ok': true, 'state': 'page', 'url': _localPage, 'codeUrl': null},
        {'error': 'UNAVAILABLE'},
        {'ok': true, 'state': 'done'},
      ]);
      final signIn = machine.signIn(engine: 'codex');
      await signIn.start();
      await machine.deliver!('http://localhost:57823/callback?code=c&state=s');
      expect(signIn.error, isNull);
      expect(signIn.done, isTrue);
      expect(machine.signedIn, 1);
      expect(machine.asked.last['operationId'], machine.asked.first['operationId']);
    });

    test('takes the code from Claude\'s page when the machine had no localhost page', () async {
      final machine = _Machine([
        {'ok': true, 'state': 'page', 'url': _codePage, 'codeUrl': _codePage},
        {'ok': true, 'state': 'done'},
      ]);
      final signIn = machine.signIn();
      await signIn.start();
      expect(signIn.needsCode, isTrue);
      await signIn.submitCode('  abc#def ');
      expect(machine.asked.last['code'], 'abc#def');
      expect(signIn.done, isTrue);
    });

    test('says why it could not, and asks to update a computer whose Harness has no such sign-in', () async {
      final refused = _Machine([
        {
          'error': 'SIGN_IN_FAILED',
          'detail': 'Claude did not take it: Invalid code',
        },
      ]).signIn();
      await refused.start();
      expect(refused.error, 'Claude did not take it: Invalid code');
      expect(refused.opened, isFalse);

      final older = _Machine([
        {'error': 'E2EE_REQUIRED'},
      ]).signIn(engine: 'codex');
      await older.start();
      expect(older.error, 'Update Harness on this computer, then try again.');
      expect(older.done, isFalse);
    });
  });

  // Pixel, 2026-11-26: the page opened, nobody signed in there, and the button stayed on Signing in for good.
  testWidgets(
    'Sign in can be pressed again once the page is open, and starts a new sign-in',
    (tester) async {
      setPhone(tester, largePhone);
      final machine = _Machine([
        {'ok': true, 'state': 'page', 'url': _localPage, 'codeUrl': _codePage},
      ]);
      final signIn = machine.signIn();
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: EngineSignInPanel(
              signIn: signIn,
              engineName: 'Claude Code',
              machineName: 'Harness-BD19',
            ),
          ),
        ),
      );
      await tester.tap(find.text('Sign in'));
      await tester.pump();
      await tester.pump();
      expect(machine.opened, _localPage);
      expect(
        find.text('Finish signing in on the page that opened.'),
        findsOneWidget,
      );
      final first = machine.asked.first['operationId'];
      await tester.tap(find.text('Sign in'));
      await tester.pump();
      await tester.pump();
      expect(machine.asked.last['operationId'], isNot(first));
      await tester.pumpWidget(const SizedBox());
    },
  );

  // MSI, 2026-11-26: signed in from the phone, the app gone before it started the harness again, which waited on
  // Claude Code's theme screen while the chat took words it dropped.
  testWidgets(
    'Continue finishes the setup of an engine signed in already, and starts the harness again',
    (tester) async {
      setPhone(tester, largePhone);
      final machine = _Machine([
        {'ok': true, 'state': 'done'},
      ]);
      final signIn = machine.signIn(folder: '/home/me/projects/claude-1');
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: EngineSignInPanel(
              signIn: signIn,
              setup: true,
              engineName: 'Claude Code',
              machineName: 'Harness-BD19',
            ),
          ),
        ),
      );
      expect(
        find.text('Claude Code needs to finish its setup on Harness-BD19.'),
        findsOneWidget,
      );
      await tester.tap(find.text('Continue'));
      await tester.pump();
      await tester.pump();
      // With the harness's folder, which the machine trusts where Harness made it.
      expect(machine.asked.single, {
        'engine': 'claude',
        'folder': '/home/me/projects/claude-1',
        'firstRun': true,
      });
      expect(machine.signedIn, 1);
      expect(signIn.done, isTrue);
      await tester.pumpWidget(const SizedBox());
    },
  );

  // Pixel, 2026-11-26: a new harness on a new computer showed Continue for ten seconds, then Sign in, while the
  // machine was still being asked.
  testWidgets('offers neither Sign in nor Continue while the machine is still asked', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    await tester.pumpWidget(
      phoneApp(
        Scaffold(
          body: EngineSignInPanel(
            signIn: _Machine([
              {'ok': true, 'state': 'done'},
            ]).signIn(),
            setup: true,
            checking: true,
            engineName: 'Claude Code',
            machineName: 'Harness-BD19',
          ),
        ),
      ),
    );
    expect(find.text('Checking Claude Code on Harness-BD19…'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'Chat UI shows Sign in in the middle while the engine is signed out',
    (tester) async {
      setPhone(tester, largePhone);
      final machine = _Machine([
        {'error': 'UNAVAILABLE'},
      ]);
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: EngineSignInPanel(
              signIn: machine.signIn(),
              engineName: 'Claude Code',
              machineName: 'Harness-BD19',
            ),
          ),
        ),
      );
      await tester.pump();
      expect(
        find.text("Claude Code isn't signed in on Harness-BD19."),
        findsOneWidget,
      );
      await tester.tap(find.text('Sign in'));
      await tester.pump();
      await tester.pump();
      expect(
        find.text('The computer is not reachable. Try again.'),
        findsOneWidget,
      );
      expect(machine.asked.single['engine'], 'claude');
      await tester.pumpWidget(const SizedBox());
    },
  );
}
