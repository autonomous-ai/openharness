import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

/// `harness login --qr --json`, held open: the test plays the link leg's events itself.
class _PhoneLogin extends CliLogin {
  SignInQrListener? listener;
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInQrListener? qr,
  }) {
    listener = qr;
    return Completer<void>().future;
  }

  @override
  void cancel() {}
}

/// The sign-in sheet over a guest desk, its QR sign-in started and — as far as the sheet can
/// tell — signed in: what remains is the phone's link, which the test reports.
Future<(AppNotifier, SignInQrListener, Future<bool>)> _signedInByPhone(
  WidgetTester tester,
) async {
  grid.AppTheme.brightness.value = Brightness.light;
  signInSheetStartsQr = true;
  addTearDown(() => signInSheetStartsQr = false);
  final login = _PhoneLogin();
  final app =
      AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
          cliLogin: login,
        )
        ..status = AppStatus.authenticated
        ..signedIn = false;
  addTearDown(app.dispose);
  late Future<bool> closed;
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => closed = showSignInSheet(context, app),
          child: const Text('open'),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pump();
  await tester.pump();
  app.signedIn = true;
  return (app, login.listener!, closed);
}

String _title(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const Key('login-title'))).data!;

void main() {
  testWidgets(
    'the sheet shows the link steps and goes back once the group is synced',
    (tester) async {
      final (app, qr, closed) = await _signedInByPhone(tester);

      qr.onProgress!('linked', {'label': 'Dee’s iPhone'});
      await tester.pump();
      expect(find.byKey(const Key('login-phone-link')), findsOneWidget);
      expect(_title(tester), 'Adding this computer to your devices');
      expect(find.text('Linked with Dee’s iPhone'), findsOneWidget);
      expect(
        find.text('Adding this computer to your devices…'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('login-qr')), findsNothing);

      qr.onProgress!('synced', {
        'machines': [
          {'machineId': 'a', 'name': 'studio'},
          {'machineId': 'b', 'name': 'box-2'},
        ],
      });
      await tester.pump();
      expect(find.text('Reaches 2 machines: studio · box-2'), findsOneWidget);
      // Held long enough to read, then back to the desk.
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const Key('login-phone-link')), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.byKey(const Key('login-phone-link')), findsNothing);
      expect(await closed, isTrue);
      expect(app.phoneLink, isNull);
    },
  );

  testWidgets(
    'a link that stops short says so, then goes back to the desk by itself',
    (tester) async {
      final (app, qr, closed) = await _signedInByPhone(tester);
      qr.onProgress!('linked', {'label': 'Pixel'});
      qr.onProgress!('ended', const {});
      await tester.pump();
      expect(app.phoneLink?.stage, PhoneLinkStage.failed);
      expect(find.byKey(const Key('login-phone-link-error')), findsOneWidget);
      // Long enough to read, then the desk — signed in all the same.
      await tester.pump(const Duration(seconds: 3));
      expect(find.byKey(const Key('login-phone-link')), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(find.byKey(const Key('login-phone-link')), findsNothing);
      expect(await closed, isTrue);
    },
  );

  testWidgets('an error result names what went wrong', (tester) async {
    final (app, qr, _) = await _signedInByPhone(tester);
    qr.onProgress!('result', {
      'status': 'error',
      'message': 'DAEMON_UNREACHABLE',
    });
    await tester.pump();
    expect(app.phoneLink?.stage, PhoneLinkStage.failed);
    expect(
      tester.widget<Text>(find.byKey(const Key('login-phone-link-error'))).data,
      contains('(DAEMON_UNREACHABLE)'),
    );
    // The sheet moves on by itself; let it.
    await tester.pump(const Duration(seconds: 5));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
  });
}
