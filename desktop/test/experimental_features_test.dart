import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/settings/experimental_features.dart';
import 'package:harness/settings/sections/experimental_section.dart';
import 'package:harness/state/app_state.dart';

class AccountSettings implements ExperimentalSettingsTransport {
  AccountSettings(this.accountId);
  String accountId;
  int revision = 0, reads = 0;
  final writes = <(String, ExperimentalFeature, bool)>[];
  final features = {for (final f in ExperimentalFeature.values) f.id: false};
  Future<Map<String, dynamic>> Function()? readOverride;
  Future<Map<String, dynamic>> Function()? writeOverride;
  Map<String, dynamic> get snapshot => {
    'accountId': accountId,
    'revision': revision,
    'features': Map<String, bool>.of(features),
  };
  @override
  Future<Map<String, dynamic>> read() async {
    reads++;
    return readOverride == null ? snapshot : await readOverride!();
  }

  @override
  Future<Map<String, dynamic>> write(
    String account,
    ExperimentalFeature feature,
    bool enabled,
  ) async {
    writes.add((account, feature, enabled));
    if (account != accountId) throw StateError('Account changed');
    if (writeOverride != null) return writeOverride!();
    features[feature.id] = enabled;
    revision++;
    return snapshot;
  }
}

void main() {
  const creature = ExperimentalFeature.focusBarCreature;
  const share = ExperimentalFeature.shareButton;
  Future<ExperimentalFeaturesStore> open(AccountSettings server) async {
    final store = ExperimentalFeaturesStore(pollInterval: Duration.zero);
    addTearDown(store.dispose);
    store.bind(server.accountId, transport: server);
    await store.refresh();
    return store;
  }

  for (final feature in ExperimentalFeature.values) {
    test(
      '${feature.label} follows the account across clients and reopening',
      () async {
        final server = AccountSettings('a');
        final first = await open(server);
        final second = await open(server);
        expect(first.enabled(feature), isFalse);
        expect(server.writes, isEmpty, reason: 'opening settings only reads');
        await first.set(feature, true);
        await second.refresh();
        expect(second.enabled(feature), isTrue);
        expect((await open(server)).enabled(feature), isTrue);
        await second.set(feature, false);
        await first.refresh();
        expect(first.enabled(feature), isFalse);
        expect((await open(AccountSettings('b'))).enabled(feature), isFalse);
      },
    );
  }

  test('a pending save is not presented as saved, and a failed save can be retried', () async {
    final server = AccountSettings('a');
    final store = await open(server);
    final save = Completer<Map<String, dynamic>>();
    server.writeOverride = () => save.future;
    final writing = store.set(creature, true);
    expect(store.saving, isTrue);
    expect(store.enabled(creature), isFalse);
    save.completeError(StateError('offline'));
    await writing;
    expect(store.enabled(creature), isFalse);
    expect(store.error, contains('Refresh'));
    server.writeOverride = null;
    await store.set(creature, true);
    expect(store.enabled(creature), isTrue);
    expect(store.error, isNull);
  });

  test('a late read cannot reverse an acknowledged choice', () async {
    final server = AccountSettings('a');
    final store = await open(server);
    final old = server.snapshot;
    final read = Completer<Map<String, dynamic>>();
    server.readOverride = () => read.future;
    final reading = store.refresh();
    await store.set(share, true);
    read.complete(old);
    await reading;
    expect(store.enabled(share), isTrue);
  });

  test('switching accounts clears choices immediately and ignores old reads and writes', () async {
    final a = AccountSettings('a');
    final b = AccountSettings('b');
    final store = await open(a);
    await store.set(creature, true);
    final read = Completer<Map<String, dynamic>>();
    final write = Completer<Map<String, dynamic>>();
    a.readOverride = () => read.future;
    a.writeOverride = () => write.future;
    final reading = store.refresh();
    final writing = store.set(share, true);
    store.bind('b', transport: b);
    expect(store.enabled(creature), isFalse);
    expect(store.loaded, isFalse);
    await store.refresh();
    read.complete(a.snapshot);
    write.complete({
      ...a.snapshot,
      'revision': 20,
      'features': {creature.id: true, share.id: true},
    });
    await Future.wait([reading, writing]);
    expect(store.accountId, 'b');
    expect(store.enabled(creature), isFalse);
    expect(store.enabled(share), isFalse);
    expect(store.saving, isFalse);
    expect(b.writes, isEmpty);
    store.bind(null);
    await store.set(creature, true);
    expect(store.loaded, isFalse);
    expect(b.writes, isEmpty);
  });

  test(
    'unreadable or wrong-account settings never enable experiments',
    () async {
      final server = AccountSettings('a')
        ..readOverride = () async => {
          'accountId': 'b',
          'revision': 1,
          'features': {creature.id: true, share.id: true},
        };
      final store = await open(server);
      expect(store.loaded, isFalse);
      expect(store.enabled(creature), isFalse);
      await store.set(creature, true);
      expect(server.writes, isEmpty);
      server.readOverride = () => Future.error(StateError('offline'));
      await store.refresh();
      expect(store.loaded, isFalse);
      expect(store.error, isNotNull);
    },
  );

  test('AppNotifier binds preferences only after the account profile arrives and clears on sign-out', () async {
    final server = AccountSettings('a')..features[creature.id] = true;
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      experimentalSettingsTransport: server,
    );
    addTearDown(app.dispose);
    expect(server.reads, 0);
    expect(app.experimentalFeatures.loaded, isFalse);
    app.currentUser = const CurrentUserProfile(
      id: 'a',
      email: 'a@example.test',
    );
    await app.experimentalFeatures.refresh();
    expect(app.experimentalFeatures.enabled(creature), isTrue);
    app.currentUser = null;
    expect(app.experimentalFeatures.enabled(creature), isFalse);
    expect(app.experimentalFeatures.accountId, isNull);
    expect(server.writes, isEmpty);
  });

  testWidgets('missed push notifications reconcile through the account poll', (
    tester,
  ) async {
    final server = AccountSettings('a');
    final store = ExperimentalFeaturesStore();
    store.bind('a', transport: server);
    await tester.pump();
    server.features[share.id] = true;
    server.revision++;
    await tester.pump(const Duration(seconds: 30));
    expect(store.enabled(share), isTrue);
    store.dispose();
    final reads = server.reads;
    await tester.pump(const Duration(seconds: 30));
    expect(server.reads, reads);
  });

  testWidgets(
    'settings show pending saves, uncertain writes and read failures with recovery',
    (tester) async {
      final server = AccountSettings('a');
      final store = await open(server);
      final reply = Completer<Map<String, dynamic>>();
      server.writeOverride = () => reply.future;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: ExperimentalSection(store: store)),
        ),
      );
      await tester.pumpAndSettle();
      final toggle = find.byKey(const ValueKey('experimental-share_button'));
      await tester.tap(toggle);
      await tester.pump();
      expect(tester.widget<Switch>(toggle).value, isFalse);
      expect(tester.widget<Switch>(toggle).onChanged, isNull);
      expect(find.text('Saving…'), findsOneWidget);
      // The server saved it, but the acknowledgement did not reach this window.
      server.features[share.id] = true;
      server.revision++;
      reply.completeError(StateError('Connection lost'));
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, isFalse);
      expect(find.textContaining('Couldn’t confirm'), findsOneWidget);
      await tester.tap(find.text('Refresh setting'));
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, isTrue);
      expect(find.textContaining('Couldn’t confirm'), findsNothing);
      server.readOverride = () => Future.error(StateError('offline'));
      await store.refresh();
      await tester.pumpAndSettle();
      expect(tester.widget<Switch>(toggle).value, isTrue);
      expect(find.textContaining('Couldn’t read'), findsOneWidget);
      server.readOverride = null;
      await tester.tap(find.text('Refresh settings'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Couldn’t read'), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
