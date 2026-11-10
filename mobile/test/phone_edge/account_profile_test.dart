import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/account_profile_dialog.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../swarm/swarm_fixture.dart';
import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// The account's name as the backend answers `PATCH /api/auth/me` (#2917): saved, or refused in its words.
class _ProfileApi extends EdgeApi {
  _ProfileApi(super.app, super.session);

  final names = <String>[];
  Object? refuse;

  @override
  Future<Map<String, dynamic>?> updateMe({required String name}) async {
    names.add(name);
    final refusal = refuse;
    if (refusal != null) throw refusal;
    return {
      'user': {'id': 'u', 'name': name, 'email': 'ada@example.com'},
    };
  }
}

void main() {
  late AppNotifier app;
  late _ProfileApi api;

  AppNotifier signedIn() {
    final notifier = edgeApp();
    api = _ProfileApi(notifier, AuthSession());
    notifier.api = api;
    notifier.currentUser = const CurrentUserProfile(id: 'u', name: 'Ada Lovelace', email: 'ada@example.com');
    return notifier;
  }

  Future<void> open(WidgetTester tester, {Brightness brightness = Brightness.dark}) async {
    setPhone(tester, largePhone);
    app = signedIn();
    await tester.pumpWidget(phoneApp(
      Builder(builder: (context) => TextButton(
        onPressed: () => showAccountProfile(context, app),
        child: const Text('open'),
      )),
      brightness: brightness,
    ));
    await tester.tap(find.text('open'));
    await frames(tester);
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  Finder field(String key) => find.byKey(ValueKey(key));
  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.text('Save'));
    await frames(tester);
  }

  group('the account name (#2655)', () {
    test('setAccountName saves it, shows it at once, and answers a refusal in its words', () async {
      final notifier = signedIn();
      expect(await notifier.setAccountName('Ada King'), isNull);
      expect(notifier.currentUser?.name, 'Ada King');
      api.refuse = ApiException('Use a name, not an email address.', status: 400);
      expect(await notifier.setAccountName('ada@example.com'), 'Use a name, not an email address.');
      api.refuse = ApiException('Not found', status: 404);
      expect(await notifier.setAccountName('Ada'), 'Update Harness to change your name.');
      api.refuse = StateError('socket closed');
      expect(await notifier.setAccountName('Ada'), 'Your name was not saved. Try again.');
      expect(notifier.currentUser?.name, 'Ada King');
      notifier.dispose();
    });
  });

  group('Profile (#2655)', () {
    testWidgets('opens on the name; Save sends a changed name and closes', (tester) async {
      await open(tester);
      expect(find.text('Profile'), findsOneWidget);
      expect(find.text('Name'), findsOneWidget);
      expect(tester.widget<TextField>(field('account-profile-name')).controller!.text, 'Ada Lovelace');
      // The name alone: no @username, whatever Swarms the person is in.
      expect(find.text('Username'), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
      await tester.enterText(field('account-profile-name'), '  Ada   King ');
      await save(tester);
      expect(api.names, ['Ada King']);
      expect(app.currentUser?.name, 'Ada King');
      expect(find.text('Profile'), findsNothing);
      await close(tester);
    });

    testWidgets('an empty name is refused here, a long one is held to 60, and nothing is sent', (tester) async {
      await open(tester);
      await tester.enterText(field('account-profile-name'), '   ');
      await save(tester);
      expect(find.text('Use 1 to 60 characters, with no hidden ones.'), findsOneWidget);
      expect(api.names, isEmpty);
      await tester.enterText(field('account-profile-name'), 'x' * 61);
      await frames(tester);
      expect(tester.widget<TextField>(field('account-profile-name')).controller!.text.length, 60);
      await close(tester);
    });

    testWidgets("the backend's refusal shows under Name, and an edit takes it back", (tester) async {
      await open(tester);
      api.refuse = ApiException('Use a name, not an email address.', status: 400);
      await tester.enterText(field('account-profile-name'), 'ada@example.com');
      await save(tester);
      expect(find.byKey(const ValueKey('account-profile-name-error')), findsOneWidget);
      expect(find.text('Use a name, not an email address.'), findsOneWidget);
      expect(find.text('Profile'), findsOneWidget, reason: 'it stays open');
      await tester.enterText(field('account-profile-name'), 'Ada');
      await frames(tester);
      expect(find.text('Use a name, not an email address.'), findsNothing);
      await close(tester);
    });
  });

  group('the entry (#2655)', () {
    testWidgets('Profile sits above Sign out in the account sheet, and opens the sheet', (tester) async {
      setPhone(tester, largePhone);
      app = signedIn();
      await tester.pumpWidget(phoneApp(SettingsPage(notifier: app, large: true)));
      await frames(tester);
      await tester.tap(find.text('Ada Lovelace'));
      await frames(tester);
      final profile = tester.getTopLeft(find.text('Profile'));
      final signOut = tester.getTopLeft(find.text('Sign out'));
      expect(profile.dy, lessThan(signOut.dy));
      await tester.tap(find.text('Profile'));
      await frames(tester);
      expect(find.byKey(const ValueKey('account-profile-name')), findsOneWidget);
      await close(tester);
    });

    testWidgets('in a Swarm, Profile is still the account name alone: no Username, no name per Swarm', (tester) async {
      setPhone(tester, largePhone);
      app = signedIn();
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Pilot', 'ownerId': me},
        ],
        'next': null,
      };
      swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(),
        'members': [part(me, 1, {...person(me), 'username': 'ada', 'name': 'Ada Lovelace'})],
      };
      swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: swarm.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())..value = {PhoneExperiment.swarm},
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(phoneApp(SwarmScope(notifier: host, child: SettingsPage(notifier: app, large: true))));
      await tester.runAsync(host.session!.inbox.refresh);
      await frames(tester);
      expect(host.session!.inbox.swarms, isNotEmpty, reason: 'the Swarm is read, so the old sheet would list it');
      await tester.tap(find.text('Ada Lovelace'));
      await frames(tester);
      await tester.tap(find.text('Profile'));
      await frames(tester);
      expect(find.byKey(const ValueKey('account-profile-name')), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);
      expect(find.text('Username'), findsNothing);
      expect(find.text('in Pilot'), findsNothing);
      await tester.enterText(field('account-profile-name'), 'Ada King');
      await save(tester);
      expect(api.names, ['Ada King']);
      expect(swarm.commands, isEmpty, reason: 'the Swarm is told nothing');
      await close(tester);
    });
  });
}
