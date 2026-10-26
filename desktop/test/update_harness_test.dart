import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/agent_messages/update_harness.dart';
import 'package:harness/ws/local_daemon_transport.dart';

import 'swarm_state_test.dart' show createApp;

void main() {
  late List<String?> versions;
  late List<List<String>> ran;
  var runOk = true;
  var confirmed = true;
  var confirmAsked = 0;

  Future<void> mount(
    WidgetTester tester, {
    required String? first,
    bool canUpdate = true,
  }) async {
    final app = createApp();
    addTearDown(app.dispose);
    versions = [first];
    ran = [];
    runOk = true;
    confirmed = true;
    confirmAsked = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UpdateHarnessLine(
            app,
            readVersion: (_) async =>
                versions.length > 1 ? versions.removeAt(0) : versions.first,
            runUpdate: (args) async {
              ran.add(args);
              return runOk;
            },
            confirm: (_) async {
              confirmAsked++;
              return confirmed;
            },
            canUpdate: canUpdate,
            pollEvery: const Duration(milliseconds: 10),
            pollLimit: 3,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('names the version and the one shared tabs need, with Update now', (
    tester,
  ) async {
    await mount(tester, first: '0.4.10');
    expect(
      find.text(
        'This computer runs Harness 0.4.10; shared tabs need $kAgentMessagesMinimumCli or newer.',
      ),
      findsOneWidget,
    );
    expect(kAgentMessagesMinimumCli, '0.4.15');
    expect(find.text('Update now'), findsOneWidget);
  });

  testWidgets(
    'a daemon that does not answer keeps the plain line, without a button',
    (tester) async {
      await mount(tester, first: null);
      expect(
        find.text('Update Harness on this computer to share tabs.'),
        findsOneWidget,
      );
      expect(find.text('Update now'), findsNothing);
    },
  );

  testWidgets('the web shows the line without the button', (tester) async {
    await mount(tester, first: '0.4.10', canUpdate: false);
    expect(
      find.textContaining('This computer runs Harness 0.4.10'),
      findsOneWidget,
    );
    expect(find.text('Update now'), findsNothing);
  });

  testWidgets(
    'Update now runs harness update until the daemon answers with a newer version',
    (tester) async {
      await mount(tester, first: '0.4.10');
      versions = ['0.4.10', '0.4.15'];
      await tester.tap(find.text('Update now'));
      await tester.pump();
      expect(find.text('Updating…'), findsOneWidget);
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
      expect(ran, [
        ['update'],
      ]);
      expect(confirmAsked, 0);
      expect(find.text('Updating…'), findsNothing);
      expect(find.byKey(const ValueKey('update-harness-failed')), findsNothing);
    },
  );

  testWidgets('a failed run says what to do', (tester) async {
    await mount(tester, first: '0.4.10');
    runOk = false;
    await tester.tap(find.text('Update now'));
    await tester.pumpAndSettle();
    expect(
      find.text("The update didn't finish. Run harness update in a terminal."),
      findsOneWidget,
    );
    expect(find.text('Update now'), findsOneWidget);
  });

  testWidgets('a daemon that never shows a newer version is a failed update', (
    tester,
  ) async {
    await mount(tester, first: '0.4.10');
    await tester.tap(find.text('Update now'));
    await tester.pumpAndSettle(const Duration(milliseconds: 50));
    expect(find.byKey(const ValueKey('update-harness-failed')), findsOneWidget);
  });

  testWidgets(
    'a development build: its own wording, and --force only after the confirmation',
    (tester) async {
      await mount(tester, first: '0.4.10-dev.0515a030a');
      expect(
        find.text(
          "This computer runs a development build of Harness (0.4.10-dev.0515a030a), which doesn't update itself.",
        ),
        findsOneWidget,
      );
      confirmed = false;
      await tester.tap(find.text('Update now'));
      await tester.pumpAndSettle();
      expect(confirmAsked, 1);
      expect(ran, isEmpty);
      confirmed = true;
      versions = ['0.4.10-dev.0515a030a', '0.4.15'];
      await tester.tap(find.text('Update now'));
      await tester.pumpAndSettle(const Duration(milliseconds: 50));
      expect(ran, [
        ['update', '--force'],
      ]);
    },
  );

  testWidgets(
    'the default confirmation says it replaces the development build',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final asked = <List<String>>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: UpdateHarnessLine(
              app,
              readVersion: (_) async => '0.4.10-dev.abc',
              runUpdate: (a) async {
                asked.add(a);
                return false;
              },
              canUpdate: true,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Update now'));
      await tester.pumpAndSettle();
      expect(
        find.text(
          'This replaces the development build on this computer with the latest release.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('update-harness-cancel')));
      await tester.pumpAndSettle();
      expect(asked, isEmpty);
      await tester.tap(find.text('Update now'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('update-harness-confirm')));
      await tester.pumpAndSettle();
      expect(asked, [
        ['update', '--force'],
      ]);
    },
  );

  group('whose computer is too old (P3)', () {
    test('Desktop: this computer, word for word', () {
      expect(
        harnessTooOldLine(null, viewer: false),
        'Update Harness on this computer to share tabs.',
      );
      expect(
        harnessTooOldLine('0.4.0-dev.3', viewer: false),
        "This computer runs a development build of Harness (0.4.0-dev.3), which doesn't update itself.",
      );
      expect(
        harnessTooOldLine('0.4.1', viewer: false),
        'This computer runs Harness 0.4.1; shared tabs need $kAgentMessagesMinimumCli or newer.',
      );
    });

    test('a browser runs no Harness of its own: your computer', () {
      expect(
        harnessTooOldLine(null, viewer: true),
        'Update Harness on your computer to share tabs.',
      );
      expect(
        harnessTooOldLine('0.4.0-dev.3', viewer: true),
        "Your computer runs a development build of Harness (0.4.0-dev.3), which doesn't update itself.",
      );
      expect(
        harnessTooOldLine('0.4.1', viewer: true),
        'Your computer runs Harness 0.4.1; shared tabs need $kAgentMessagesMinimumCli or newer.',
      );
    });
  });

  group('the version is read the way the app reaches its daemon', () {
    // Port 9 (discard) is never the daemon: a read that does not go over the socket cannot answer.
    final base = Uri.parse('http://127.0.0.1:9');

    Future<(HttpServer, String)> serve(String version) async {
      final dir = await Directory.systemTemp.createTemp('hv');
      addTearDown(() => dir.delete(recursive: true));
      final path = '${dir.path}/d.sock';
      final server = await HttpServer.bind(
        InternetAddress(path, type: InternetAddressType.unix),
        0,
      );
      server.listen((r) {
        r.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'version': version}))
          ..close();
      });
      addTearDown(() => server.close(force: true));
      return (server, path);
    }

    test('over the Unix socket when the transport uses it', () async {
      final (_, path) = await serve('0.4.20');
      final transport = LocalDaemonTransport(candidate: path)..useSocket();
      expect(await readDaemonVersion(base, transport), '0.4.20');
    });

    test('over the loopback port without a socket', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((r) {
        r.response
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({'version': '0.4.9'}))
          ..close();
      });
      final tcp = Uri.parse('http://127.0.0.1:${server.port}');
      expect(await readDaemonVersion(tcp, LocalDaemonTransport()), '0.4.9');
      expect(await readDaemonVersion(tcp), '0.4.9');
    });

    testWidgets('the line hands its app\'s transport to the default reader', (
      tester,
    ) async {
      final app = createApp();
      addTearDown(app.dispose);
      final old = daemonVersionReader;
      addTearDown(() => daemonVersionReader = old);
      final seen = <LocalDaemonTransport?>[];
      daemonVersionReader = (_, transport) async {
        seen.add(transport);
        return '0.4.20';
      };
      await tester.pumpWidget(
        MaterialApp(home: Scaffold(body: UpdateHarnessLine(app))),
      );
      await tester.pump();
      expect(seen, [same(app.localDaemonTransport)]);
    });
  });
}
