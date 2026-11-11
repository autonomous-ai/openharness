import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart' show CancelToken;
import 'package:fake_async/fake_async.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/parts.dart';
import 'package:harness_mobile/swarm/swarm_face.dart';
import 'package:harness_mobile/swarm/swarm_home_cache.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_outgoing_files.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The account's Swarm on the phone: made while Swarm is turned on and someone
/// is signed in, read while Harness is in front, telling the person what
/// arrives unless they are looking at it.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// One Swarm `a` where a v1-v3 decision, d1, is still open and counted.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': 'a', 'name': 'Swarm a', 'ownerId': me, 'lastChangedAt': 100},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 0};
    fake.routes['/api/super-tabs/a/parts'] = (_) =>
        firstLoad(tabId: 'a', derived: derived);
    fake.routes['/api/super-tabs/a/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/a/decisions?state=open'] = (_) => {
      'decisions': [
        {
          'id': 'd1',
          'conversationId': 'g9',
          'askerName': 'River',
          'question': 'Ship it?',
          'options': ['Yes', 'No'],
        },
      ],
    };
    fake.routes['/api/super-tabs/a/commands'] = (_) => {
      'result': <String, dynamic>{},
    };
    return fake;
  }

  SwarmSession session(FakeSwarm fake, {_Notices? notices}) {
    final s = SwarmSession(
      accountId: me,
      request: fake.request,
      notices: notices ?? _Notices(),
    );
    addTearDown(s.dispose);
    return s;
  }

  group('SwarmHost', () {
    late ExperimentalFeaturesStore features;
    late ValueNotifier<String?> account;
    late _Notices notices;
    late SwarmHomeCache home;

    SwarmHost host() {
      final h = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: notices,
        features: features,
        homeCache: home,
      );
      addTearDown(h.dispose);
      return h;
    }

    setUp(() {
      features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore());
      account = ValueNotifier(me);
      notices = _Notices();
      home = memoryHomeCache();
    });

    /// The account's Home, kept as a Swarm it read.
    Future<void> keep(String account) => home.write(account, [
      (
        id: 'a',
        name: 'Swarm a',
        view: (
          state: SuperTabParts.firstLoad(firstLoad(tabId: 'a')).state,
        ),
      ),
    ]);

    test(
      'each Swarm sends its chats\' files with the upload handed in',
      () async {
        await features.set(PhoneExperiment.swarm, true);
        final sent = <String>[];
        final h = SwarmHost(
          accountId: () => account.value,
          account: account,
          request: backend().request,
          upload:
              ({
                required tabId,
                required conversationId,
                required name,
                required mime,
                required file,
                required cancel,
                required onProgress,
              }) async {
                sent.add('$tabId/$conversationId/$name');
                return {'attachment': <String, dynamic>{}};
              },
          notices: notices,
          features: features,
          homeCache: home,
        );
        addTearDown(h.dispose);
        final inbox = h.session!.inbox..shown = true;
        await until(() => inbox.reader('a') != null);

        final reader = inbox.reader('a')!;
        await reader.upload(
          tabId: reader.tabId,
          conversationId: 'g9',
          name: 'shot.jpg',
          mime: 'image/jpeg',
          file: SwarmOutgoingFile('shot.jpg', Uint8List(1)),
          cancel: CancelToken(),
          onProgress: (_) {},
        );

        expect(sent, ['a/g9/shot.jpg']);
      },
    );

    group('the photos drawn', () {
      setUp(() => features.set(PhoneExperiment.swarm, true));

      /// A photo of the Swarm's as drawing holds it in memory.
      ImageProvider drawn(String url) {
        final image = swarmAvatarImage(Uri.parse(url));
        PaintingBinding.instance.imageCache.putIfAbsent(
          image,
          () => OneFrameImageStreamCompleter(Completer<ImageInfo>().future),
        );
        expect(PaintingBinding.instance.imageCache.containsKey(image), isTrue);
        return image;
      }

      test('go when the person signs out', () {
        host();
        final photo = drawn('https://storage.googleapis.com/a.png?sig=1');
        account.value = null;
        expect(PaintingBinding.instance.imageCache.containsKey(photo), isFalse);
      });

      test('go when another account signs in', () {
        host();
        final photo = drawn('https://storage.googleapis.com/b.png?sig=1');
        account.value = 'person-other';
        expect(PaintingBinding.instance.imageCache.containsKey(photo), isFalse);
      });

      test('stay while the same account is signed in', () {
        final h = host();
        final photo = drawn('https://storage.googleapis.com/c.png?sig=1');
        h.foreground = false;
        h.foreground = true;
        expect(PaintingBinding.instance.imageCache.containsKey(photo), isTrue);
        PaintingBinding.instance.imageCache.clear();
      });
    });

    group('the Home kept', () {
      setUp(() => features.set(PhoneExperiment.swarm, true));

      test('goes when the person signs out', () async {
        host();
        await keep(me);

        account.value = null;

        expect(await home.read(me), isNull);
      });

      test('goes when Swarm is turned off', () async {
        host();
        await keep(me);

        await features.set(PhoneExperiment.swarm, false);

        expect(await home.read(me), isNull);
      });

      test('goes when another account signs in', () async {
        host();
        await keep(me);

        account.value = 'person-other';

        expect(await home.read(me), isNull);
      });

      test(
        'stays while the same account is signed in, in front or not',
        () async {
          final h = host();
          await keep(me);

          h.foreground = false;
          h.foreground = true;

          expect(await home.read(me), isNotNull);
        },
      );
    });

    group('the Home kept, at a cold start', () {
      /// Nothing of it on the phone: no view, and no key that opens one.
      Future<void> expectGone() async {
        expect(await home.read(me), isNull);
        expect(home.file.existsSync(), isFalse);
        expect((home.key as MemorySwarmHomeKey).value, isNull);
      }

      test('goes when Swarm is already off, with no session to end', () async {
        await keep(me);

        host();

        await expectGone();
      });

      test('stays while the account is still being read', () async {
        await features.set(PhoneExperiment.swarm, true);
        account.value = null;
        await keep(me);

        final h = host();
        account.value = me;

        expect(h.session?.accountId, me);
        expect(await home.read(me), isNotNull);
      });

      test(
        'goes when Swarm is turned off before the account is read',
        () async {
          await features.set(PhoneExperiment.swarm, true);
          account.value = null;
          await keep(me);
          host();

          await features.set(PhoneExperiment.swarm, false);

          await expectGone();
        },
      );
    });

    test(
      'has a session only while Swarm is on and someone is signed in',
      () async {
        final h = host();
        expect(h.session, isNull, reason: 'Swarm is off');

        await features.set(PhoneExperiment.swarm, true);
        expect(h.session?.accountId, me);

        account.value = null;
        expect(h.session, isNull, reason: 'signed out');

        account.value = 'person-other';
        expect(h.session?.accountId, 'person-other');

        await features.set(PhoneExperiment.swarm, false);
        expect(h.session, isNull);
      },
    );

    group("the app icon's count", () {
      /// Swarm on, and the session's Swarm read once.
      Future<SwarmSession> read() async {
        await features.set(PhoneExperiment.swarm, true);
        final s = host().session!;
        await s.inbox.refresh();
        await settle();
        return s;
      }

      test('a v1-v3 decision still open posts no notice and leaves no count; '
          'the first read takes off one left before', () async {
        await read();

        expect(notices.shown, isEmpty);
        expect(notices.badges, [0]);
      });

      test('clears when the person signs out', () async {
        await read();

        account.value = null;

        expect(notices.badges.last, 0);
      });

      test('clears when another account signs in', () async {
        await read();

        account.value = 'person-other';

        expect(notices.badges.last, 0);
      });

      test('clears when Swarm is turned off', () async {
        await read();

        await features.set(PhoneExperiment.swarm, false);

        expect(notices.badges.last, 0);
      });
    });
  });

  test('a computer coming up while Swarm has none reads at once', () {
    fakeAsync((async) {
      final fake = backend();
      final listed = fake.routes['/api/super-tabs/list']!;
      var away = true;
      fake.routes['/api/super-tabs/list'] = (q) => away
          ? throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.')
          : listed(q);
      final features = ExperimentalFeaturesStore(
        storage: MemoryKeyValueStore(),
      );
      features.set(PhoneExperiment.swarm, true);
      async.flushMicrotasks();
      final computers = _Computers();
      final host = SwarmHost(
        accountId: () => me,
        account: ValueNotifier(me),
        request: fake.request,
        notices: _Notices(),
        features: features,
        computers: computers,
      );
      async.flushMicrotasks();
      final inbox = host.session!.inbox;
      expect(inbox.noComputer, isTrue);

      away = false;
      async.elapse(const Duration(milliseconds: 300));
      computers.up();
      async.flushMicrotasks();

      expect(inbox.loaded, isTrue);
      host.dispose();
    });
  });

  test('reads only while Harness is in front', () {
    fakeAsync((async) {
      final fake = backend();
      final s = SwarmSession(
        accountId: me,
        request: fake.request,
        notices: _Notices(),
      );
      int lists() => fake.paths.where((p) => p.endsWith('/list')).length;

      s.foreground = true;
      async.flushMicrotasks();
      expect(lists(), 1);

      s.foreground = false;
      async.elapse(const Duration(minutes: 2));
      expect(lists(), 1);
      s.dispose();
    });
  });

  test(
    'a Swarm watched by a screen is read often, until no screen watches it',
    () async {
      final s = session(backend())..foreground = true;
      await s.inbox.refresh();
      final reader = s.inbox.reader('a')!;

      s.watch('a');
      s.watch('a');
      expect(reader.shown, isTrue);

      s.unwatch('a');
      expect(reader.shown, isTrue, reason: 'one screen still watches it');

      s.unwatch('a');
      expect(reader.shown, isFalse);
    },
  );

  test('a watched Swarm reads nothing while Harness is behind, '
      'and reads at once when it is in front again', () {
    fakeAsync((async) {
      final fake = backend();
      final s = SwarmSession(
        accountId: me,
        request: fake.request,
        notices: _Notices(),
      )..foreground = true;
      async.flushMicrotasks();
      int reads() => fake.paths
          .where((p) => p.startsWith('/api/super-tabs/a/changes'))
          .length;
      s.watch('a');
      async.elapse(const Duration(seconds: 6));
      final watched = reads();
      expect(watched, greaterThan(0));

      s.foreground = false;
      async.elapse(const Duration(minutes: 2));
      expect(reads(), watched, reason: 'behind, the watched Swarm too');

      s.foreground = true;
      async.flushMicrotasks();
      expect(reads(), greaterThan(watched));
      s.dispose();
    });
  });
}

/// The account's computers, told by hand.
class _Computers extends ChangeNotifier implements SwarmComputers {
  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  @override
  List<SwarmComputer>? computers = const [(name: 'Studio Mac', away: false)];

  @override
  bool get rechecking => false;

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}

  /// A computer came up.
  void up() => notifyListeners();
}

class _Notices extends SilentSystemNotices {
  final shown = <SwarmNoticeMessage>[];
  final cancelled = <String>[];

  @override
  Future<void> showSwarm(SwarmNoticeMessage message) async =>
      shown.add(message);

  @override
  Future<void> cancelSwarm(String key) async => cancelled.add(key);

  final badges = <int>[];

  @override
  Future<void> setSwarmBadge(int count) async => badges.add(count);
}
