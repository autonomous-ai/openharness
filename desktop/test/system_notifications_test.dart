// The third alert channel: news the operating system delivers, so it reaches somebody whose window
// is somewhere else. When it is posted, what replaces what, what takes it down, what a click does,
// and how each platform's notifier is driven.
import 'dart:async';
import 'dart:io' show ProcessException, ProcessResult;
import 'dart:ui' show SemanticsAction, Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/settings/sections/alerts_card.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_log_sync.dart' show DeviceRemovalCopy;

class _Memory implements LocalKeyValueStore {
  final values = <String, String?>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async => values[key] = value;
  @override
  Future<void> delete(String key) async => values.remove(key);
}

/// Records what would have reached the operating system.
class _Recorder implements SystemNotifier {
  _Recorder({
    this.answer = NotificationPermission.granted,
    this.isSupported = true,
  });

  NotificationPermission answer;
  final bool isSupported;
  final shown =
      <
        ({
          String id,
          String title,
          String body,
          String machineId,
          String agentId,
        })
      >[];
  final withdrawn = <String>[];
  int authorizations = 0;
  Completer<void>? showGate;
  void Function(String machineId, String agentId)? tap;

  @override
  bool get supported => isSupported;

  @override
  String get deniedAdvice => 'Allow it where the recorder says.';

  @override
  bool get clickOpensAgent => true;

  @override
  Future<NotificationPermission> authorize() async {
    authorizations++;
    return answer;
  }

  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async {
    shown.add((
      id: id,
      title: title,
      body: body,
      machineId: machineId,
      agentId: agentId,
    ));
    await showGate?.future;
    return answer;
  }

  @override
  Future<void> withdraw(String id) async => withdrawn.add(id);

  @override
  set onTap(void Function(String machineId, String agentId)? handler) =>
      tap = handler;
}

AgentAlert _alert(
  String agentId, {
  AlertKind kind = AlertKind.done,
  String? title,
}) => AgentAlert(
  machineId: 'm1',
  agentId: agentId,
  title: title ?? agentId,
  kind: kind,
  at: DateTime(2026, 9, 25, 12),
);

class _ConflictApi extends ApiClient {
  _ConflictApi() : super(config: AppConfig.dev, session: AuthSession());

  @override
  Future<Map<String, dynamic>?> daemonDevices() async => {
    'members': <Object?>[],
    'pending': <String>[],
    'conflict': {'pub': 'holder', 'label': 'Old install', 'fingerprint': 'AAAA·BBBB', 'addedAt': 5, 'afterJoin': true},
  };
}

const _machine = Machine(
  machineId: 'm1',
  authMode: MachineAuthMode.remote,
  name: 'MacBook-Pro.local',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  DesktopNotificationStore store({bool on = true}) =>
      DesktopNotificationStore(storage: _Memory())..value = on;

  group('the switch', () {
    test('is OFF until somebody asks for it', () {
      expect(DesktopNotificationStore(storage: _Memory()).value, isFalse);
    });

    test('survives a restart, and only a real "on" turns it on', () async {
      final memory = _Memory();
      await DesktopNotificationStore(storage: memory).set(true);
      final reopened = DesktopNotificationStore(storage: memory);
      await reopened.load();
      expect(reopened.value, isTrue);

      memory.values['app_desktop_notifications'] = 'o';
      final garbled = DesktopNotificationStore(storage: memory);
      await garbled.load();
      expect(garbled.value, isFalse);
    });

    test('turning it on is when permission is asked, and not before', () async {
      final os = _Recorder();
      final system = SystemNotifications(store: store(on: false), notifier: os);
      expect(os.authorizations, 0);
      await system.setEnabled(true);
      expect(os.authorizations, 1);
      expect(system.permission.value, NotificationPermission.granted);
      await system.setEnabled(false);
      expect(os.authorizations, 1, reason: 'turning it off asks nothing');
    });
  });

  group('posting', () {
    test('a delayed OS post cannot resurrect a message already read', () async {
      final os = _Recorder()..showGate = Completer<void>();
      final system = SystemNotifications(store: store(), notifier: os);
      system.post(_alert('a'));
      system.withdraw('m1', 'a');
      system.post(_alert('a', title: 'New turn'));
      expect(os.shown, hasLength(1));
      expect(os.withdrawn, isEmpty);
      os.showGate!.complete();
      await Future<void>.delayed(Duration.zero);
      expect(os.withdrawn, [SystemNotifications.idFor('m1', 'a')]);
      expect(os.shown, hasLength(2));
      expect(os.shown.last.title, 'New turn');
    });

    test('nothing while the switch is off', () async {
      final os = _Recorder();
      SystemNotifications(
        store: store(on: false),
        notifier: os,
      ).post(_alert('a'));
      await Future<void>.delayed(Duration.zero);
      expect(os.shown, isEmpty);
    });

    test(
      'says who and what, under one id per agent so a busy one replaces itself',
      () async {
        final os = _Recorder();
        final system = SystemNotifications(store: store(), notifier: os);
        system.post(_alert('a', title: 'Fix login'));
        system.post(_alert('a', kind: AlertKind.needsYou, title: 'Fix login'));
        system.post(_alert('b'));
        await Future<void>.delayed(Duration.zero);
        final a = os.shown.where((s) => s.agentId == 'a').toList();
        final b = os.shown.where((s) => s.agentId == 'b').single;
        expect(a.map((s) => s.body), ['Finished', 'Waiting on you']);
        expect(b.body, 'Finished');
        expect(os.shown.first.title, 'Fix login');
        expect(a[0].id, a[1].id);
        expect(a[0].id, isNot(b.id));
        expect(os.shown.first.machineId, 'm1');
        expect(os.shown.first.agentId, 'a');
      },
    );

    test('a build that cannot post stops being asked', () async {
      final os = _Recorder(answer: NotificationPermission.unavailable);
      final system = SystemNotifications(store: store(), notifier: os);
      system.post(_alert('a'));
      await Future<void>.delayed(Duration.zero);
      expect(system.permission.value, NotificationPermission.unavailable);
      system.post(_alert('b'));
      await Future<void>.delayed(Duration.zero);
      expect(os.shown, hasLength(1));
    });

    test('a denial is asked about again, so allowing it later works without a restart', () async {
      final os = _Recorder(answer: NotificationPermission.denied);
      final system = SystemNotifications(store: store(), notifier: os);
      system.post(_alert('a'));
      await Future<void>.delayed(Duration.zero);
      expect(system.permission.value, NotificationPermission.denied);
      // The person allows Harness in System Settings.
      os.answer = NotificationPermission.granted;
      system.post(_alert('b'));
      await Future<void>.delayed(Duration.zero);
      expect(os.shown, hasLength(2));
      expect(system.permission.value, NotificationPermission.granted);
    });

    test('a platform with no notifier is never asked', () async {
      final os = _Recorder(isSupported: false);
      final system = SystemNotifications(store: store(), notifier: os);
      system.post(_alert('a'));
      system.withdraw('m1', 'a');
      await Future<void>.delayed(Duration.zero);
      expect(os.shown, isEmpty);
      expect(os.withdrawn, isEmpty);
    });
  });

  group('the window', () {
    late _Recorder os;
    late AppLifecycleState state;

    AppNotifier wired() {
      os = _Recorder();
      state = AppLifecycleState.inactive;
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        alerts: AlertSounds(
          store: AlertSoundStore(storage: _Memory()),
          channel: const MethodChannel('test/no-sound'),
        ),
        agentAlerts: AgentAlerts(
          store: ScreenAlertStore(storage: _Memory())..value = true,
        ),
        systemNotifications: SystemNotifications(store: store(), notifier: os),
      )..lifecycle = () => state;
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine)
        ..agents = [const Agent(id: 'a1', name: 'Fix login', engine: 'codex')];
      return app;
    }

    Future<void> finish(AppNotifier app) =>
        app.handleMachineEventForTest('m1', {
          'type': 'turn_summary',
          'agentId': 'a1',
          'payload': {
            'agentId': 'a1',
            'notification': {'id': 'result-a1', 'kind': 'done'},
          },
        });

    // Notifications are off until somebody wants them; the one offer comes
    // when an agent finished while the person was away and nothing told them.
    test('an agent that finished while away offers notifications once, on return', () async {
      os = _Recorder();
      state = AppLifecycleState.inactive;
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        alerts: AlertSounds(
          store: AlertSoundStore(storage: _Memory()),
          channel: const MethodChannel('test/no-sound'),
        ),
        agentAlerts: AgentAlerts(store: ScreenAlertStore(storage: _Memory())),
        systemNotifications: SystemNotifications(store: store(on: false), notifier: os),
      )..lifecycle = () => state;
      addTearDown(app.dispose);
      app.notificationOfferStoreForTest = NotificationOfferStore(storage: _Memory());
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine)
        ..agents = [const Agent(id: 'a1', name: 'Fix login', engine: 'codex')];
      var offers = 0;
      app.notificationOffer = () => offers++;
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await finish(app);
      await Future<void>.delayed(Duration.zero);
      expect(os.shown, isEmpty);
      expect(offers, 0, reason: 'not while the person is away');
      state = AppLifecycleState.resumed;
      app.appLifecycleChanged(AppLifecycleState.resumed);
      expect(offers, 1);
      expect(app.notificationOfferStoreForTest.value, isTrue);

      state = AppLifecycleState.inactive;
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await app.handleMachineEventForTest('m1', {
        'type': 'turn_summary',
        'agentId': 'a1',
        'payload': {
          'agentId': 'a1',
          'notification': {'id': 'result-a1-2', 'kind': 'done'},
        },
      });
      app.appLifecycleChanged(AppLifecycleState.resumed);
      expect(offers, 1, reason: 'asked once, whatever the answer');

      await app.acceptNotificationOffer();
      expect(app.systemNotifications.store.value, isTrue);
      expect(os.authorizations, 1);
    });

    test('no offer when notifications are already on', () async {
      final app = wired();
      addTearDown(app.dispose);
      app.notificationOfferStoreForTest = NotificationOfferStore(storage: _Memory());
      var offers = 0;
      app.notificationOffer = () => offers++;
      app.appLifecycleChanged(AppLifecycleState.inactive);
      await finish(app);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      expect(offers, 0);
    });

    test('an agent that finishes while the window is behind something reaches the system', () async {
      final app = wired();
      addTearDown(app.dispose);
      await finish(app);
      await Future<void>.delayed(Duration.zero);
      expect(os.shown.single.title, 'Fix login');
      expect(os.shown.single.body, 'Finished');
    });

    test(
      'in front of the window, the banner says it and the system does not',
      () async {
        final app = wired();
        addTearDown(app.dispose);
        state = AppLifecycleState.resumed;
        await finish(app);
        await Future<void>.delayed(Duration.zero);
        expect(app.agentAlerts.alerts, hasLength(1));
        expect(os.shown, isEmpty);
      },
    );

    test('going to the agent takes its notification down', () async {
      final app = wired();
      addTearDown(app.dispose);
      await finish(app);
      app.markAgentSeen('m1', 'a1');
      await Future<void>.delayed(Duration.zero);
      expect(os.withdrawn, [SystemNotifications.idFor('m1', 'a1')]);
    });

    test('reading on the dial withdraws the banner and system notification', () async {
      final app = wired();
      addTearDown(app.dispose);
      await finish(app);
      await Future<void>.delayed(Duration.zero);
      expect(app.agentAlerts.alerts, hasLength(1));
      final token = app.agentUnread.readTokenFor('m1', 'a1')!;
      await app.handleMachineEventForTest('m1', {
        'type': 'dial_notification_read',
        'payload': {'machineId': 'm1', 'agentId': 'a1', 'readToken': token},
      });
      expect(app.agentUnread.count, 0);
      expect(app.agentAlerts.alerts, isEmpty);
      expect(os.withdrawn, [SystemNotifications.idFor('m1', 'a1')]);
    });
  });

  group('macOS', () {
    const channel = MethodChannel('harness/notifications');
    late List<MethodCall> calls;
    late Object? Function(MethodCall) reply;

    setUp(() {
      calls = [];
      reply = (_) => 'granted';
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            calls.add(call);
            return reply(call);
          });
    });

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });

    test(
      'posts through the native channel with the agent it is about',
      () async {
        final mac = MacSystemNotifier(channel: channel);
        final answer = await mac.show(
          id: 'harness-agent:m1/a1',
          title: 'Fix login',
          body: 'Finished',
          machineId: 'm1',
          agentId: 'a1',
        );
        expect(answer, NotificationPermission.granted);
        expect(calls.single.method, 'show');
        expect(calls.single.arguments, {
          'id': 'harness-agent:m1/a1',
          'title': 'Fix login',
          'body': 'Finished',
          'machineId': 'm1',
          'agentId': 'a1',
        });
      },
    );

    test('an ad-hoc build the system refuses reads as unavailable', () async {
      reply = (_) => 'unavailable';
      expect(
        await MacSystemNotifier(channel: channel).authorize(),
        NotificationPermission.unavailable,
      );
    });

    test('a click comes back as the agent to open; a click about nobody does nothing', () async {
      final mac = MacSystemNotifier(channel: channel);
      final taps = <String>[];
      mac.onTap = (m, a) => taps.add('$m/$a');
      Future<void> tap(Map<String, String> args) =>
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .handlePlatformMessage(
                channel.name,
                const StandardMethodCodec().encodeMethodCall(
                  MethodCall('tapped', args),
                ),
                (_) {},
              );
      await tap({'machineId': 'm1', 'agentId': 'a1'});
      await tap({'machineId': '', 'agentId': ''});
      expect(taps, ['m1/a1']);
      mac.onTap = null;
    });

    test('a click on a device notice comes back as that device', () async {
      final mac = MacSystemNotifier(channel: channel);
      final taps = <String>[];
      mac.onTap = (m, a) => taps.add('$m/$a');
      Future<void> tap(Map<String, String> args) =>
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
              .handlePlatformMessage(
                channel.name,
                const StandardMethodCodec().encodeMethodCall(
                  MethodCall('tapped', args),
                ),
                (_) {},
              );
      await tap({'machineId': SystemNotifications.deviceNoticeMachine, 'agentId': 'pub-1'});
      // A device notice with no key in it opens nothing.
      await tap({'machineId': SystemNotifications.deviceNoticeMachine, 'agentId': ''});
      expect(taps, ['@device/pub-1']);
      mac.onTap = null;
    });
  });

  group('device notices', () {
    test('carry the device in the click slots; an account notice without one carries nothing', () async {
      final os = _Recorder();
      final system = SystemNotifications(store: store(), notifier: os);
      system.postNotice(id: 'harness-device:p', title: 'New device on your account', body: 'b', devicePub: 'p');
      system.postNotice(id: 'harness-other', title: 't', body: 'b');
      await Future<void>.delayed(Duration.zero);
      expect(SystemNotifications.deviceNoticeMachine, '@device');
      expect(os.shown.map((s) => (s.machineId, s.agentId)), [('@device', 'p'), ('', '')]);
    });

    test('a device the daemon announces reaches the system, naming the device and where to remove it', () async {
      final os = _Recorder();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        systemNotifications: SystemNotifications(store: store(), notifier: os),
      );
      addTearDown(app.dispose);
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);
      app.ownDaemonMachineIdForTest('m1');
      await app.handleEventForTest('m1', {
        'type': 'device_key_added',
        'payload': {'pub': 'pub-1', 'label': 'Test iPad', 'kind': 'viewer', 'fingerprint': 'AAAA·BBBB·CCCC·DDDD'},
      });
      await Future<void>.delayed(Duration.zero);
      expect(app.newDevices.single.pub, 'pub-1');
      expect(app.newDevices.single.fingerprint, 'AAAA·BBBB·CCCC·DDDD');
      final shown = os.shown.single;
      expect(shown.title, 'New device on your account');
      expect(shown.body, endsWith('Not yours? Remove it in Settings ▸ Your devices.'));
      expect(shown.body, contains('Test iPad'));
      expect((shown.machineId, shown.agentId), ('@device', 'pub-1'));
    });

    Map<String, Object?> removedFrame({bool signerPending = false, bool selfRemoved = false, String pub = 'gone'}) => {
      'type': 'device_key_removed',
      'payload': {
        'pub': pub, 'label': 'Old iPad', 'kind': 'viewer', 'fingerprint': 'AAAA·BBBB',
        'signer': 'signer', 'signerLabel': 'MacBook', 'signerFingerprint': 'E2FB·0DF5·5FD8·E6C7',
        'signerPending': signerPending, 'selfRemoved': selfRemoved, 'at': 1,
      },
    };

    test('a removal the daemon reports reaches the system and the band; a red one opens the signer', () async {
      final os = _Recorder();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        systemNotifications: SystemNotifications(store: store(), notifier: os),
      );
      addTearDown(app.dispose);
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);
      app.ownDaemonMachineIdForTest('m1');
      await app.handleEventForTest('m1', removedFrame());
      await app.handleEventForTest('m1', removedFrame(signerPending: true));
      await Future<void>.delayed(Duration.zero);
      // The same device twice is one notice, the later word.
      expect(app.deviceRemovals.single.signerPending, isTrue);
      expect(os.shown.map((n) => n.title), ['Device removed', 'Removed by a new device']);
      expect(os.shown.first.body, 'Old iPad was removed from your account by MacBook.');
      expect((os.shown.first.machineId, os.shown.first.agentId), ('', ''));
      expect((os.shown.last.machineId, os.shown.last.agentId), ('@device', 'signer'));
      // A new device that signs itself out is its own act: not red, and nothing to open.
      await app.handleEventForTest('m1', removedFrame(signerPending: true, selfRemoved: true, pub: 'other'));
      expect(os.shown.last.title, 'Device signed out');
      expect((os.shown.last.machineId, os.shown.last.agentId), ('', ''));
      app.dismissDeviceRemoval('gone');
      app.dismissDeviceRemoval('other');
      expect(app.deviceRemovals, isEmpty);
      // A frame that is not whole raises nothing.
      await app.handleEventForTest('m1', {'type': 'device_key_removed', 'payload': {'pub': 'x'}});
      expect(app.deviceRemovals, isEmpty);
    });

    test('a red removal is never softened by a later plain one for the same device', () async {
      final os = _Recorder();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        systemNotifications: SystemNotifications(store: store(), notifier: os),
      );
      addTearDown(app.dispose);
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);
      app.ownDaemonMachineIdForTest('m1');
      await app.handleEventForTest('m1', removedFrame(signerPending: true));
      await app.handleEventForTest('m1', removedFrame());
      expect(app.deviceRemovals.single.red, isTrue);
      expect(os.shown.map((n) => n.title), ['Removed by a new device']);
    });

    test('device frames from any machine but this computer’s own daemon raise nothing', () async {
      final os = _Recorder();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        systemNotifications: SystemNotifications(store: store(), notifier: os),
      );
      addTearDown(app.dispose);
      const relayed = Machine(machineId: 'relayed', authMode: MachineAuthMode.remote, name: 'Remote');
      app.machines = [_machine, relayed];
      app.machineStates['m1'] = MachineState(_machine);
      // The relayed machine carries a backend-supplied computer id that says it is "local": still not the daemon.
      app.machineStates['relayed'] = MachineState(relayed)..localOnly = true;
      app.ownDaemonMachineIdForTest('m1');
      await app.handleEventForTest('relayed', {
        'type': 'device_key_added',
        'payload': {'pub': 'fake', 'label': 'X', 'kind': 'viewer'},
      });
      await app.handleEventForTest('relayed', removedFrame(signerPending: true));
      await app.handleEventForTest('relayed', {'type': 'device_conflict', 'payload': {'pub': 'holder', 'label': 'H', 'fingerprint': 'AAAA', 'addedAt': 5, 'afterJoin': true}});
      await Future<void>.delayed(Duration.zero);
      expect(app.newDevices, isEmpty);
      expect(app.deviceRemovals, isEmpty);
      expect(app.deviceConflict, isNull);
      expect(os.shown, isEmpty);
      // The same frames from the own daemon are the daemon's word.
      await app.handleEventForTest('m1', removedFrame(signerPending: true));
      expect(app.deviceRemovals.single.red, isTrue);
    });

    test('a conflict frame is only a hint: the conflict is re-read from the daemon, and stays dismissed', () async {
      final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null);
      addTearDown(app.dispose);
      final api = _ConflictApi();
      app.api = api;
      app.machines = [_machine];
      app.machineStates['m1'] = MachineState(_machine);
      app.ownDaemonMachineIdForTest('m1');
      // A frame carrying a fake holder changes nothing by itself: what the daemon lists is what shows.
      final frame = {
        'type': 'device_conflict',
        'payload': {'pub': 'fake', 'label': 'Fake', 'fingerprint': 'FFFF', 'addedAt': 5, 'afterJoin': true},
      };
      await app.handleEventForTest('m1', frame);
      await Future<void>.delayed(Duration.zero);
      expect(app.deviceConflict?.pub, 'holder');
      expect(app.deviceConflict?.afterJoin, isTrue);
      app.dismissDeviceConflict();
      await app.handleEventForTest('m1', frame);
      await Future<void>.delayed(Duration.zero);
      expect(app.deviceConflict, isNull);
    });
  });

  group('Linux', () {
    late List<List<String>> ran;

    LinuxSystemNotifier linux(
      ProcessResult Function(List<String> args) answer,
    ) {
      ran = [];
      return LinuxSystemNotifier(
        run: (exe, args) async {
          expect(exe, 'notify-send');
          ran.add(args);
          return answer(args);
        },
      );
    }

    Future<NotificationPermission> post(
      LinuxSystemNotifier n, {
      String title = 'Fix login',
    }) => n.show(
      id: 'x',
      title: title,
      body: 'Finished',
      machineId: 'm1',
      agentId: 'a1',
    );

    test('the second notification for an agent replaces the first', () async {
      var next = 41;
      final n = linux((_) => ProcessResult(0, 0, '${++next}\n', ''));
      expect(await post(n), NotificationPermission.granted);
      await post(n);
      expect(ran[0], containsAll(['--app-name=Harness', '--print-id']));
      expect(ran[0].any((a) => a.startsWith('--replace-id')), isFalse);
      expect(ran[1], contains('--replace-id=42'));
    });

    test('an agent named like a flag is still a title', () async {
      final n = linux((_) => ProcessResult(0, 0, '7', ''));
      await post(n, title: '-u critical');
      final args = ran.single;
      expect(args.indexOf('--'), lessThan(args.indexOf('-u critical')));
    });

    test(
      'an old notify-send that refuses the flags still gets its notification',
      () async {
        final n = linux(
          (args) => args.contains('--print-id')
              ? ProcessResult(0, 1, '', 'Unknown option --print-id')
              : ProcessResult(0, 0, '', ''),
        );
        expect(await post(n), NotificationPermission.granted);
        await post(n);
        expect(
          ran,
          hasLength(3),
          reason: 'the flags are tried once, then left off',
        );
        expect(ran.last.contains('--print-id'), isFalse);
      },
    );

    test('a daemon that is not up yet is tried again next time', () async {
      var up = false;
      final n = linux(
        (_) => up
            ? ProcessResult(0, 0, '9', '')
            : ProcessResult(0, 1, '', 'Could not connect'),
      );
      expect(await post(n), NotificationPermission.unknown);
      up = true;
      expect(await post(n), NotificationPermission.granted);
      // A daemon that was down is not a notify-send without the flags.
      expect(ran.last, contains('--print-id'));
    });

    test(
      'a desktop without notify-send is unavailable, not an error',
      () async {
        final n = LinuxSystemNotifier(
          run: (_, _) async => throw const ProcessException('notify-send', []),
        );
        expect(await n.authorize(), NotificationPermission.unavailable);
        expect(await post(n), NotificationPermission.unavailable);
      },
    );
  });

  group('Settings', () {
    Future<void> pump(WidgetTester tester, SystemNotifications system) =>
        tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: AlertsCard(
                store: AlertSoundStore(storage: _Memory()),
                screenStore: ScreenAlertStore(storage: _Memory()),
                notifications: system,
              ),
            ),
          ),
        );

    testWidgets('each alert switch announces its own purpose and state', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      try {
        final os = _Recorder();
        final system = SystemNotifications(
          store: store(on: false),
          notifier: os,
        );
        await pump(tester, system);
        for (final (key, label) in [
          ('settings-screen-alerts', 'On-screen alerts'),
          ('settings-alert-sounds', 'Alert sounds'),
          ('settings-desktop-notifications', 'Desktop notifications'),
        ]) {
          final toggle = find.byKey(Key(key));
          final node = tester.getSemantics(toggle);
          final before = node.getSemanticsData();
          expect(before.label, label);
          expect(before.flagsCollection.isToggled, Tristate.isFalse);
          expect(before.hasAction(SemanticsAction.tap), isTrue);
          tester
              .renderObject(toggle)
              .owner!
              .semanticsOwner!
              .performAction(node.id, SemanticsAction.tap);
          await tester.pumpAndSettle();
          final after = tester.getSemantics(toggle).getSemanticsData();
          expect(after.label, label);
          expect(after.flagsCollection.isToggled, Tristate.isTrue);
        }
        expect(os.authorizations, 1);
      } finally {
        semantics.dispose();
      }
    });

    testWidgets('a switch that asks for permission when turned on', (
      tester,
    ) async {
      final os = _Recorder();
      final system = SystemNotifications(store: store(on: false), notifier: os);
      await pump(tester, system);
      await tester.tap(find.byKey(const Key('settings-desktop-notifications')));
      await tester.pumpAndSettle();
      expect(system.store.value, isTrue);
      expect(os.authorizations, 1);
    });

    testWidgets('says where to fix it when the system said no', (tester) async {
      final system = SystemNotifications(
        store: store(on: false),
        notifier: _Recorder(answer: NotificationPermission.denied),
      );
      await pump(tester, system);
      await tester.tap(find.byKey(const Key('settings-desktop-notifications')));
      await tester.pumpAndSettle();
      // The platform's own advice: System Settings on a Mac, the site's
      // settings in a browser.
      expect(
        find.textContaining('Allow it where the recorder says.'),
        findsOneWidget,
      );
      expect(MacSystemNotifier().deniedAdvice, contains('System Settings'));
    });

    testWidgets('no row where there is no notifier to switch', (tester) async {
      await pump(
        tester,
        SystemNotifications(store: store(), notifier: const NoSystemNotifier()),
      );
      expect(
        find.byKey(const Key('settings-desktop-notifications')),
        findsNothing,
      );
    });
  });
}
