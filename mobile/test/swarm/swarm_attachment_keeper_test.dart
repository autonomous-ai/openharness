import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_attachment_fakes.dart';
import 'swarm_fixture.dart';

/// The files go with the account's Swarm: on sign-out, Swarm turned off,
/// another account, and a Swarm leaving the account's list.
void main() {
  late Directory root;
  late FakeFileStorage storage;
  late SwarmAttachmentStore store;
  late ValueNotifier<String?> account;
  late ExperimentalFeaturesStore features;
  late List<String> listed;
  late SwarmHost host;

  final picture = Uri.parse('https://cdn.example/swarm/a.png');

  setUp(() {
    root = Directory.systemTemp.createTempSync('swarm-attachments-');
    storage = FakeFileStorage();
    store = storeIn(root, storage);
    account = ValueNotifier(me);
    features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    listed = ['tab-a', 'tab-b'];
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        for (final id in listed) {'id': id, 'name': id, 'ownerId': me},
      ],
      'next': null,
    };
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
    )..foreground = false;
  });
  tearDown(() {
    host.dispose();
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  /// Waits, briefly, until [done] holds: the keeper empties files in the
  /// background.
  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(done(), isTrue);
  }

  /// A keeper over [host], the list read once, and a picture kept.
  Future<SwarmAttachmentKeeper> keeping() async {
    final keeper = SwarmAttachmentKeeper(host, store: store);
    addTearDown(keeper.dispose);
    await host.session!.inbox.refresh();
    await store.file(picture);
    expect(keptUnder(root), isNotEmpty);
    return keeper;
  }

  test('sign-out empties them', () async {
    await keeping();

    account.value = null;

    await until(() => keptUnder(root).isEmpty);
  });

  test('Swarm turned off empties them', () async {
    await keeping();

    features.value = const {};

    await until(() => keptUnder(root).isEmpty);
  });

  test("another account signing in empties the first one's", () async {
    await keeping();

    account.value = 'person-other';
    await store.file(picture);

    expect(storage.asked, hasLength(2), reason: 'fetched again, for them');
    expect(
      root.listSync().whereType<Directory>(),
      hasLength(1),
      reason: "the other account's folder only",
    );
  });

  test("a Swarm leaving the account's list empties them", () async {
    await keeping();

    listed = ['tab-a'];
    await host.session!.inbox.refresh();
    await store.file(picture);

    expect(storage.asked, hasLength(2), reason: 'emptied, so fetched again');
  });

  test(
    'a Swarm joining, or the same list read again, empties nothing',
    () async {
      await keeping();

      listed = ['tab-a', 'tab-b', 'tab-c'];
      await host.session!.inbox.refresh();
      await host.session!.inbox.refresh();
      await store.file(picture);

      expect(storage.asked, hasLength(1));
    },
  );

  test('at start with nobody signed in, what was left is emptied', () async {
    File('${root.path}/stray.png').writeAsBytesSync(pixelPng);
    account.value = null;

    final keeper = SwarmAttachmentKeeper(host, store: store);
    addTearDown(keeper.dispose);

    await until(() => keptUnder(root).isEmpty);
  });

  test('files that cannot be emptied are logged, never thrown', () async {
    final log = _Log();
    final before = appLog;
    appLog = log;
    addTearDown(() => appLog = before);
    final broken = SwarmAttachmentStore(
      root: () async => throw const FileSystemException('no folder'),
    );

    final keeper = SwarmAttachmentKeeper(host, store: broken);
    addTearDown(keeper.dispose);

    await until(() => log.failures.isNotEmpty);
    expect(log.failures.single, contains('Swarm files'));
  });

  test('let go of, it hears nothing more', () async {
    final keeper = await keeping();
    keeper.dispose();

    listed = ['tab-a'];
    await host.session!.inbox.refresh();
    await store.file(picture);

    expect(storage.asked, hasLength(1));
  });
}

class _Log implements AppLog {
  final failures = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) {
    if (level == AppLogLevel.error) failures.add(message);
  }
}
