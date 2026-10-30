import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/approve_sign_in.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Answers the QR sign-in routes from a script, and records what the phone said.
class _Api extends ApiClient {
  _Api(this.asking) : super(config: AppConfig.dev, session: AuthSession());

  final Map<String, dynamic> asking;
  final looked = <String>[];
  final answers = <String>[];

  @override
  Future<Map<String, dynamic>> signInLookup(String code) async {
    looked.add(code);
    return asking;
  }
  @override
  Future<void> approveSignIn(String code) async => answers.add('approve:$code');
  @override
  Future<void> denySignIn(String code) async => answers.add('deny:$code');
}

final _code = 'hnq_${'a' * 43}';

void main() {
  group('SignInCode', () {
    test('reads the link a computer shows, and nothing else', () {
      expect(SignInCode.parse(SignInCode.link(_code))?.code, _code);
      expect(SignInCode.parse('https://harness.autonomous.ai/signin#k=nope'), isNull);
      expect(SignInCode.parse('https://evil.example/signin#k=$_code'), isNull);
      expect(SignInCode.parse(ConnectCode.link('dee@example.com')), isNull);
    });
  });

  Future<_Api> pump(WidgetTester tester, Map<String, dynamic> asking) async {
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null);
    addTearDown(app.dispose);
    final api = _Api(asking);
    app.api = api;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => approveComputerSignIn(context, app, SignInCode(_code)),
              child: const Text('go'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    return api;
  }

  testWidgets('a computer on this network is approved with a tap', (tester) async {
    final api = await pump(tester, {'label': 'MacBook Pro', 'kind': 'computer', 'sameNetwork': true, 'status': 'pending'});
    expect(find.text('Sign in MacBook Pro?'), findsOneWidget);
    expect(find.textContaining('same network'), findsOneWidget);
    await tester.tap(find.byKey(const Key('approve-sign-in-approve')));
    await tester.pumpAndSettle();
    expect(api.answers, ['approve:$_code']);
  });

  testWidgets('a computer on another network says where, and a tap does not approve it', (tester) async {
    final api = await pump(tester, {'label': 'MacBook Pro', 'kind': 'computer', 'sameNetwork': false, 'country': 'VN', 'ipHint': '1.2.3.x', 'status': 'pending'});
    expect(find.textContaining('another network (VN · 1.2.3.x)'), findsOneWidget);
    expect(find.byKey(const Key('approve-sign-in-approve')), findsNothing);
    await tester.tap(find.byKey(const Key('approve-sign-in-hold')));
    await tester.pumpAndSettle();
    expect(api.answers, isEmpty);
    // Held for the whole two seconds: approved.
    final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('approve-sign-in-hold'))));
    await tester.pump(const Duration(milliseconds: 2100));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(api.answers, ['approve:$_code']);
  });

  testWidgets('"Not me" denies it', (tester) async {
    final api = await pump(tester, {'label': 'MacBook Pro', 'kind': 'computer', 'sameNetwork': false, 'status': 'pending'});
    await tester.tap(find.byKey(const Key('approve-sign-in-deny')));
    await tester.pumpAndSettle();
    expect(api.answers, ['deny:$_code']);
  });

  testWidgets('a computer with no name is "a computer", never "Sign in A computer?"', (tester) async {
    await pump(tester, {'label': '  ', 'kind': 'computer', 'sameNetwork': true, 'status': 'pending'});
    expect(find.text('Sign in a computer?'), findsOneWidget);
    expect(find.textContaining('A computer?'), findsNothing);
  });

  testWidgets('an app with no name is "an app", not a computer', (tester) async {
    await pump(tester, {'kind': 'viewer', 'sameNetwork': true, 'status': 'pending'});
    expect(find.text('Sign in an app?'), findsOneWidget);
    expect(find.textContaining('computer?'), findsNothing);
  });

  testWidgets('an app with a name is asked by its name', (tester) async {
    await pump(tester, {'label': 'Harness in Safari', 'kind': 'viewer', 'sameNetwork': true, 'status': 'pending'});
    expect(find.text('Sign in Harness in Safari?'), findsOneWidget);
  });

  testWidgets('a code already answered asks nothing', (tester) async {
    final api = await pump(tester, {'label': 'x', 'kind': 'computer', 'sameNetwork': true, 'status': 'approved'});
    expect(find.byKey(const Key('approve-sign-in-title')), findsNothing);
    expect(api.answers, isEmpty);
  });

  group('Settings ▸ Sign in a computer', () {
    /// Settings' row opening the camera — [signInAComputer] with no real camera behind it.
    Future<_Api> open(WidgetTester tester, {Size size = const Size(430, 932), String status = 'pending'}) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = size;
      addTearDown(tester.view.reset);
      final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null);
      addTearDown(app.dispose);
      final api = _Api({'label': 'build-box', 'kind': 'computer', 'sameNetwork': true, 'status': status});
      app.api = api;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => signInAComputer(context, app, camera: const SizedBox()),
                child: const Text('go'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();
      return api;
    }

    testWidgets('the camera sends the person to a terminal: harness login --qr', (tester) async {
      await open(tester);
      expect(find.text('Scan the code in the terminal'), findsOneWidget);
      expect(find.text('On a server, run harness login --qr'), findsOneWidget);
      // The desktop app signs in on its own page and shows no QR any more.
      expect(find.textContaining('Scan with your phone'), findsNothing);
    });

    testWidgets('on a narrow phone the hint wraps whole rather than running off the screen', (tester) async {
      await open(tester, size: const Size(320, 568));
      expect(tester.takeException(), isNull);
      final hint = tester.getRect(find.byKey(const ValueKey('scan-hint')));
      expect(hint.left, greaterThanOrEqualTo(0));
      expect(hint.right, lessThanOrEqualTo(320));
      expect(hint.bottom, lessThanOrEqualTo(568));
    });

    testWidgets('a scanned code goes on to the approval', (tester) async {
      final api = await open(tester);
      tester.widget<ScanToConnectPage>(find.byType(ScanToConnectPage)).onSignInCode!(SignInCode(_code));
      await tester.pumpAndSettle();
      expect(find.byType(ScanToConnectPage), findsNothing);
      expect(find.text('Sign in build-box?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('approve-sign-in-approve')));
      await tester.pumpAndSettle();
      expect(api.answers, ['approve:$_code']);
    });

    testWidgets('Back goes back and asks nothing', (tester) async {
      final api = await open(tester);
      tester.widget<ScanToConnectPage>(find.byType(ScanToConnectPage)).onBack();
      await tester.pumpAndSettle();
      expect(find.byType(ScanToConnectPage), findsNothing);
      expect(api.looked, isEmpty);
      expect(api.answers, isEmpty);
    });

    // A device with no screen (a lamp, #1410) says eight digits aloud instead of showing a QR.
    testWidgets('Type a code instead takes the eight digits a device says, on to the approval', (tester) async {
      final api = await open(tester);
      await tester.tap(find.text('Type a code instead'));
      await tester.pumpAndSettle();
      expect(find.byType(ScanToConnectPage), findsNothing);
      final field = find.byKey(const Key('sign-in-code-field'));
      final next = find.byKey(const Key('sign-in-code-continue'));
      await tester.enterText(field, '1234 567');
      await tester.pump();
      expect(tester.widget<FilledButton>(next).onPressed, isNull);
      await tester.enterText(field, '1234 5678');
      await tester.pump();
      await tester.tap(next);
      await tester.pumpAndSettle();
      expect(api.looked, ['12345678']);
      expect(find.text('Sign in build-box?'), findsOneWidget);
      await tester.tap(find.byKey(const Key('approve-sign-in-approve')));
      await tester.pumpAndSettle();
      expect(api.answers, ['approve:12345678']);
    });

    testWidgets('a typed code someone else answered warns before the device asks', (tester) async {
      final api = await open(tester, status: 'approved');
      await tester.tap(find.text('Type a code instead'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Never type a code someone sent you'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('sign-in-code-field')), '12345678');
      await tester.pump();
      await tester.tap(find.byKey(const Key('sign-in-code-continue')));
      await tester.pumpAndSettle();
      expect(find.textContaining('Someone else already answered this code'), findsOneWidget);
      expect(api.answers, isEmpty);
    });

    testWidgets('a typed code can be dropped without asking anything', (tester) async {
      final api = await open(tester);
      await tester.tap(find.text('Type a code instead'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('sign-in-code-cancel')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('sign-in-code-field')), findsNothing);
      expect(api.looked, isEmpty);
    });
  });
}
