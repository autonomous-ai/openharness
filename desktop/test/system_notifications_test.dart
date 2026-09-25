// The third alert channel: news the operating system delivers, so it reaches somebody whose window
// is somewhere else. When it is posted, what replaces what, what takes it down, what a click does,
// and how each platform's notifier is driven.
import 'dart:io' show ProcessException, ProcessResult;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/settings/sections/alerts_card.dart';
import 'package:harness/state/app_state.dart';

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
  void Function(String machineId, String agentId)? tap;

  @override
  bool get supported => isSupported;

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
        expect(os.shown.map((s) => s.body), [
          'Finished',
          'Waiting on you',
          'Finished',
        ]);
        expect(os.shown.first.title, 'Fix login');
        expect(os.shown[0].id, os.shown[1].id);
        expect(os.shown[0].id, isNot(os.shown[2].id));
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
          'type': 'turn_ended',
          'agentId': 'a1',
          'payload': {'agentId': 'a1'},
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
      expect(find.textContaining('System Settings'), findsOneWidget);
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
