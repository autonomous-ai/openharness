// The avatar menu's Profile (task #2654): a person changes their own account
// name and, in the Swarm they are in, their @username, from one sheet. The
// account name goes to the backend's PATCH /api/auth/me through a fake API;
// the Swarm's two through the fixture server's commands. A memory store and a
// fake sign-in: nothing here reaches the real CLI or signs this Mac out.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/sections/account_section.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/widgets/account_profile_sheet.dart';

import 'support/super_tab_fixture.dart';
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
final _username = find.byKey(const ValueKey('account-profile-username'));
final _save = find.byKey(const ValueKey('account-profile-save'));

Map<String, dynamic> _command(Map<String, dynamic> post) =>
    Map<String, dynamic>.from(post['command'] as Map);

List<String> _types(ConversationServer server) => [
  for (final post in server.posts) _command(post)['type'] as String,
];

AppNotifier _app(NameApi api, {String? name = 'phorom12a'}) {
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

Future<void> _open(
  WidgetTester tester,
  AppNotifier app, {
  SuperTabController? swarm,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showAccountProfileSheet(
              context,
              app,
              swarm: swarm == null
                  ? null
                  : (controller: swarm, name: 'openharness'),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<SuperTabController> _swarm(ConversationServer server) async {
  final c = server.controller();
  addTearDown(c.dispose);
  await c.refresh();
  return c;
}

/// The line said under a field, by its key.
String? _said(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(ValueKey(key))).data;

String _text(WidgetTester tester, Finder field) =>
    tester.widget<TextField>(field).controller!.text;

void main() {
  testWidgets('shows the account name and this Swarm\'s @username', (
    tester,
  ) async {
    final api = NameApi();
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    await _open(tester, app, swarm: await _swarm(server));
    expect(find.text('Profile'), findsOneWidget);
    expect(_text(tester, _name), 'phorom12a');
    expect(_text(tester, _username), 'owner');
    expect(find.text('in openharness'), findsOneWidget);
  });

  testWidgets('Save applies both: the account name, this Swarm\'s name and '
      'the username', (tester) async {
    final api = NameApi();
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    final c = await _swarm(server);
    await _open(tester, app, swarm: c);
    await tester.enterText(_name, '  Elvis ');
    await tester.enterText(_username, 'elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(api.sent, ['Elvis']);
    expect(app.currentUser!.name, 'Elvis');
    expect(_types(server), ['member.username', 'member.name']);
    expect(_command(server.posts.last), {
      'type': 'member.name',
      'name': 'Elvis',
    });
    expect(c.snapshot!.people.single.username, 'elvis');
    expect(c.snapshot!.people.single.shownName, 'Elvis');
    // Saved: the sheet has closed.
    expect(find.text('Profile'), findsNothing);
  });

  testWidgets('only what changed is sent', (tester) async {
    final api = NameApi();
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    await _open(tester, app, swarm: await _swarm(server));
    await tester.enterText(_username, 'elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(api.sent, isEmpty);
    expect(_types(server), ['member.username']);
  });

  testWidgets('a taken username says so under it and keeps the sheet open; '
      'Save again sends only what is left', (tester) async {
    final api = NameApi();
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    final c = await _swarm(server);
    await _open(tester, app, swarm: c);
    server.refuse = {'code': 'USERNAME_TAKEN', 'message': 'elvis is taken.'};
    await tester.enterText(_name, 'Elvis');
    await tester.enterText(_username, 'elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(_said(tester, 'account-profile-username-error'), 'elvis is taken.');
    expect(find.text('Profile'), findsOneWidget);
    expect(_text(tester, _username), 'elvis');
    expect(api.sent, ['Elvis']);

    server.refuse = null;
    await tester.enterText(_username, 'elvis2');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    // The account name was saved already: it is not sent twice.
    expect(api.sent, ['Elvis']);
    expect(c.snapshot!.people.single.username, 'elvis2');
    expect(c.snapshot!.people.single.shownName, 'Elvis');
    expect(find.text('Profile'), findsNothing);
  });

  testWidgets('an empty name says why and sends nothing', (tester) async {
    final api = NameApi();
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    await _open(tester, app, swarm: await _swarm(server));
    await tester.enterText(_name, '   ');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(
      _said(tester, 'account-profile-name-error'),
      'Use 1 to 60 characters, with no hidden ones.',
    );
    expect(api.sent, isEmpty);
    expect(server.posts, isEmpty);
  });

  testWidgets('the backend\'s refusal of a name is said under it', (
    tester,
  ) async {
    final api = NameApi()
      ..refuse = (400, 'Use 1 to 60 characters, with no hidden ones.');
    final app = _app(api);
    addTearDown(app.dispose);
    final server = ConversationServer();
    await _open(tester, app, swarm: await _swarm(server));
    await tester.enterText(_name, 'El​vis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(
      _said(tester, 'account-profile-name-error'),
      'Use 1 to 60 characters, with no hidden ones.',
    );
    expect(app.currentUser!.name, 'phorom12a');
    expect(server.posts, isEmpty);
  });

  testWidgets('a Harness too old for the route says to update it', (
    tester,
  ) async {
    final api = NameApi()..refuse = (404, 'Request failed (404)');
    final app = _app(api);
    addTearDown(app.dispose);
    await _open(tester, app);
    await tester.enterText(_name, 'Elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(find.text('Update Harness to change your name.'), findsOneWidget);
    expect(_text(tester, _name), 'Elvis');
  });

  testWidgets('with no Swarm open there is no username', (tester) async {
    final api = NameApi();
    final app = _app(api, name: null);
    addTearDown(app.dispose);
    await _open(tester, app);
    expect(_text(tester, _name), '');
    expect(_username, findsNothing);
    await tester.enterText(_name, 'Elvis');
    await tester.tap(_save);
    await tester.pumpAndSettle();
    expect(api.sent, ['Elvis']);
    expect(find.text('Profile'), findsNothing);
  });

  testWidgets('Cancel closes it and saves nothing', (tester) async {
    final api = NameApi();
    final app = _app(api);
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
    final app = _app(api);
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
