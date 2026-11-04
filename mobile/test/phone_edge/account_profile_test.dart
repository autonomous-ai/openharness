import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/api/api_client.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/account_profile_dialog.dart';
import 'package:harness_mobile/phone/settings_page.dart';
import 'package:harness_mobile/state/app_state.dart';

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

/// One Swarm's username, and its own name, as the sheet changes them (`SwarmProfile.setUsername`, `setName`).
class _Swarm {
  _Swarm(this.name, {this.username, this.personName});

  final String name;
  String? username, personName;
  final sent = <String>[];
  String? refuseUsername;

  AccountProfileSwarm get target => AccountProfileSwarm(
    name: name,
    username: username,
    personName: personName,
    setUsername: (value) async {
      sent.add('username $value');
      if (refuseUsername case final refusal?) return refusal;
      username = value;
      return null;
    },
    setName: (value) async {
      sent.add('name $value');
      personName = value;
      return null;
    },
  );
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

  Future<void> open(WidgetTester tester, {List<_Swarm> swarms = const [], Brightness brightness = Brightness.dark}) async {
    setPhone(tester, largePhone);
    app = signedIn();
    await tester.pumpWidget(phoneApp(
      Builder(builder: (context) => TextButton(
        onPressed: () => showAccountProfile(context, app, swarms: [for (final s in swarms) s.target]),
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
      // No Swarm: no username.
      expect(find.text('Username'), findsNothing);
      await tester.enterText(field('account-profile-name'), '  Ada   King ');
      await save(tester);
      expect(api.names, ['Ada King']);
      expect(app.currentUser?.name, 'Ada King');
      expect(find.text('Profile'), findsNothing);
      await close(tester);
    });

    testWidgets('an empty or too long name is refused here, and nothing is sent', (tester) async {
      await open(tester);
      for (final name in ['   ', 'x' * 61]) {
        await tester.enterText(field('account-profile-name'), name);
        await save(tester);
        expect(find.text('Use 1 to 60 characters, with no hidden ones.'), findsOneWidget, reason: name);
      }
      expect(api.names, isEmpty);
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

    testWidgets('one Username per Swarm, with @ and the Swarm\'s name; only what changed is sent', (tester) async {
      final pilot = _Swarm('Pilot', username: 'ada', personName: 'Ada Lovelace');
      final scout = _Swarm('Scout', username: 'ada-l', personName: 'Ada');
      await open(tester, swarms: [pilot, scout]);
      expect(find.text('Username'), findsNWidgets(2));
      expect(find.text('in Pilot'), findsOneWidget);
      expect(find.text('in Scout'), findsOneWidget);
      expect(tester.widget<TextField>(field('account-profile-username-0')).decoration?.prefixText, '@');
      expect(tester.widget<TextField>(field('account-profile-username-1')).controller!.text, 'ada-l');
      await tester.enterText(field('account-profile-username-1'), 'lovelace');
      await save(tester);
      // The name did not change: no account call, and no Swarm name follows it.
      expect(api.names, isEmpty);
      expect(pilot.sent, isEmpty);
      expect(scout.sent, ['username lovelace']);
      expect(find.text('Profile'), findsNothing);
      await close(tester);
    });

    testWidgets('a new name is followed by the Swarm name where it was the same; a refused username stays '
        'under its field, and Save again sends only it', (tester) async {
      final pilot = _Swarm('Pilot', username: 'ada', personName: 'Ada Lovelace')..refuseUsername = 'That username is taken in this Swarm.';
      final scout = _Swarm('Scout', username: 'ada-l', personName: 'Countess');
      await open(tester, swarms: [pilot, scout]);
      await tester.enterText(field('account-profile-name'), 'Ada King');
      await tester.enterText(field('account-profile-username-0'), 'ada2');
      await save(tester);
      expect(api.names, ['Ada King']);
      expect(pilot.sent, ['username ada2']);
      expect(find.byKey(const ValueKey('account-profile-username-0-error')), findsOneWidget);
      expect(find.text('That username is taken in this Swarm.'), findsOneWidget);
      pilot.refuseUsername = null;
      await save(tester);
      // The name is saved already: not sent again. Pilot's own name followed the change; Scout's, set on purpose, did not.
      expect(api.names, ['Ada King']);
      expect(pilot.sent, ['username ada2', 'username ada2', 'name Ada King']);
      expect(scout.sent, isEmpty);
      expect(find.text('Profile'), findsNothing);
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
  });
}
