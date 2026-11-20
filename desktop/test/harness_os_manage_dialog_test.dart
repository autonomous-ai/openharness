import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/harness_os/intern_manage_dialog.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/ws/ws_conn.dart';

/// An Intern 3's daemon: `status` answers [status]; every other action the next of its [replies],
/// the last one again once only it is left. Each answer a fresh map, as off the wire.
class _Intern extends WsConn {
  _Intern()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  Map<String, dynamic> status = _status();
  final replies = <String, List<Map<String, dynamic>>>{};
  final asked = <Map<String, dynamic>>[];

  List<Map<String, dynamic>> askedFor(String action) => [
    for (final ask in asked)
      if (ask['action'] == action) ask,
  ];

  static Map<String, dynamic> _copy(Map<String, dynamic> map) =>
      jsonDecode(jsonEncode(map)) as Map<String, dynamic>;

  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type != 'os_device') return const {};
    asked.add(Map.of(payload));
    final action = payload['action'];
    if (action == 'status') return _copy(status);
    final queue = replies[action];
    if (queue == null || queue.isEmpty) return {'error': 'FAILED'};
    return _copy(queue.length > 1 ? queue.removeAt(0) : queue.first);
  }
}

const _allFeatures = [
  'sign_out',
  'password',
  'ssh',
  'github',
  'check_update',
  'computer_use',
];

Map<String, dynamic> _update({
  String os = '0.1.8',
  String? osNext,
  String hn = '0.1.0',
  String? hnNext,
  String cli = '0.1.0',
  String? cliNext,
  bool checking = false,
}) => {
  'available': osNext != null || hnNext != null || cliNext != null,
  'checking': ?(checking ? true : null),
  'parts': {
    'os': {'running': os, 'available': osNext != null, 'next': osNext},
    'hn': {'running': hn, 'available': hnNext != null, 'next': hnNext},
    'cli': {'running': cli, 'available': cliNext != null, 'next': cliNext},
  },
};

Map<String, dynamic> _status({
  List<String> features = _allFeatures,
  Map<String, dynamic>? update,
  bool encrypted = false,
}) => {
  'harnessOs': true,
  'update': update ?? _update(),
  'wifi': {'ssid': 'Home'},
  'hotspot': 'Harness-AB12',
  'encrypted': encrypted,
  'features': features,
};

/// The account's machine list as the test sets it: Version asks it again while a restart is under
/// way, and the test says when the computer went down.
class _App extends AppNotifier {
  _App(_Intern intern)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (_) => intern,
      );

  int machineReads = 0;

  @override
  Future<bool> refreshMachines() async {
    machineReads++;
    return true;
  }
}

void main() {
  late _Intern intern;
  late _App app;
  late List<String> clipboard;
  var unlocked = 0;

  setUp(() {
    intern = _Intern();
    unlocked = 0;
    clipboard = [];
    app = _App(intern);
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Intern 3',
      status: 'running',
    );
    app.machines = [machine];
    app.machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
  });
  tearDown(() => app.dispose());

  /// The window, with a button that opens Manage on Intern 3, opened.
  Future<void> open(WidgetTester tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add((call.arguments as Map)['text'] as String);
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showInternManage(
                context,
                app,
                'm',
                onUnlock: () => unlocked++,
              ),
              child: const Text('Manage'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Manage'));
    await tester.pumpAndSettle();
  }

  Finder row(String key) => find.byKey(Key('intern-manage:$key'));
  Finder key(String key) => find.byKey(Key(key));

  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.tap(finder);
    await tester.pumpAndSettle();
  }

  Future<void> tick(WidgetTester tester, Duration every) async {
    await tester.pump(every);
    await tester.pumpAndSettle();
  }

  testWidgets('the list shows a row for each thing its status says it does', (
    tester,
  ) async {
    intern.status = _status(features: const ['password', 'sign_out']);
    await open(tester);
    expect(intern.askedFor('status'), hasLength(1));
    expect(find.text('Intern 3'), findsOneWidget);
    expect(row('version'), findsOneWidget);
    expect(
      find.descendant(of: row('version'), matching: find.text('Up to date')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row('wifi'), matching: find.text('Home')),
      findsOneWidget,
    );
    expect(row('password'), findsOneWidget);
    expect(row('sign-out'), findsOneWidget);
    for (final absent in ['ssh', 'github', 'computer-use']) {
      expect(row(absent), findsNothing, reason: absent);
    }
    await tap(tester, key('intern-close'));
    expect(row('version'), findsNothing);

    intern.status = _status(
      update: _update(hnNext: '0.2.0', cliNext: '0.2.0'),
    );
    await open(tester);
    for (final shown in ['ssh', 'github', 'computer-use']) {
      expect(row(shown), findsOneWidget, reason: shown);
    }
    expect(
      find.descendant(of: row('version'), matching: find.text('New version')),
      findsOneWidget,
    );
  });

  testWidgets('Version checks now, then updates hn and the CLI and says so', (
    tester,
  ) async {
    await open(tester);
    await tap(tester, row('version'));
    expect(find.text('0.1.8'), findsOneWidget);

    intern.replies['check_update'] = [
      {'started': true},
    ];
    intern.status = _status(update: _update(checking: true));
    await tap(tester, key('intern-version-check'));
    expect(find.text('Checking…'), findsOneWidget);
    await tick(tester, const Duration(seconds: 3));
    expect(find.text('Checking…'), findsOneWidget, reason: 'still checking');

    intern.status = _status(
      update: _update(hnNext: '0.2.0', cliNext: '0.2.0'),
    );
    await tick(tester, const Duration(seconds: 3));
    expect(find.text('A new version is ready.'), findsOneWidget);
    expect(find.text('0.1.0 → 0.2.0'), findsNWidgets(2));

    intern.replies['update'] = [
      {'started': true},
    ];
    await tap(tester, key('intern-version-update'));
    expect(intern.askedFor('update').single.containsKey('reboot'), isFalse);
    expect(
      find.text('Updating hn and the CLI… Its harnesses keep running.'),
      findsOneWidget,
    );
    expect(key('intern-version-keep-on'), findsOneWidget);

    intern.status = _status(
      update: _update(hn: '0.2.0', cli: '0.2.0'),
    );
    await tick(tester, const Duration(seconds: 5));
    expect(find.text('Updated: hn 0.2.0, CLI 0.2.0.'), findsOneWidget);
    expect(key('intern-version-keep-on'), findsNothing);

    await tap(tester, key('intern-back'));
    expect(row('version'), findsOneWidget);
  });

  testWidgets(
    'a new Harness OS asks first, restarts it, and offers Unlock once it waits for its password',
    (tester) async {
      intern.status = _status(
        update: _update(osNext: '0.1.9.r1.gabc-1'),
        encrypted: true,
      );
      await open(tester);
      await tap(tester, row('version'));
      intern.replies['update'] = [
        {'error': 'BUSY'},
        {'started': true},
      ];

      await tap(tester, key('intern-version-update'));
      expect(find.text('Update and restart Intern 3?'), findsOneWidget);
      expect(intern.askedFor('update'), isEmpty, reason: 'asked first');
      await tap(tester, key('intern-version-confirm'));
      expect(find.text('Intern 3 is already updating.'), findsOneWidget);

      await tap(tester, key('intern-version-update'));
      await tap(tester, key('intern-version-confirm'));
      expect(intern.askedFor('update').last['reboot'], isTrue);
      expect(
        find.text('Updating Harness OS… Intern 3 restarts once it is in.'),
        findsOneWidget,
      );

      // Down for its restart.
      app.machineStates['m']!.nodeOnline = false;
      await tick(tester, const Duration(seconds: 5));
      expect(app.machineReads, 1, reason: 'the account asked afresh');
      expect(find.textContaining('is restarting'), findsOneWidget);
      await tick(tester, const Duration(seconds: 20));
      expect(
        find.text(
          'Intern 3 updated and restarted. It waits for its password on "Harness-AB12".',
        ),
        findsOneWidget,
      );
      await tap(tester, key('intern-version-unlock'));
      expect(unlocked, 1);
      expect(row('version'), findsNothing, reason: 'the dialog closed');
    },
  );

  testWidgets('Wi-Fi moves it to another network and says it is there', (
    tester,
  ) async {
    intern.replies['wifi_scan'] = [
      {
        'networks': [
          {'ssid': 'Home', 'signal': 80, 'security': 'WPA2', 'active': true},
          {'ssid': 'Office', 'signal': 60, 'security': 'WPA2', 'active': false},
        ],
      },
    ];
    intern.replies['wifi_result'] = [
      {
        'result': {'run': 3, 'state': 'done'},
      },
      {
        'result': {'run': 3, 'state': 'done'},
      },
      {
        'result': {'run': 4, 'state': 'connecting'},
      },
      {
        'result': {'run': 4, 'state': 'done'},
      },
    ];
    intern.replies['wifi_join'] = [
      {'started': true},
    ];
    await open(tester);
    await tap(tester, row('wifi'));
    expect(intern.askedFor('wifi_scan'), hasLength(1));
    expect(
      find.descendant(
        of: key('intern-network:Home'),
        matching: find.text('Current'),
      ),
      findsOneWidget,
    );

    await tap(tester, key('intern-network:Office'));
    await tester.enterText(key('intern-wifi-password'), 'short');
    await tap(tester, key('intern-wifi-connect'));
    expect(
      find.text('A Wi-Fi password has 8 to 63 characters.'),
      findsOneWidget,
    );
    expect(intern.askedFor('wifi_join'), isEmpty);

    await tester.enterText(key('intern-wifi-password'), 'longpassword');
    await tap(tester, key('intern-wifi-connect'));
    expect(intern.askedFor('wifi_join').single, {
      'action': 'wifi_join',
      'ssid': 'Office',
      'password': 'longpassword',
    });
    expect(
      find.text(
        'Intern 3 is moving to "Office". It is out of reach for a moment.',
      ),
      findsOneWidget,
    );
    // The run before this one, then this one connecting: still moving.
    await tick(tester, const Duration(seconds: 3));
    await tick(tester, const Duration(seconds: 3));
    expect(find.textContaining('is moving to'), findsOneWidget);
    await tick(tester, const Duration(seconds: 3));
    expect(find.text('Intern 3 is on "Office" now.'), findsOneWidget);

    await tap(tester, key('intern-wifi-done'));
    expect(row('wifi'), findsOneWidget);
  });

  testWidgets('Password refuses new ones that differ, then changes it', (
    tester,
  ) async {
    intern.replies['password'] = [
      {'ok': true, 'disk': true},
    ];
    await open(tester);
    await tap(tester, row('password'));
    await tester.enterText(key('intern-password-current'), 'old-one');
    await tester.enterText(key('intern-password-new'), 'new-one');
    await tester.enterText(key('intern-password-repeat'), 'new-two');
    await tap(tester, key('intern-password-change'));
    expect(find.text('The new passwords are not the same.'), findsOneWidget);
    expect(intern.askedFor('password'), isEmpty);

    await tester.enterText(key('intern-password-repeat'), 'new-one');
    await tap(tester, key('intern-password-change'));
    expect(intern.askedFor('password').single, {
      'action': 'password',
      'current': 'old-one',
      'next': 'new-one',
    });
    expect(find.textContaining('unlocks Intern 3\'s disk too'), findsOneWidget);
    await tap(tester, key('intern-password-done'));
    expect(row('password'), findsOneWidget);
  });

  testWidgets('SSH turns on, and a click copies the command for an address', (
    tester,
  ) async {
    Map<String, dynamic> ssh(bool on) => {
      'enabled': on,
      'user': 'me',
      'addresses': [
        {'address': '192.168.1.5', 'interface': 'wlan0'},
      ],
    };
    intern.replies['ssh'] = [ssh(false), ssh(true)];
    await open(tester);
    await tap(tester, row('ssh'));
    expect(intern.askedFor('ssh').single['state'], 'status');
    expect(tester.widget<Switch>(key('intern-ssh-switch')).value, isFalse);

    await tap(tester, key('intern-ssh-switch'));
    expect(intern.askedFor('ssh').last['state'], 'on');
    expect(tester.widget<Switch>(key('intern-ssh-switch')).value, isTrue);

    await tap(tester, key('intern-ssh-address:192.168.1.5'));
    expect(clipboard, ['ssh me@192.168.1.5']);
    expect(find.text('Copied.'), findsOneWidget);
  });

  testWidgets('GitHub signs in with a code opened on GitHub, and signs out', (
    tester,
  ) async {
    final opened = <Uri>[];
    final opener = browserOpener;
    browserOpener = (url) async {
      opened.add(url);
      return true;
    };
    addTearDown(() => browserOpener = opener);
    intern.replies['github'] = [
      {'login': null},
      {
        'login': null,
        'signingIn': {
          'code': 'AB12-CD34',
          'url': 'https://github.com/login/device',
        },
      },
      {'login': 'octo'},
      {'login': null},
    ];
    await open(tester);
    await tap(tester, row('github'));
    await tap(tester, key('intern-github-sign-in'));
    expect(intern.askedFor('github').last['state'], 'sign_in');
    expect(find.text('AB12-CD34'), findsOneWidget);

    await tap(tester, key('intern-github-open'));
    expect(clipboard, ['AB12-CD34']);
    expect(opened, [Uri.parse('https://github.com/login/device')]);

    // The code entered on GitHub: the next look finds it signed in.
    await tick(tester, const Duration(seconds: 3));
    expect(
      find.text(
        'Agents on Intern 3 clone, push and open pull requests as @octo.',
      ),
      findsOneWidget,
    );

    await tap(tester, key('intern-github-sign-out'));
    expect(find.text('Sign Intern 3 out of GitHub?'), findsOneWidget);
    await tap(tester, key('intern-github-confirm'));
    expect(intern.askedFor('github').last['state'], 'sign_out');
    expect(key('intern-github-sign-in'), findsOneWidget);
  });

  testWidgets('Computer use turns on and says running agents need a restart', (
    tester,
  ) async {
    intern.replies['computer_use'] = [
      {'on': false},
      {'on': true},
    ];
    await open(tester);
    await tap(tester, row('computer-use'));
    expect(
      intern.askedFor('computer_use').single.containsKey('state'),
      isFalse,
    );
    await tap(tester, key('intern-computer-use-switch'));
    expect(intern.askedFor('computer_use').last['state'], 'on');
    expect(
      find.text(
        'New harnesses get them. Restart a running one to give it them.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('Sign out asks first, signs it out and forgets it', (
    tester,
  ) async {
    intern.replies['sign_out'] = [
      {'started': true},
    ];
    await open(tester);
    await tap(tester, row('sign-out'));
    expect(find.text('Sign out Intern 3?'), findsOneWidget);
    expect(intern.askedFor('sign_out'), isEmpty);

    await tap(tester, key('intern-sign-out-confirm'));
    expect(intern.askedFor('sign_out'), hasLength(1));
    expect(app.harnessOs.status['m'], isNull);
    expect(app.harnessOs.computers['m'], isNull);
    expect(find.text('Sign out Intern 3?'), findsNothing, reason: 'closed');
  });
}
