import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/update_harness.dart';
import 'package:harness/api/api_client.dart'
    show ApiException, HarnessTooOldException;
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/harness_os/intern_setup_dialog.dart';
import 'package:harness/harness_os/setup_hotspot.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/machine_api.dart';

/// An Intern 3's setup page at 10.42.0.1, as this computer reaches it once the person has joined
/// its hotspot: [info] null while they have not (every request fails to connect).
class FakeBox implements HttpClientAdapter {
  Map<String, dynamic>? info;
  List<Map<String, Object?>> networks = const [
    {'ssid': 'Home', 'signal': 82, 'security': 'WPA2'},
    {'ssid': 'Cafe', 'signal': 40, 'security': ''},
  ];

  /// The computer's own password.
  String password = 'open sesame';

  final calls = <String>[];
  final checks = <String>[];
  final connects = <Map<String, dynamic>>[];
  final unlocks = <({String password, Map<String, dynamic>? setup})>[];

  SetupHotspot get hotspot => SetupHotspot(
    dio: Dio(
      BaseOptions(
        baseUrl: 'http://${SetupHotspot.address}',
        validateStatus: (_) => true,
      ),
    )..httpClientAdapter = this,
  );

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final bytes = <int>[
      if (requestStream != null)
        for (final chunk in await requestStream.toList()) ...chunk,
    ];
    final query = options.uri.query;
    calls.add(
      '${options.method} ${options.uri.path}${query.isEmpty ? '' : '?$query'}',
    );
    if (info == null) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    switch (options.uri.path) {
      case '/setup':
        return _json(200, info);
      case '/setup/networks':
        return _json(200, {'networks': networks});
      case '/setup/check':
        final tried = utf8.decode(bytes);
        checks.add(tried);
        return tried == password
            ? _json(200, const {})
            : _json(403, const {'message': 'Wrong password.'});
      case '/setup/unlock':
        final header = options.headers.entries
            .where((e) => e.key.toLowerCase() == 'x-harness-setup-length')
            .map((e) => int.parse('${e.value}'))
            .firstOrNull;
        final cut = header == null ? bytes.length : bytes.length - header;
        final tried = utf8.decode(bytes.sublist(0, cut));
        if (tried != password) {
          return _json(403, const {'message': 'Wrong password.'});
        }
        unlocks.add((
          password: tried,
          setup: header == null
              ? null
              : jsonDecode(utf8.decode(bytes.sublist(cut)))
                    as Map<String, dynamic>,
        ));
        return _json(200, const {});
      case '/setup/connect':
        connects.add(jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>);
        return _json(202, const {'run': 1});
    }
    return _json(404, const {});
  }

  static ResponseBody _json(int status, Object? data) =>
      ResponseBody.fromString(
        jsonEncode(data),
        status,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );

  @override
  void close({bool force = false}) {}
}

/// The account through this computer's CLI: its machines and the box tickets it gives.
class FakeAccount extends MachineApi {
  List<Machine> list = const [];
  int tickets = 0;

  @override
  Future<List<Machine>> machines() async => list;

  /// This computer's Harness predates the ticket's route until it is updated.
  bool tooOld = false;

  /// This computer is on the device's hotspot, with no Internet: its Harness's gateway answers 502.
  bool offline = false;

  @override
  Future<String> boxTicket() async {
    if (tooOld) throw HarnessTooOldException();
    if (offline) throw ApiException('fetch failed', status: 502);
    return 'ticket-${++tickets}';
  }
}

class _Quiet extends WsConn {
  _Quiet()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async => const {};
}

class _NoDiscovery extends LocalCliDiscovery {
  _NoDiscovery(this.here) : super(config: AppConfig.dev);

  /// This computer's id, which makes the account's machine of that id this computer.
  final String? here;
  @override
  Future<String?> computerId() async => here;
  @override
  Future<LocalCliEndpoint?> discover({String? expectedComputerId}) async =>
      null;
}

AppNotifier internApp(FakeAccount api, {String? here}) =>
    AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        localCliDiscovery: _NoDiscovery(here),
        connectionForTest: (_) => _Quiet(),
      )
      ..api = api
      ..currentUser = const CurrentUserProfile(id: 'user-1', email: 'a@b.c');

/// A window with one button that opens what [open] opens, as Computers would.
Future<void> pumpHost(
  WidgetTester tester,
  void Function(BuildContext context) open,
) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Builder(
          builder: (context) => Center(
            child: TextButton(
              onPressed: () => open(context),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    ),
  );
}

/// Time passes by [by], and what it set going finishes.
Future<void> wait(WidgetTester tester, [Duration by = Duration.zero]) async {
  await tester.pump(by);
  for (var i = 0; i < 6; i++) {
    await tester.pump();
  }
}

Future<void> press(WidgetTester tester, String key) async {
  // Scrolled to first, as the person would: the steps above can push it below the fold.
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await wait(tester);
}

/// The setup step shown as the current one.
int step(WidgetTester tester) {
  for (var i = 0; i < 5; i++) {
    final semantics = tester.widget<Semantics>(
      find.byKey(Key('intern-step:$i')),
    );
    if (semantics.properties.selected == true) return i;
  }
  return 5;
}

/// The person ticks that this computer is on its hotspot, and presses Connect.
Future<void> joinHotspot(WidgetTester tester) async {
  await press(tester, 'intern-setup-joined');
  await press(tester, 'intern-setup-connect-hotspot');
}

/// The status line under the dialog: what is going on, or why it stopped.
String? message(WidgetTester tester) {
  final line = find.byKey(const Key('intern-message'));
  if (line.evaluate().isEmpty) return null;
  return tester.widget<SelectableText>(line).data;
}

void main() {
  late FakeBox box;
  late FakeAccount account;
  late AppNotifier app;

  setUp(() {
    box = FakeBox();
    account = FakeAccount();
    app = internApp(account);
  });

  Future<void> open(WidgetTester tester) async {
    final hotspot = box.hotspot;
    await pumpHost(
      tester,
      (context) => showInternSetup(context, app, hotspot: hotspot),
    );
    await tester.tap(find.text('Open'));
    await wait(tester);
    expect(find.text('Set up Intern 3'), findsOneWidget);
    // Every step and what it asks, before anything starts.
    expect(step(tester), 0);
    expect(find.text('Join its Wi-Fi'), findsOneWidget);
    expect(
      find.text('Pick “Harness-…” in this computer’s Wi-Fi menu.'),
      findsOneWidget,
    );
  }

  const unlockedBox = {
    'protocol': 3,
    'hotspot': 'Harness-AB12',
    'computerId': 'ab12-cd34-ef56',
    'signedIn': false,
    'online': false,
  };

  /// Started, the person joins its hotspot, and it lists its Wi-Fi.
  Future<void> joinUnlocked(WidgetTester tester) async {
    await press(tester, 'intern-setup-start');
    // The ticket comes first, while this computer is still on its own Wi-Fi.
    expect(account.tickets, 1);
    expect(step(tester), 1);
    // What each step asks was for before the start.
    expect(
      find.text('Pick “Harness-…” in this computer’s Wi-Fi menu.'),
      findsNothing,
    );
    expect(
      find.text(
        'Join “Harness-…” in this computer’s Wi-Fi menu. Not there? Check Intern 3 is on.',
      ),
      findsOneWidget,
    );
    // Nothing is asked of it until the person says this computer joined it.
    expect(message(tester), isNull);
    await press(tester, 'intern-setup-connect-hotspot');
    expect(box.calls, isEmpty);
    await joinHotspot(tester);
    expect(message(tester), 'Looking for Intern 3…');
    // Not on it yet: asked again every 2 s.
    await wait(tester, const Duration(seconds: 2));
    box.info = Map.of(unlockedBox);
    await wait(tester, const Duration(seconds: 2));
    expect(find.text('Choose the Wi-Fi for Intern 3.'), findsOneWidget);
    expect(find.byKey(const Key('intern-network:Home')), findsOneWidget);
    expect(find.byKey(const Key('intern-network:Cafe')), findsOneWidget);
    expect(step(tester), 3);
  }

  Future<void> sendHome(WidgetTester tester, String password) async {
    await press(tester, 'intern-network:Home');
    expect(find.text('The password for “Home”.'), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('intern-setup-password')),
      password,
    );
    await press(tester, 'intern-setup-connect');
  }

  testWidgets(
    'an unlocked Intern 3: ticket, its hotspot, its Wi-Fi, online, named',
    (tester) async {
      await open(tester);
      await joinUnlocked(tester);

      // Too short: said, and nothing is sent.
      await sendHome(tester, 'short');
      expect(message(tester), 'A Wi-Fi password has 8 to 63 characters.');
      expect(box.connects, isEmpty);

      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'hunter2222',
      );
      await press(tester, 'intern-setup-connect');
      expect(box.connects, [
        {'ssid': 'Home', 'password': 'hunter2222', 'ticket': 'ticket-1'},
      ]);
      expect(
        find.text(
          'Harness-AB12 is joining “Home” and signing in to your account.',
        ),
        findsOneWidget,
      );
      expect(message(tester), 'Waiting for Intern 3…');
      expect(step(tester), 4);
      // The wait moves while it lasts.
      expect(find.byType(LinearProgressIndicator), findsOneWidget);

      // Not in the account yet; then it is, running, by its computer id.
      await wait(tester, const Duration(seconds: 3));
      expect(find.byKey(const Key('intern-setup-name')), findsNothing);
      account.list = const [
        Machine(
          machineId: 'm-other',
          computerId: 'ffff',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'Laptop',
        ),
        Machine(
          machineId: 'm-new',
          computerId: 'AB12CD34EF56',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'Harness-AB12',
        ),
      ];
      await wait(tester, const Duration(seconds: 3));
      expect(
        find.text('Harness-AB12 is online. Give it a name.'),
        findsOneWidget,
      );
      final name = find.byKey(const Key('intern-setup-name'));
      expect(tester.widget<TextField>(name).controller!.text, 'Harness-AB12');
      await tester.enterText(name, 'Den box');
      await press(tester, 'intern-setup-done');
      expect(account.renames, [('m-new', 'Den box')]);
      expect(find.text('Set up Intern 3'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'a locked Intern 3 this computer last read online: read again at Start, it is told apart once back',
    (tester) async {
      box.info = {
        'protocol': 3,
        'hotspot': 'Harness-BD19',
        'locked': true,
        'wait': 0,
      };
      // Read before it was restarted: running, as far as this computer knows.
      account.list = const [
        Machine(
          machineId: 'm-box',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'harness',
        ),
      ];
      await app.refreshMachines();
      // What the account says now: waiting at its password, offline.
      account.list = const [
        Machine(
          machineId: 'm-box',
          authMode: MachineAuthMode.remote,
          status: 'offline',
          name: 'harness',
        ),
      ];
      await open(tester);
      await press(tester, 'intern-setup-start');
      await joinHotspot(tester);
      await tester.enterText(
        find.byKey(const Key('intern-setup-secret')),
        'open sesame',
      );
      await press(tester, 'intern-setup-unlock');
      await press(tester, 'intern-network:Home');
      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'hunter2222',
      );
      await press(tester, 'intern-setup-connect');
      expect(box.unlocks, hasLength(1));
      expect(step(tester), 4);

      account.list = const [
        Machine(
          machineId: 'm-box',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'harness',
        ),
      ];
      await wait(tester, const Duration(seconds: 3));
      expect(step(tester), 5);
      final name = find.byKey(const Key('intern-setup-name'));
      // Set up before: it keeps its own name.
      expect(tester.widget<TextField>(name).controller!.text, 'harness');
      await press(tester, 'intern-setup-done');
      expect(account.renames, isEmpty);
      expect(find.text('Set up Intern 3'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'a wrong Wi-Fi password: this computer, back online, is not taken for it, and its hotspot back with why goes to the Wi-Fi again',
    (tester) async {
      box.info = {
        'protocol': 3,
        'hotspot': 'Harness-BD19',
        'locked': true,
        'wait': 0,
      };
      // This computer is one of the account's machines.
      app.dispose();
      app = internApp(account, here: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const mac = Machine(
        machineId: 'm-mac',
        computerId: 'AAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAA',
        authMode: MachineAuthMode.remote,
        status: 'running',
        name: 'MacBooks-MacBook-Pro-6.local',
      );
      account.list = const [mac];
      await app.refreshMachines();
      expect(app.machineStates['m-mac']!.isLocalMachine, isTrue);
      await open(tester);
      await press(tester, 'intern-setup-start');
      await joinHotspot(tester);
      await tester.enterText(
        find.byKey(const Key('intern-setup-secret')),
        'open sesame',
      );
      await press(tester, 'intern-setup-unlock');
      await press(tester, 'intern-network:Home');
      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'wrongpass1',
      );
      await press(tester, 'intern-setup-connect');
      expect(step(tester), 4);
      // No way back while it tries.
      expect(find.byKey(const Key('intern-setup-again')), findsNothing);

      // While this computer was on the hotspot, the account read it offline; now it is back.
      box.info = null;
      account.list = const [
        Machine(
          machineId: 'm-mac',
          computerId: 'AAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAA',
          authMode: MachineAuthMode.remote,
          status: 'offline',
          name: 'MacBooks-MacBook-Pro-6.local',
        ),
      ];
      await wait(tester, const Duration(seconds: 3));
      account.list = const [mac];
      await wait(tester, const Duration(seconds: 3));
      expect(step(tester), 4);
      expect(find.byKey(const Key('intern-setup-name')), findsNothing);

      // It could not join "Home": its own setup page is back, with why.
      box.info = {
        ...unlockedBox,
        'hotspot': 'Harness-BD19',
        'result': {
          'run': 1,
          'state': 'failed',
          'ssid': 'Home',
          'message': 'Wrong Wi-Fi password.',
        },
      };
      await wait(tester, const Duration(seconds: 3));
      await wait(tester);
      expect(find.text('Choose the Wi-Fi for Intern 3.'), findsOneWidget);
      expect(message(tester), 'Wrong Wi-Fi password.');
      expect(account.renames, isEmpty);
      await press(tester, 'intern-setup-close');
      app.dispose();
    },
  );

  testWidgets(
    'a locked Intern 3 (protocol 3): its password checked, then its Wi-Fi, then one unlock',
    (tester) async {
      box.info = {
        'protocol': 3,
        'hotspot': 'Harness-CD56',
        'locked': true,
        'wait': 0,
      };
      account.list = const [
        Machine(
          machineId: 'm-old',
          authMode: MachineAuthMode.remote,
          status: 'offline',
          name: 'Old box',
        ),
      ];
      await app.refreshMachines();
      await open(tester);
      await press(tester, 'intern-setup-start');
      await joinHotspot(tester);
      expect(
        find.text(
          'Harness-CD56 is locked. Enter Intern 3’s password, the one set when it was installed.',
        ),
        findsOneWidget,
      );

      // Empty, then wrong: said, and no Wi-Fi is asked for.
      await press(tester, 'intern-setup-unlock');
      expect(message(tester), 'Enter Intern 3’s password.');
      await tester.enterText(
        find.byKey(const Key('intern-setup-secret')),
        'nope',
      );
      await press(tester, 'intern-setup-unlock');
      expect(message(tester), 'Wrong password.');
      expect(box.checks, ['nope']);
      expect(box.unlocks, isEmpty);

      await tester.enterText(
        find.byKey(const Key('intern-setup-secret')),
        'open sesame',
      );
      await press(tester, 'intern-setup-unlock');
      expect(box.checks, ['nope', 'open sesame']);
      // Checked only: nothing opened yet.
      expect(box.unlocks, isEmpty);
      expect(find.text('Choose the Wi-Fi for Intern 3.'), findsOneWidget);
      // A locked one is not on a cable here.
      expect(find.byKey(const Key('intern-setup-cable')), findsNothing);

      await press(tester, 'intern-network:Home');
      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'hunter2222',
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('intern-setup-connect')),
          matching: find.text('Connect'),
        ),
        findsOneWidget,
      );
      await press(tester, 'intern-setup-connect');
      expect(message(tester), isNot('Unlocking…'));
      expect(box.unlocks, hasLength(1));
      expect(box.unlocks.single.password, 'open sesame');
      expect(box.unlocks.single.setup, {
        'ssid': 'Home',
        'password': 'hunter2222',
        'security': 'WPA2',
        'ticket': 'ticket-1',
        'account': 'user-1',
      });
      // No Wi-Fi handed over the setup page: it all went with the unlock.
      expect(box.connects, isEmpty);

      // It gave no computer id while locked: told apart as the one online now that was not then.
      account.list = const [
        Machine(
          machineId: 'm-old',
          authMode: MachineAuthMode.remote,
          status: 'offline',
          name: 'Old box',
        ),
        Machine(
          machineId: 'm-locked',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'Harness-CD56',
        ),
      ];
      await wait(tester, const Duration(seconds: 3));
      expect(
        find.text('Harness-CD56 is online. Give it a name.'),
        findsOneWidget,
      );
      await press(tester, 'intern-setup-done');
      // Its name kept as it is: nothing renamed.
      expect(account.renames, isEmpty);
      expect(find.text('Set up Intern 3'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'not online in time: joined again, the device says why, and the retry reuses its ticket on the hotspot',
    (tester) async {
      await open(tester);
      await joinUnlocked(tester);
      await sendHome(tester, 'wrongpass1');
      expect(box.connects.single['ticket'], 'ticket-1');

      // Its hotspot goes while it tries the Wi-Fi; it never shows in the account.
      box.info = null;
      for (var i = 0; i < 25; i++) {
        await wait(tester, const Duration(seconds: 3));
      }
      expect(
        message(tester),
        'Intern 3 did not come online on “Home”. Join “Harness-AB12” again to see why.',
      );

      // Still on its hotspot, with no Internet: no new ticket is needed for a Wi-Fi that failed.
      account.offline = true;
      await press(tester, 'intern-setup-again');
      expect(account.tickets, 1);
      expect(step(tester), 1);
      expect(
        find.text('If a try failed, Intern 3 says why once you join it.'),
        findsOneWidget,
      );
      box.info = {
        ...unlockedBox,
        'result': {
          'state': 'failed',
          'ssid': 'Home',
          'message': 'Wrong Wi-Fi password.',
        },
      };
      await joinHotspot(tester);
      expect(find.text('Choose the Wi-Fi for Intern 3.'), findsOneWidget);
      expect(message(tester), 'Wrong Wi-Fi password.');

      // The same Wi-Fi again: why, over the password being typed again.
      await press(tester, 'intern-network:Home');
      expect(message(tester), 'Wrong Wi-Fi password.');
      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'rightpass1',
      );
      await press(tester, 'intern-setup-connect');
      expect(box.connects.last, {
        'ssid': 'Home',
        'password': 'rightpass1',
        'ticket': 'ticket-1',
      });
      await press(tester, 'intern-setup-close');
      expect(find.text('Set up Intern 3'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'its sign-in failed after the Wi-Fi: that ticket may be spent, so the retry takes a new one',
    (tester) async {
      await open(tester);
      await joinUnlocked(tester);
      await sendHome(tester, 'hunter2222');
      box.info = null;
      for (var i = 0; i < 25; i++) {
        await wait(tester, const Duration(seconds: 3));
      }
      await press(tester, 'intern-setup-again');
      box.info = {
        ...unlockedBox,
        'result': {
          'state': 'done',
          'ssid': 'Home',
          'error': 'SIGN_IN',
          'message': 'The sign-in did not go through.',
        },
      };
      await joinHotspot(tester);
      expect(message(tester), 'The sign-in did not go through.');
      await press(tester, 'intern-network:Home');
      await tester.enterText(
        find.byKey(const Key('intern-setup-password')),
        'hunter2222',
      );
      // On the hotspot, no new ticket can be had: said, and nothing sent.
      account.offline = true;
      await press(tester, 'intern-setup-connect');
      for (var i = 0; i < 10; i++) {
        await wait(tester, const Duration(seconds: 3));
      }
      expect(
        message(tester),
        'This computer is not online. Switch it back to your Wi-Fi, then Retry.',
      );
      expect(box.connects, hasLength(1));
      app.dispose();
    },
  );

  testWidgets(
    'a locked Intern 3 (protocol 1) set up before: unlocked, it is back on its own Wi-Fi',
    (tester) async {
      box.info = {'protocol': 1, 'hotspot': 'Harness-AB12', 'locked': true};
      account.list = const [
        Machine(
          machineId: 'm-old',
          authMode: MachineAuthMode.remote,
          status: 'offline',
          name: 'Den box',
        ),
      ];
      await app.refreshMachines();
      await open(tester);
      await press(tester, 'intern-setup-start');
      await joinHotspot(tester);
      expect(
        find.text(
          'Harness-AB12 is locked. Enter Intern 3’s password to start it.',
        ),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const Key('intern-setup-secret')),
        'open sesame',
      );
      await press(tester, 'intern-setup-unlock');
      // Opened with the password alone: no check first, nothing else with it.
      expect(box.checks, isEmpty);
      expect(box.unlocks.single.setup, isNull);
      expect(
        find.textContaining('Unlocked. Intern 3 is starting'),
        findsOneWidget,
      );
      // Still the locked page for a moment: not taken for the started one.
      await wait(tester, const Duration(seconds: 2));
      expect(find.text('Choose the Wi-Fi for Intern 3.'), findsNothing);

      account.list = const [
        Machine(
          machineId: 'm-old',
          authMode: MachineAuthMode.remote,
          status: 'running',
          name: 'Den box',
        ),
      ];
      await wait(tester, const Duration(seconds: 3));
      expect(
        find.text(
          'Den box is unlocked and online on its own Wi-Fi. Nothing else to set up.',
        ),
        findsOneWidget,
      );
      await press(tester, 'intern-setup-done');
      expect(find.text('Set up Intern 3'), findsNothing);
      app.dispose();
    },
  );

  testWidgets(
    'an older Harness on this computer: Update, then Set up goes on by itself',
    (tester) async {
      String? version = '0.4.20';
      final runs = <List<String>>[];
      daemonVersionReader = (_, _) async => version;
      harnessUpdateRunner = (args) async {
        runs.add(args);
        version = '0.4.21';
        account.tooOld = false;
        return true;
      };
      addTearDown(() {
        daemonVersionReader = (_, _) async => null;
        harnessUpdateRunner = (_) async => false;
      });
      account.tooOld = true;
      await open(tester);
      await press(tester, 'intern-setup-start');
      // Nothing goes to the box: this computer's Harness cannot give the ticket yet.
      expect(account.tickets, 0);
      expect(
        find.text(
          'This computer runs Harness 0.4.20. Update it to set up Intern 3.',
        ),
        findsOneWidget,
      );
      expect(find.text('Retry'), findsOneWidget);

      await press(tester, 'update-harness-now');
      expect(runs, [
        ['update'],
      ]);
      // Updated: the ticket, then on to the box's hotspot.
      expect(account.tickets, 1);
      expect(
        find.text(
          'Join “Harness-…” in this computer’s Wi-Fi menu. Not there? Check Intern 3 is on.',
        ),
        findsOneWidget,
      );
      await press(tester, 'intern-setup-close');
      app.dispose();
    },
  );

  testWidgets(
    'no ticket while this computer is still on the hotspot: it says to switch back, and Retry goes on',
    (tester) async {
      account.offline = true;
      await open(tester);
      await press(tester, 'intern-setup-start');
      expect(
        message(tester),
        'This computer is not online. Switch it back to your Wi-Fi, then Retry.',
      );
      expect(step(tester), 0);
      account.offline = false;
      await press(tester, 'intern-setup-start');
      expect(account.tickets, 1);
      expect(step(tester), 1);
      await press(tester, 'intern-setup-close');
      app.dispose();
    },
  );

  testWidgets('on a cable: only signed in, with no Wi-Fi asked for', (
    tester,
  ) async {
    box.info = {...unlockedBox, 'online': true};
    await open(tester);
    await press(tester, 'intern-setup-start');
    await joinHotspot(tester);
    expect(box.connects, [
      {'ticket': 'ticket-1'},
    ]);
    expect(
      find.text(
        'Harness-AB12 is on a cable. It is signing in to your account.',
      ),
      findsOneWidget,
    );
    await press(tester, 'intern-setup-close');
    app.dispose();
  });
}
