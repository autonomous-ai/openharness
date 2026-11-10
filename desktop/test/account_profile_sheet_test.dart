// The avatar menu's Profile (task #2654): a person changes their own account
// name from one sheet. The account name goes to the backend's PATCH
// /api/auth/me through a fake API. A memory store and a fake sign-in: nothing
// here reaches the real CLI or signs this Mac out.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/account_profile_sheet.dart';

import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore, createApp;

/// The backend's account name route, as the daemon answers it.
class NameApi extends ApiClient {
  NameApi() : super(config: AppConfig.dev, session: AuthSession());

  final sent = <String>[];

  /// The next answer's refusal: (HTTP status, message).
  (int, String)? refuse;

  @override
  Future<Map<String, dynamic>?> updateMe({required String name}) async {
    sent.add(name);
    if (refuse case (final status, final message)) {
      refuse = null;
      throw ApiException(message, status: status);
    }
    return {
      'user': {'id': 'owner', 'email': 'owner@example.com', 'name': name},
      'avatarUrl': null,
      'description': null,
    };
  }
}

final _name = find.byKey(const ValueKey('account-profile-name'));
final _save = find.byKey(const ValueKey('account-profile-save'));

AppNotifier profileApp(NameApi api, {String? name = 'phorom12a'}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
  )..signedIn = true;
  app.api = api;
  app.currentUser = CurrentUserProfile(
    id: 'owner',
    name: name,
    email: 'owner@example.com',
  );
  return app;
}

Future<void> _open(WidgetTester tester, AppNotifier app) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showAccountProfileSheet(context, app),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

/// The line said under a field, by its key.
String? _said(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(ValueKey(key))).data;

String _text(WidgetTester tester, Finder field) =>
    tester.widget<TextField>(field).controller!.text;

void main() {
  testWidgets('shows the account name, and has no username of a Swarm', (
    tester,
  ) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    expect(find.text('Profile'), findsOneWidget);
    expect(_text(tester, _name), 'phorom12a');
    expect(find.text('Username'), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('Save sends the account name, tidied, and closes the sheet', (
    tester,
  ) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, '  Elvis ');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(api.sent, ['Elvis']);
    expect(app.currentUser!.name, 'Elvis');
    expect(find.text('Profile'), findsNothing);
  });

  testWidgets('a name that is not changed sends nothing and closes', (
    tester,
  ) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(api.sent, isEmpty);
    expect(find.text('Profile'), findsNothing);
  });

  testWidgets('an empty name says why and sends nothing', (tester) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, '   ');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(
      _said(tester, 'account-profile-name-error'),
      'Use 1 to 60 characters, with no hidden ones.',
    );
    expect(api.sent, isEmpty);
  });

  testWidgets('the backend\'s refusal of a name is said under it', (
    tester,
  ) async {
    final api = NameApi()
      ..refuse = (400, 'Use 1 to 60 characters, with no hidden ones.');
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, 'El​vis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(
      _said(tester, 'account-profile-name-error'),
      'Use 1 to 60 characters, with no hidden ones.',
    );
    expect(app.currentUser!.name, 'phorom12a');
  });

  testWidgets('a Harness too old for the route says to update it', (
    tester,
  ) async {
    final api = NameApi()..refuse = (404, 'Request failed (404)');
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, 'Elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(find.text('Update Harness to change your name.'), findsOneWidget);
    expect(_text(tester, _name), 'Elvis');
  });

  testWidgets('Cancel closes it and saves nothing', (tester) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, 'Elvis');
    await tester.tap(find.byKey(const ValueKey('account-profile-cancel')));
    await tester.pumpAndSettle();
    expect(find.text('Profile'), findsNothing);
    expect(api.sent, isEmpty);
    expect(app.currentUser!.name, 'phorom12a');
  });

  testWidgets('the avatar menu\'s Profile opens the sheet', (tester) async {
    final app = createApp(store: MemoryStore())
      ..currentUser = const CurrentUserProfile(
        id: 'owner',
        name: 'phorom12a',
        email: 'owner@example.com',
      );
    addTearDown(app.dispose);
    await mount(tester, app);
    await tester.tap(find.byKey(const ValueKey('swarm-account-button')));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('account-menu-profile')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('account-profile-sheet')), findsOneWidget);
    expect(_text(tester, _name), 'phorom12a');
    await tester.tap(find.byKey(const ValueKey('account-profile-cancel')));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('Settings ▸ Account shows the name with an Edit that opens the '
      'sheet', (tester) async {
    final api = NameApi();
    final app = profileApp(api);
    addTearDown(app.dispose);
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AccountSection(notifier: app)),
      ),
    );
    expect(find.text('phorom12a'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('settings-account-edit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('account-profile-sheet')), findsOneWidget);
    await tester.enterText(_name, 'Elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('account-profile-sheet')), findsNothing);
    expect(find.text('Elvis'), findsOneWidget);
  });
}
