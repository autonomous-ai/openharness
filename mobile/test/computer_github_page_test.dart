import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/computer_github_page.dart';
import 'package:harness_mobile/state/app_state.dart';

/// A Harness OS computer answering `os_device` `github` as CLI osDevice.ts does: signed out, then a
/// code while its sign-in waits, then the account once [enter] says the code was entered.
class _App extends AppNotifier {
  _App({this.login})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    machines = [box];
    machineStates['box'] = MachineState(box)..nodeOnline = true;
  }

  static const box = Machine(
    machineId: 'box',
    authMode: MachineAuthMode.remote,
    name: 'Harness-BD19',
  );

  String? login;
  bool waiting = false;
  final asked = <String>[];

  void enter() {
    waiting = false;
    login = 'octo';
  }

  @override
  Future<Map<String, dynamic>> osDevice(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 25),
  }) async {
    if (payload['action'] != 'github') return {'error': 'BAD_REQUEST'};
    final state = payload['state'] as String;
    asked.add(state);
    if (state == 'sign_in' && login == null) waiting = true;
    if (state == 'sign_out') login = null;
    return {
      'login': login,
      if (waiting)
        'signingIn': {
          'code': 'AB12-CD34',
          'url': 'https://github.com/login/device',
        },
    };
  }
}

void main() {
  Future<(_App, List<Uri>)> pump(WidgetTester tester, {String? login}) async {
    final app = _App(login: login);
    addTearDown(app.dispose);
    final opened = <Uri>[];
    await tester.pumpWidget(
      MaterialApp(
        home: ComputerGithubPage(
          notifier: app,
          machineId: 'box',
          openPage: (url) async => opened.add(url),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (app, opened);
  }

  testWidgets(
    'signs in with a code entered on GitHub\'s page, the code copied for it',
    (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String;
          }
          return null;
        },
      );
      final (app, opened) = await pump(tester);
      expect(find.byKey(const Key('github-sign-in')), findsOneWidget);

      await tester.tap(find.byKey(const Key('github-sign-in')));
      await tester.pumpAndSettle();
      expect(find.text('AB12-CD34'), findsOneWidget);

      await tester.tap(find.byKey(const Key('github-open')));
      await tester.pumpAndSettle();
      expect(copied, 'AB12-CD34');
      expect(opened, [Uri.parse('https://github.com/login/device')]);

      // Entered on GitHub: the page follows the sign-in on its own, to the account.
      app.enter();
      await tester.pump(const Duration(seconds: 3));
      await tester.pumpAndSettle();
      expect(find.text('@octo'), findsOneWidget);
      expect(find.byKey(const Key('github-sign-out')), findsOneWidget);
      expect(app.asked.first, 'status');
      expect(app.asked, contains('sign_in'));
    },
  );

  testWidgets('signs out, once asked', (tester) async {
    final (app, _) = await pump(tester, login: 'octo');
    expect(find.text('@octo'), findsOneWidget);

    await tester.tap(find.byKey(const Key('github-sign-out')));
    await tester.pumpAndSettle();
    expect(find.text('Sign Harness-BD19 out of GitHub?'), findsOneWidget);
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();

    expect(app.asked.last, 'sign_out');
    expect(find.byKey(const Key('github-sign-in')), findsOneWidget);
  });
}
