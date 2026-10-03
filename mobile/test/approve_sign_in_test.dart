import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/approve_sign_in.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Answers the QR sign-in routes from a script, and records what the phone said.
class _Api extends ApiClient {
  _Api(this.asking) : super(config: AppConfig.dev, session: AuthSession());

  final Map<String, dynamic> asking;
  final answers = <String>[];

  @override
  Future<Map<String, dynamic>> signInLookup(String code) async => asking;
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

  testWidgets('a code already answered asks nothing', (tester) async {
    final api = await pump(tester, {'label': 'x', 'kind': 'computer', 'sameNetwork': true, 'status': 'approved'});
    expect(find.byKey(const Key('approve-sign-in-title')), findsNothing);
    expect(api.answers, isEmpty);
  });
}
