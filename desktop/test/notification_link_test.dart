// A Windows toast's click is a link, `harness://notification/<machine>/<agent>`,
// so it reaches the app as community links do (single instance, then
// `harness/community_links`). These pin its shape, where it goes, and that the
// fork inbox hands it over instead of queueing it.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/community/fork_inbox.dart';
import 'package:harness/notify/system_notifications.dart';

import 'support/memory_key_value_store.dart';

const _fork =
    'harness://fork/starter-ribbon-lamp?request=0b6b4b8e-6f6a-4c64-9d1b-6f0d0c1a2b3c';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('NotificationLink', () {
    test('carries an agent address both ways, whatever its characters', () {
      final url = NotificationLink.build('m-1', 'agent/7 ü');
      expect(url, 'harness://notification/m-1/agent%2F7%20%C3%BC');
      final link = NotificationLink.parse(url)!;
      expect((link.machineId, link.agentId), ('m-1', 'agent/7 ü'));
      final device = NotificationLink.parse(
        NotificationLink.build(
          SystemNotifications.deviceNoticeMachine,
          'pub+k=',
        ),
      )!;
      expect((device.machineId, device.agentId), ('@device', 'pub+k='));
      // A Swarm tag's toast: its Swarm tab and tag survive the link.
      final tag = NotificationLink.parse(
        NotificationLink.build(
          SystemNotifications.mentionNoticeMachine,
          '0123456789abcdef01234567/5f0c2a',
        ),
      )!;
      expect((tag.machineId, tag.agentId), (
        '@mention',
        '0123456789abcdef01234567/5f0c2a',
      ));
    });

    test('the bare link names no agent', () {
      final bare = NotificationLink.parse(NotificationLink.bare)!;
      expect((bare.machineId, bare.agentId), ('', ''));
      expect(NotificationLink.build('', 'a1'), NotificationLink.bare);
      expect(NotificationLink.build('m1', ''), NotificationLink.bare);
    });

    test('a link too long for the runner falls back to the bare one', () {
      expect(NotificationLink.build('m', 'a' * 300), NotificationLink.bare);
    });

    test('malformed UTF-8 escapes are ignored', () {
      expect(NotificationLink.parse('harness://notification/m/%FF'), isNull);
    });

    test('raw multibyte links obey the runner byte limit', () {
      // 135 UTF-16 code units, but 245 UTF-8 bytes.
      expect(
        NotificationLink.parse('harness://notification/${'ü' * 110}/a'),
        isNull,
      );
    });

    test('anything else is not a notification link', () {
      for (final url in [
        _fork,
        'harness://notification/m',
        'harness://notification/m/a/b',
        'harness://notification/m/a?x=1',
        'harness://notification/m/a#f',
        'harness://notification:80/m/a',
        'harness://user@notification/m/a',
        'https://notification/m/a',
        'harness://notification//a',
        'harness://notification/${'m' * 240}/a',
      ]) {
        expect(NotificationLink.parse(url), isNull, reason: url);
      }
    });
  });

  test('a toast click goes where a notification click goes', () {
    final system = SystemNotifications(
      store: DesktopNotificationStore(storage: MemoryKeyValueStore()),
      notifier: const NoSystemNotifier(),
    );
    final taps = <String>[];
    system.onTap = (machineId, agentId) => taps.add('$machineId/$agentId');
    expect(system.openLink(NotificationLink.build('m1', 'a1')), isTrue);
    expect(system.openLink(NotificationLink.bare), isTrue);
    expect(system.openLink(_fork), isFalse);
    expect(taps, ['m1/a1']);
    system.onTap = null;
    expect(system.openLink(NotificationLink.build('m1', 'a1')), isTrue);
    expect(taps, [
      'm1/a1',
    ], reason: 'nobody listening: the click only opened Harness');
  });

  test(
    'the inbox hands a notification link over and never queues it',
    () async {
      const channel = MethodChannel('harness/community_links');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final note = NotificationLink.build('m1', 'a1');
      messenger.setMockMethodCallHandler(
        channel,
        (call) async => [note, _fork],
      );
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final claimed = <String>[];
      final inbox = ForkInbox(
        MemoryKeyValueStore(),
        claimLink: (url) {
          final mine = NotificationLink.parse(url) != null;
          if (mine) claimed.add(url);
          return mine;
        },
      );
      await inbox.initialize();
      expect(claimed, [note]);
      expect(inbox.pending.single.harnessId, 'starter-ribbon-lamp');
      await inbox.accept(note);
      expect(claimed, [note, note]);
      expect(inbox.pending, hasLength(1));
      inbox.dispose();
    },
  );
}
