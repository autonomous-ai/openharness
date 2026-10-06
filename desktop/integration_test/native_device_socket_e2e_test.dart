// Companion: cli/scripts/pro-device-native-peer.ts --output <new-directory>
// FLUTTER_TEST=1 flutter test -d macos --no-pub --no-enable-impeller
// integration_test/native_device_socket_e2e_test.dart
// --dart-define=PRO_DEVICE_FIXTURE_URL=http://127.0.0.1:<port>
// --dart-define=PRO_DEVICE_FIXTURE_OUTPUT=<same-directory>
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/ws/local_cli_discovery.dart';
import 'package:harness/ws/local_daemon_transport.dart';
import 'package:xterm/xterm.dart';

class _FixtureLogin extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

class _FixtureEnvironment extends EnvironmentProvisioner {
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) async => EnvironmentReadiness(
    steps: {
      for (final step in EnvironmentStep.values)
        step: EnvironmentStepStatus.ready,
    },
    phase: EnvironmentSetupPhase.ready,
  );
}

// Only boot discovery is supplied by the fixture. WsPool, WsConn, binary
// dispatch, app focus and device-selection replies are the production path.
class _FixtureApp extends AppNotifier {
  final String endpoint;
  _FixtureApp(this.endpoint, String output)
    : super(
        config: AppConfig(apiBaseUrl: endpoint, localCliBaseUrl: endpoint),
        authSession: AuthSession(),
        configStore: null,
        cliLogin: _FixtureLogin(),
        environmentProvisioner: _FixtureEnvironment(),
        localCliDiscovery: LocalCliDiscovery(
          config: AppConfig(apiBaseUrl: endpoint, localCliBaseUrl: endpoint),
          transport: LocalDaemonTransport(),
          identity: LocalMachineIdentity(
            computerIdFile: File('$output/computer-id'),
            environment: const {
              'ADAPTER_COMPUTER_ID': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ),
          spawnCommand: () async =>
              throw StateError('No daemon launch in this fixture'),
          stopCommand: () async =>
              throw StateError('No daemon stop in this fixture'),
        ),
      );

  @override
  Future<void> ensureCliDaemonReady() async {}

  @override
  Future<bool> refreshMachines() async {
    if (machineStates.containsKey('m')) return true;
    const machine = Machine(
      machineId: 'm',
      authMode: MachineAuthMode.remote,
      name: 'Private native fixture',
    );
    machines = [machine];
    machineStates['m'] = MachineState(machine)
      ..nodeOnline = true
      ..localEndpoint = LocalCliEndpoint(
        computerId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        machineId: 'm',
        wsUri: Uri.parse(
          '${endpoint.replaceFirst('http:', 'ws:')}/api/local-ws',
        ),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
        backendOnline: false,
      );
    return true;
  }
}

/// Actual native renderer, app dispatcher, local socket and tmux streams.
/// The peer uses synthetic line emitters, question/result metadata and scripted
/// transcripts. Reviewed Carry dispatch ends in owned memory, never terminal input.
void main() {
  const endpoint = String.fromEnvironment('PRO_DEVICE_FIXTURE_URL');
  const output = String.fromEnvironment('PRO_DEVICE_FIXTURE_OUTPUT');
  if (!kUnderTest ||
      !endpoint.startsWith('http://127.0.0.1:') ||
      output.isEmpty) {
    throw StateError('Requires test mode and the private device fixture');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'selection, questions, result words, Carry and spoken Find cross the native app socket',
    (tester) async {
      final http = HttpClient();
      addTearDown(() => http.close(force: true));
      Future<Map<String, dynamic>> request(
        String path, [
        Map<String, dynamic>? payload,
      ]) async {
        final req = await http.openUrl(
          payload == null ? 'GET' : 'POST',
          Uri.parse('$endpoint$path'),
        );
        if (payload != null) {
          req.headers.contentType = ContentType.json;
          req.write(jsonEncode(payload));
        }
        final response = await req.close().timeout(const Duration(seconds: 20));
        final body = jsonDecode(
          await utf8.decoder.bind(response).join(),
        ) as Map<String, dynamic>;
        expect(response.statusCode, 200, reason: '$body');
        return body;
      }

      Future<void> until(bool Function() condition, String description) async {
        final watch = Stopwatch()..start();
        while (!condition() && watch.elapsed < const Duration(seconds: 20)) {
          await tester.pump(const Duration(milliseconds: 50));
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        await tester.pump();
        expect(condition(), isTrue, reason: description);
      }

      final fixture = await request('/fixture');
      final agents = fixture['agents'] as List;
      final first = agents[0] as Map;
      final second = agents[1] as Map;
      final capture = GlobalKey();
      final app = _FixtureApp(endpoint, output);
      addTearDown(app.dispose);
      await app.bootstrap();
      expect(app.status, AppStatus.authenticated);
      app.toggleExpand('m');
      await until(
        () =>
            app.stateOf('m')!.agents.length == 2 &&
            app.stateOf('m')!.connectionStatus == ConnectionStatus.connected,
        'production app pool connects and loads the isolated registry',
      );
      await app.addAgentToSwarm('m', first['agentId'] as String);
      await app.addAgentToSwarm('m', second['agentId'] as String);
      final origin = app.allPanes.firstWhere(
        (pane) => pane.agentId == first['agentId'],
      );
      final other = app.allPanes.firstWhere(
        (pane) => pane.agentId == second['agentId'],
      );
      app.focusPane(origin.id);
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: RepaintBoundary(
            key: capture,
            child: SwarmScreen(
              notifier: app,
              nativeTabs: false,
              projectStore: SwarmProjectStore(),
            ),
          ),
        ),
      );
      await until(
        () =>
            origin.session?.terminal.buffer.getText().contains(
              first['marker'] as String,
            ) ==
            true,
        'actual private tmux output reaches the native renderer',
      );
      final terminal = origin.session!.terminal;
      final finder = find.byWidgetPredicate(
        (widget) => widget is TerminalView && widget.terminal == terminal,
      );
      final renderer = tester.state(finder);
      final before = await request('/evidence');
      expect((before['focus'] as Map)['agentId'], first['agentId']);
      var state = await request('/selection', {
        'op': 'begin',
        'agentId': first['agentId'],
      });
      expect(state['ok'], isTrue, reason: '$state');
      expect(state['excerpt'], contains(first['marker']));
      state = await request('/selection', {
        'op': 'extend',
        'extend': true,
        'agentId': first['agentId'],
        'selectionId': state['selectionId'],
        'revision': state['revision'],
      });
      expect(state['ok'], isTrue);
      state = await request('/selection', {
        'op': 'step',
        'delta': -2,
        'agentId': first['agentId'],
        'selectionId': state['selectionId'],
        'revision': state['revision'],
      });
      expect(state['ok'], isTrue);
      expect(state['rows'], 3);
      await tester.pump();
      expect(
        tester.widget<TerminalView>(finder).controller!.highlights,
        isNotEmpty,
      );
      final boundary =
          capture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$output/native-selection.png')
          .writeAsBytes(png!.buffer.asUint8List());
      image.dispose();
      app.focusPane(other.id);
      await tester.pump();
      // Let the exact focus frame precede the stale cable operation.
      await until(() => app.focusedPane == other, 'the second pane has focus');
      final changed = await request('/evidence');
      expect((changed['focus'] as Map)['agentId'], second['agentId']);
      final stale = await request('/selection', {
        'op': 'step',
        'delta': 1,
        'agentId': first['agentId'],
        'selectionId': state['selectionId'],
        'revision': state['revision'],
      });
      expect(stale['ok'], isFalse);
      expect(stale['error'], 'Select that pane in Harness first.');
      await tester.pump();
      expect(tester.state(finder), same(renderer));
      expect(origin.session!.terminal, same(terminal));
      expect(
        tester.widget<TerminalView>(finder).controller!.highlights,
        isEmpty,
      );
      final after = await request('/evidence');
      expect(after['inputFrames'], before['inputFrames']);
      expect(after['inputFrames'], 0);
      expect(after['resizeFrames'], before['resizeFrames']);

      // Reading a question is a notice receipt, not an answer. Keep working in
      // the second pane while the first asks, including the delayed device ACK
      // that can arrive after the person has chosen Later on the device.
      final workFinder = find.byWidgetPredicate(
        (widget) =>
            widget is TerminalView &&
            widget.terminal == other.session!.terminal,
      );
      final workRenderer = tester.state(workFinder);
      final workScroll = tester
          .widget<TerminalView>(workFinder)
          .scrollController!;
      workScroll.jumpTo(workScroll.position.maxScrollExtent / 2);
      await tester.pump();
      final readingOffset = workScroll.offset;
      final workTab = app.activeSwarmId;
      final questionAgent = first['agentId'] as String;
      const questionOne = 'fixture-question-one';
      const questionTwo = 'fixture-question-two';
      await request('/question', {
        'op': 'open',
        'agentId': questionAgent,
        'requestId': questionOne,
      });
      await until(
        () => app.questionFor('m', questionAgent)?.requestId == questionOne,
        'the real socket makes the synthetic question pending in the app',
      );
      final pendingQuestion = app.questionFor('m', questionAgent);
      final unreadToken = app.agentUnread.readTokenFor('m', questionAgent);
      expect(unreadToken, isNotNull);
      final read = await request('/question', {
        'op': 'read',
        'agentId': questionAgent,
      });
      expect((read['question'] as Map)['id'], questionOne);
      expect(read['readToken'], unreadToken);
      await until(
        () =>
            app.questionNotificationRead('m', questionAgent) &&
            app.agentUnread.readTokenFor('m', questionAgent) == null,
        'device read clears only the exact unread mark',
      );
      expect(app.questionFor('m', questionAgent), same(pendingQuestion));
      var attention = await request('/evidence');
      expect((attention['pendingSeen'] as List), hasLength(1));
      expect(
        (attention['cableFrames'] as List).where(
          (frame) =>
              frame['t'] == 'notif.replace' && (frame['items'] as List).isEmpty,
        ),
        isNotEmpty,
      );
      expect(
        (attention['cableFrames'] as List).where(
          (frame) =>
              frame['t'] == 'question.close' && frame['id'] == questionOne,
        ),
        isEmpty,
      );
      await request('/question', {
        'op': 'release-seen',
        'agentId': questionAgent,
      });
      await tester.pump();
      attention = await request('/evidence');
      expect(
        (attention['cableFrames'] as List).where(
          (frame) =>
              frame['t'] == 'notif.seen' &&
              frame['agentId'] == questionAgent &&
              frame['readToken'] == unreadToken,
        ),
        hasLength(1),
      );
      expect(app.questionFor('m', questionAgent), same(pendingQuestion));
      expect(app.focusedPane, same(other));
      expect(app.activeSwarmId, workTab);
      expect(tester.state(workFinder), same(workRenderer));
      expect(workScroll.offset, closeTo(readingOffset, .01));
      expect((attention['focus'] as Map)['agentId'], second['agentId']);
      expect(attention['inputFrames'], 0);
      expect(attention['answerAttempts'], 0);

      await request('/question', {
        'op': 'close',
        'agentId': questionAgent,
        'requestId': questionOne,
      });
      await until(
        () => app.questionFor('m', questionAgent) == null,
        'only the exact authoritative close ends the pending question',
      );
      await request('/question', {
        'op': 'open',
        'agentId': questionAgent,
        'requestId': questionTwo,
      });
      await until(
        () => app.questionFor('m', questionAgent)?.requestId == questionTwo,
        'a later occurrence becomes a new pending question',
      );
      final newToken = app.agentUnread.readTokenFor('m', questionAgent);
      expect(newToken, isNotNull);
      expect(newToken, isNot(unreadToken));
      final staleClose = await request('/question', {
        'op': 'close',
        'agentId': questionAgent,
        'requestId': questionOne,
      });
      expect(staleClose['currentRequestId'], questionTwo);
      await tester.pump();
      expect(app.questionFor('m', questionAgent)?.requestId, questionTwo);
      expect(app.agentUnread.readTokenFor('m', questionAgent), newToken);
      await request('/question', {
        'op': 'close',
        'agentId': questionAgent,
        'requestId': questionTwo,
      });
      await until(
        () => app.questionFor('m', questionAgent) == null,
        'the new occurrence also closes only by its own identity',
      );
      attention = await request('/evidence');
      expect(app.focusedPane, same(other));
      expect(app.activeSwarmId, workTab);
      expect(tester.state(workFinder), same(workRenderer));
      expect(workScroll.offset, closeTo(readingOffset, .01));
      expect(attention['inputFrames'], 0);
      expect(attention['answerAttempts'], 0);

      // A result belongs to its unread occurrence, not the mutable latest recap
      // for that agent. Keep the other pane visible while the first completes.
      // This uses the actual workspace visibility rule, not a replaced unread
      // or connection implementation.
      app.lifecycle = () => AppLifecycleState.resumed;
      app.toggleZoomPane();
      await tester.pump(const Duration(milliseconds: 250));
      await Future<void>.delayed(const Duration(milliseconds: 250));
      await tester.pump();
      expect(app.zoomedPaneId, other.id);
      expect(app.visibleOnTabForTest().map((pane) => pane.agentId), [
        second['agentId'],
      ]);
      final resultRenderer = tester.state(workFinder);
      final resultSession = other.session!;
      final resultTerminal = resultSession.terminal;
      final resultScroll = tester
          .widget<TerminalView>(workFinder)
          .scrollController!;
      resultScroll.jumpTo(resultScroll.position.maxScrollExtent / 2);
      await tester.pump();
      final resultOffset = resultScroll.offset;
      final resultText = resultTerminal.buffer.getText();
      final resultBefore = await request('/evidence');
      void readingUnchanged(
        Map<String, dynamic> evidence, {
        bool reconnected = false,
      }) {
        expect(app.focusedPane, same(other));
        expect(app.activeSwarmId, workTab);
        expect(app.zoomedPaneId, other.id);
        expect(tester.state(workFinder), same(resultRenderer));
        expect(other.session, same(resultSession));
        // A reconnect keyframe atomically replaces the Terminal model. Its
        // owning session, renderer and visible reading position still survive.
        if (!reconnected) {
          expect(other.session!.terminal, same(resultTerminal));
        }
        final liveScroll = tester
            .widget<TerminalView>(workFinder)
            .scrollController!;
        expect(liveScroll, same(resultScroll));
        expect(liveScroll.offset, closeTo(resultOffset, .01));
        expect(other.session!.terminal.buffer.getText(), resultText);
        expect((evidence['focus'] as Map)['agentId'], second['agentId']);
        expect(evidence['inputFrames'], 0);
        expect(evidence['answerAttempts'], 0);
      }

      const firstWords = 'Alpha approved.';
      const secondWords = 'Beta approved.';
      final resultOne = await request('/result', {
        'op': 'publish',
        'agentId': questionAgent,
        'result': 'first',
      });
      final firstToken = (resultOne['item'] as Map)['readToken'];
      expect(firstToken, isA<String>());
      expect(
        (resultOne['payload'] as Map).keys,
        unorderedEquals(['summary', 'sessionId', 'notification']),
      );
      expect(app.agentUnread.messageFor('m', questionAgent), firstWords);
      expect((resultOne['item'] as Map)['text'], firstWords);
      expect((resultOne['cableItem'] as Map)['summary'], firstWords);
      expect((resultOne['cableItem'] as Map)['readToken'], firstToken);
      await request('/result', {
        'op': 'duplicate',
        'agentId': questionAgent,
        'result': 'first',
      });
      await tester.pump(const Duration(milliseconds: 100));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(app.agentUnread.readTokenFor('m', questionAgent), firstToken);
      expect(app.agentUnread.messageFor('m', questionAgent), firstWords);
      final restoredOne = await request('/result', {
        'op': 'restore',
        'agentId': questionAgent,
      });
      expect((restoredOne['cableItem'] as Map)['summary'], firstWords);
      expect((restoredOne['cableItem'] as Map)['readToken'], firstToken);
      await request('/result', {
        'op': 'read',
        'agentId': questionAgent,
        'readToken': firstToken,
      });
      expect(app.agentUnread.readTokenFor('m', questionAgent), isNull);
      final resultTwo = await request('/result', {
        'op': 'publish',
        'agentId': questionAgent,
        'result': 'second',
      });
      final secondToken = (resultTwo['item'] as Map)['readToken'];
      expect(secondToken, isA<String>());
      expect(secondToken, isNot(firstToken));
      expect(
        ((resultTwo['payload'] as Map)['notification'] as Map)['id'],
        isNot(((resultOne['payload'] as Map)['notification'] as Map)['id']),
      );
      expect(app.agentUnread.messageFor('m', questionAgent), secondWords);
      expect((resultTwo['cableItem'] as Map)['summary'], secondWords);
      final oldReceipt = await request('/result', {
        'op': 'release-seen',
        'agentId': questionAgent,
        'readToken': firstToken,
      });
      expect((oldReceipt['current'] as Map)['readToken'], secondToken);
      await request('/result', {
        'op': 'stale-read',
        'agentId': questionAgent,
        'readToken': firstToken,
      });
      await tester.pump(const Duration(milliseconds: 100));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(app.agentUnread.readTokenFor('m', questionAgent), secondToken);
      expect(app.agentUnread.messageFor('m', questionAgent), secondWords);
      final afterResults = await request('/evidence');
      readingUnchanged(afterResults);
      expect(afterResults['resizeFrames'], resultBefore['resizeFrames']);

      final priorStream = other.session!.streamId;
      final reconnected = await request('/result', {
        'op': 'reconnect',
        'agentId': questionAgent,
      });
      await until(
        () =>
            app.stateOf('m')!.connectionStatus == ConnectionStatus.connected &&
            other.session!.streamId != priorStream &&
            other.session!.acceptsInput,
        'real pool reconnect republishes unread and restores its terminal stream',
      );
      expect(reconnected['connection'], isNot(reconnected['oldConnection']));
      expect((reconnected['item'] as Map)['readToken'], secondToken);
      expect((reconnected['item'] as Map)['text'], secondWords);
      expect((reconnected['cableItem'] as Map)['summary'], secondWords);
      expect((reconnected['cableItem'] as Map)['readToken'], secondToken);
      expect(app.agentUnread.readTokenFor('m', questionAgent), secondToken);
      expect(app.agentUnread.messageFor('m', questionAgent), secondWords);
      attention = await request('/evidence');
      readingUnchanged(attention, reconnected: true);
      final unreadEvents = attention['appUnreadEvents'] as List;
      for (final occurrence in [
        (token: firstToken, words: firstWords),
        (token: secondToken, words: secondWords),
      ]) {
        expect(
          unreadEvents
              .expand((event) => event['items'] as List)
              .where(
                (item) =>
                    item['agentId'] == questionAgent &&
                    item['readToken'] == occurrence.token &&
                    item['text'] == occurrence.words,
              ),
          isNotEmpty,
        );
      }
      final resultImage = await boundary.toImage(pixelRatio: 1);
      final resultPng = await resultImage.toByteData(
        format: ui.ImageByteFormat.png,
      );
      await File('$output/native-result-reading.png')
          .writeAsBytes(resultPng!.buffer.asUint8List());
      resultImage.dispose();

      // A Summary keeps the exact payload it received. Looking at its pane can
      // legitimately clear the app's unread mark; that must not replace these
      // saved words or turn Latest into a historical-result-position claim.
      final retained = await request('/visit', {
        'op': 'retain-summary',
        'agentId': questionAgent,
        'readToken': secondToken,
      });
      final retainedSummary = retained['summary'] as Map;
      expect(retainedSummary['summary'], secondWords);
      expect(retainedSummary['readToken'], secondToken);
      final latestVisitId = retained['visitId'] as String;
      expect(latestVisitId, matches(RegExp(r'^visit-[0-9a-f]{16}$')));

      Future<Map<String, dynamic>> focusEvidence(String agentId) async {
        final watch = Stopwatch()..start();
        Map<String, dynamic> evidence = {};
        while (watch.elapsed < const Duration(seconds: 20)) {
          await tester.pump(const Duration(milliseconds: 50));
          evidence = await request('/evidence');
          if ((evidence['focus'] as Map?)?['agentId'] == agentId) {
            return evidence;
          }
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
        fail(
          'The actual app socket did not announce focus on $agentId: $evidence',
        );
      }

      Future<void> latestImage(String name) async {
        await tester.pump();
        final image = await boundary.toImage(pixelRatio: 1);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$output/$name.png').writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      }

      app.focusPane(origin.id, reveal: true);
      await until(
        () => app.focusedPane == origin && app.zoomedPaneId == origin.id,
        'the saved Summary pane is now the visible current pane',
      );
      await focusEvidence(questionAgent);
      final latestSession = origin.session!;
      final latestTerminal = latestSession.terminal;
      final latestFinder = find.byWidgetPredicate(
        (widget) => widget is TerminalView && widget.terminal == latestTerminal,
      );
      final latestRenderer = tester.state(latestFinder);
      final latestView = tester.widget<TerminalView>(latestFinder);
      final latestController = latestView.controller;
      expect(latestController, isNotNull);
      final latestScroll = latestView.scrollController!;
      expect(latestScroll.position.maxScrollExtent, greaterThan(241));
      latestScroll.jumpTo(240.25);
      await tester.pump();
      final latestOffset = latestScroll.offset;
      expect(latestOffset, closeTo(240.25, .01));
      final latestTextBefore = latestTerminal.buffer.getText();
      final latestTab = app.activeSwarmId;
      Map<String, int> readingIdentity() => {
        'pane': identityHashCode(app.focusedPane),
        'session': identityHashCode(origin.session),
        'terminal': identityHashCode(origin.session!.terminal),
        'renderer': identityHashCode(tester.state(latestFinder)),
        'controller': identityHashCode(
          tester.widget<TerminalView>(latestFinder).controller,
        ),
        'scrollController': identityHashCode(
          tester.widget<TerminalView>(latestFinder).scrollController,
        ),
      };
      final originalIdentity = readingIdentity();
      final originExtent = latestScroll.position.maxScrollExtent;
      final latestBefore = await request('/evidence');
      expect(latestBefore['inputFrames'], 0);
      await latestImage('native-latest-before');

      Future<Map<String, dynamic>> visitFromDevice(
        String op,
        String agentId,
      ) async {
        final response = await request('/visit', {
          'op': op,
          'agentId': agentId,
        });
        final frame = response['command'] as Map;
        expect(frame['t'], 'visit');
        expect(frame['op'], op);
        expect(frame['agentId'], agentId);
        expect(frame['visitId'], latestVisitId);
        expect(frame['requestId'], matches(RegExp(r'^visit-[1-9][0-9]*$')));
        expect(response['summary'], retainedSummary);
        final result = response['result'] as Map;
        expect(result['visitId'], latestVisitId);
        expect(result['requestId'], frame['requestId']);
        return response;
      }

      final latest = await visitFromDevice('latest', questionAgent);
      expect((latest['result'] as Map)['ok'], isTrue, reason: '$latest');
      expect((latest['result'] as Map)['active'], isTrue);
      expect((latest['result'] as Map)['label'], 'Your reading');
      await until(
        () =>
            (latestScroll.offset - latestScroll.position.maxScrollExtent)
                .abs() <
            .01,
        'the existing Latest operation reveals the live terminal tail',
      );
      expect(app.focusedPane, same(origin));
      expect(origin.session, same(latestSession));
      expect(origin.session!.terminal, same(latestTerminal));
      expect(tester.state(latestFinder), same(latestRenderer));
      expect(
        tester.widget<TerminalView>(latestFinder).controller,
        same(latestController),
      );
      expect(latestTerminal.buffer.getText(), latestTextBefore);
      final liveOutput = await request('/output', {
        'agentId': questionAgent,
        'marker': 'LIVE_TAIL_AFTER_LATEST',
      });
      await until(
        () => latestTerminal.buffer.getText().contains(
          liveOutput['marker'] as String,
        ),
        'new synthetic tmux output arrives without terminal input',
      );
      await until(
        () =>
            (latestScroll.offset - latestScroll.position.maxScrollExtent)
                .abs() <
            .01,
        'Latest continues following newly arrived output',
      );
      final latestTextWithOutput = latestTerminal.buffer.getText();
      expect(latestTextWithOutput.length, greaterThan(latestTextBefore.length));
      final liveTailOffset = latestScroll.offset;
      final liveTailExtent = latestScroll.position.maxScrollExtent;
      await latestImage('native-latest-tail');
      final repeatedLatest = await visitFromDevice('latest', questionAgent);
      expect((repeatedLatest['result'] as Map)['ok'], isTrue);
      expect((repeatedLatest['result'] as Map)['active'], isTrue);

      final anotherAlert = await request('/visit', {
        'op': 'publish-alert',
        'agentId': second['agentId'],
      });
      expect((anotherAlert['item'] as Map)['readToken'], isA<String>());
      final detour = await visitFromDevice('open', second['agentId'] as String);
      expect((detour['result'] as Map)['ok'], isTrue, reason: '$detour');
      expect((detour['result'] as Map)['active'], isTrue);
      await until(
        () => app.focusedPane == other,
        'the intervening alert opens the other owned pane',
      );
      await focusEvidence(second['agentId'] as String);
      final otherLatest = await visitFromDevice(
        'latest',
        second['agentId'] as String,
      );
      expect((otherLatest['result'] as Map)['ok'], isTrue);
      await tester.pump();
      final otherLiveView = tester.widget<TerminalView>(workFinder);
      final otherLiveScroll = otherLiveView.scrollController!;
      final otherTail = otherLiveScroll.offset;
      final staleLatest = await visitFromDevice('latest', questionAgent);
      expect((staleLatest['result'] as Map)['ok'], isFalse);
      expect((staleLatest['result'] as Map)['active'], isTrue);
      expect((staleLatest['result'] as Map)['label'], 'Your reading');
      expect(
        staleLatest['appCommandsAfter'],
        staleLatest['appCommandsBefore'],
        reason: 'a stale Latest must not dispatch navigation to the app',
      );
      await tester.pump();
      expect(app.focusedPane, same(other));
      expect(otherLiveScroll.offset, closeTo(otherTail, .01));
      expect(latestTerminal.buffer.getText(), latestTextWithOutput);

      final returned = await visitFromDevice(
        'back',
        second['agentId'] as String,
      );
      expect((returned['result'] as Map)['ok'], isTrue, reason: '$returned');
      expect((returned['result'] as Map)['active'], isFalse);
      expect((returned['result'] as Map)['agentId'], questionAgent);
      expect(returned['result'] as Map, isNot(contains('note')));
      await until(
        () =>
            app.focusedPane == origin &&
            (latestScroll.offset - latestOffset).abs() < .01,
        'Return restores the original fractional reading position',
      );
      final latestAfter = await focusEvidence(questionAgent);
      expect(app.activeSwarmId, latestTab);
      expect(app.zoomedPaneId, origin.id);
      expect(origin.session, same(latestSession));
      expect(origin.session!.terminal, same(latestTerminal));
      expect(tester.state(latestFinder), same(latestRenderer));
      final returnedView = tester.widget<TerminalView>(latestFinder);
      expect(returnedView.scrollController, same(latestScroll));
      expect(returnedView.controller, same(latestController));
      final latestReturnedText = latestTerminal.buffer.getText();
      expect(latestReturnedText, latestTextWithOutput);
      final returnedIdentity = readingIdentity();
      expect(returnedIdentity, originalIdentity);
      final returnedOffset = latestScroll.offset;
      expect(latestAfter['retainedSummary'], retainedSummary);
      expect(latestAfter['inputFrames'], 0);
      expect(latestAfter['answerAttempts'], 0);
      final afterReturnOutput = await request('/output', {
        'agentId': questionAgent,
        'marker': 'LIVE_TAIL_AFTER_RETURN',
      });
      await until(
        () => latestTerminal.buffer.getText().contains(
          afterReturnOutput['marker'] as String,
        ),
        'the owned emitter continues after returning to earlier reading',
      );
      expect(latestScroll.offset, closeTo(latestOffset, .01));
      final finalTerminalText = latestTerminal.buffer.getText();
      expect(
        finalTerminalText.length,
        greaterThan(latestTextWithOutput.length),
      );
      final latestFinal = await request('/evidence');
      expect(latestFinal['inputFrames'], 0);
      expect(latestFinal['answerAttempts'], 0);
      expect(latestFinal['retainedSummary'], retainedSummary);
      await latestImage('native-latest-return');
      final viewportEvidence = {
        'origin': {
          'paneId': origin.id,
          'agentId': questionAgent,
          'machineId': 'm',
          'swarmId': latestTab,
          'offset': latestOffset,
          'maxScrollExtent': originExtent,
          'textLength': latestTextBefore.length,
          'identity': originalIdentity,
        },
        'latest': {
          'offset': liveTailOffset,
          'maxScrollExtent': liveTailExtent,
          'textLength': latestTextWithOutput.length,
        },
        'returned': {
          'offset': returnedOffset,
          'textLength': latestTextWithOutput.length,
          'identity': returnedIdentity,
        },
        'afterReturnOutput': {
          'offset': latestScroll.offset,
          'maxScrollExtent': latestScroll.position.maxScrollExtent,
          'textLength': finalTerminalText.length,
        },
        'identityEvidence':
            'Process-local identity hashes plus identical-object assertions.',
        'sameTerminalTextOnReturn': true,
      };
      await request('/visit', {
        'op': 'viewport-receipt',
        'agentId': questionAgent,
        'viewport': viewportEvidence,
      });
      for (final snapshot in [
        (name: 'before', text: latestTextBefore),
        (name: 'tail', text: latestTextWithOutput),
        (name: 'return', text: latestReturnedText),
        (name: 'after-return-output', text: finalTerminalText),
      ]) {
        await File('$output/native-latest-text-${snapshot.name}.txt')
            .writeAsString(snapshot.text);
      }
      await File('$output/native-latest.json').writeAsString(
        jsonEncode({
          'passed': true,
          'nativeRenderer': true,
          'realAppSocketWindowVisitAndTmux': true,
          'physicalDevice': false,
          'syntheticOutputAndCompletion': true,
          'latestMeansLiveTail': true,
          'historicalSummaryPositionClaimed': false,
          'fractionalOriginOffset': latestOffset,
          'returnedOffset': latestScroll.offset,
          'viewport': viewportEvidence,
          'samePaneSessionTerminalRendererAndControllers': true,
          'sameTerminalTextOnReturn': true,
          'repeatedLatestAndOtherAlertPreserveOriginalReturn': true,
          'staleLatestRefusedBeforeAppNavigation': true,
          'newOutputFollowsAtTailThenKeepsReturnedReading': true,
          'summary': retainedSummary,
          'visitId': latestVisitId,
          'inputFrames': latestFinal['inputFrames'],
          'answerAttempts': latestFinal['answerAttempts'],
          'cases': latestFinal['latestCases'],
        }),
      );

      // Carry is a separate journey after the previous receipt is frozen. The
      // real app pins terminal text; only transcription and final host dispatch
      // are substituted. These terminal rows do not claim agent readiness.
      final sourceAgent = first['agentId'] as String;
      final recipientAgent = second['agentId'] as String;
      Future<Map<String, dynamic>> carryRequest(
        String op, {
        String? agent,
        Map<String, dynamic> fields = const {},
      }) => request('/carry', {
        'op': op,
        'agentId': agent ?? sourceAgent,
        ...fields,
      });
      final carryStart = await carryRequest('start');
      final carryId = carryStart['carryId'] as String;
      final words = carryStart['scriptedWords'] as Map;
      expect(carryId, matches(RegExp(r'^carry-[0-9a-f]{16}$')));
      expect(app.focusedPane, same(origin));
      latestScroll.jumpTo(240.25);
      await tester.pump();
      final carryOriginOffset = latestScroll.offset;
      final carryIdentity = readingIdentity();
      final carryTextBefore = latestTerminal.buffer.getText();
      final carryOriginTab = app.activeSwarmId;

      Future<Map<String, dynamic>> carryVisit(
        String action,
        String agent, {
        bool newVisit = false,
      }) async {
        final reply = await carryRequest(
          'visit',
          agent: agent,
          fields: {'action': action, if (newVisit) 'newVisit': true},
        );
        final frame = reply['command'] as Map;
        expect(frame['t'], 'visit');
        expect(frame['visitId'], matches(RegExp(r'^visit-[0-9a-f]{16}$')));
        expect(frame['requestId'], matches(RegExp(r'^visit-[1-9][0-9]*$')));
        expect(frame['agentId'], agent);
        expect((reply['result'] as Map)['ok'], isTrue, reason: '$reply');
        await focusEvidence((reply['result'] as Map)['agentId'] as String);
        return reply;
      }

      // An already acknowledged reading Return must survive selection/Carry.
      await carryVisit('latest', sourceAgent);
      await until(
        () =>
            (latestScroll.offset - latestScroll.position.maxScrollExtent)
                .abs() <
            .01,
        'Carry starts with an acknowledged reading bookmark',
      );
      var chosen = await request('/selection', {
        'op': 'begin',
        'agentId': sourceAgent,
      });
      final staleCarry = await carryRequest(
        'prepare',
        fields: {
          'selectionId': chosen['selectionId'],
          'revision': (chosen['revision'] as int) + 1,
        },
      );
      expect((staleCarry['result'] as Map)['ok'], isFalse);
      expect(staleCarry['dispatches'], 0);
      chosen = await request('/selection', {
        'op': 'begin',
        'agentId': sourceAgent,
      });
      chosen = await request('/selection', {
        'op': 'extend',
        'extend': true,
        'agentId': sourceAgent,
        'selectionId': chosen['selectionId'],
        'revision': chosen['revision'],
      });
      chosen = await request('/selection', {
        'op': 'step',
        'delta': -2,
        'agentId': sourceAgent,
        'selectionId': chosen['selectionId'],
        'revision': chosen['revision'],
      });
      expect(chosen['ok'], isTrue);
      expect(chosen['rows'], 3);
      await tester.pump();
      await latestImage('native-carry-selected');
      final textAtPin = latestTerminal.buffer.getText();
      final prepared = await carryRequest(
        'prepare',
        fields: {
          'selectionId': chosen['selectionId'],
          'revision': chosen['revision'],
        },
      );
      expect((prepared['result'] as Map)['ok'], isTrue, reason: '$prepared');
      final source = Map<String, dynamic>.from(prepared['source'] as Map);
      final selectedText = source['text'] as String;
      expect(source['agentId'], sourceAgent);
      expect(source['rows'], 3);
      expect(selectedText.split('\n'), hasLength(3));
      expect(textAtPin, contains(selectedText));
      expect(selectedText, contains('  ${first['marker']}'));
      final sourceJson = jsonEncode(source);
      await until(
        () => latestController!.highlights.isEmpty,
        'Carry releases the app highlight after the exact pin',
      );
      final afterPinOutput = await carryRequest(
        'output',
        fields: {'marker': 'CARRY_SOURCE_AFTER_PIN'},
      );
      await until(
        () => latestTerminal.buffer.getText().contains(
          afterPinOutput['marker'] as String,
        ),
        'owned source output arrives after the frozen quote',
      );

      final firstRecipient = await carryVisit('open', recipientAgent);
      expect((firstRecipient['result'] as Map)['active'], isTrue);
      await until(
        () => app.focusedPane == other,
        'first Carry recipient opens',
      );
      final choseSource = await carryVisit('open', sourceAgent);
      expect((choseSource['result'] as Map)['active'], isFalse);
      expect(choseSource['result'], isNot(contains('note')));
      await until(
        () =>
            app.focusedPane == origin &&
            (latestScroll.offset - carryOriginOffset).abs() < .01,
        'choosing the original source restores and finishes its visit',
      );
      final originChoiceOffset = latestScroll.offset;
      expect(readingIdentity(), carryIdentity);
      expect((await request('/evidence'))['carryDispatches'], isEmpty);
      final finalRecipient = await carryVisit(
        'open',
        recipientAgent,
        newVisit: true,
      );
      expect((finalRecipient['result'] as Map)['active'], isTrue);
      expect(
        (finalRecipient['command'] as Map)['visitId'],
        isNot((firstRecipient['command'] as Map)['visitId']),
      );
      await until(
        () => app.focusedPane == other,
        'final Carry recipient opens',
      );
      final selectedRecipient = await request('/evidence');
      expect(selectedRecipient['carryDispatches'], isEmpty);
      expect(
        selectedRecipient['transcriptCalls'],
        isEmpty,
        reason: 'Choosing a recipient never starts recording',
      );
      await latestImage('native-carry-recipient');

      final recording = await carryRequest(
        'record',
        agent: recipientAgent,
        fields: {'kind': 'initial'},
      );
      expect(recording['dispatches'], 0);
      final duringReviewOutput = await carryRequest(
        'output',
        fields: {'marker': 'CARRY_SOURCE_DURING_REVIEW'},
      );
      await until(
        () => latestTerminal.buffer.getText().contains(
          duringReviewOutput['marker'] as String,
        ),
        'source can keep working while the direction is transcribed',
      );
      final sourceAlert = await carryRequest('publish-alert');
      expect((sourceAlert['item'] as Map)['agentId'], sourceAgent);
      expect(app.focusedPane, same(other));
      final reviewed = await carryRequest(
        'release-transcript',
        agent: recipientAgent,
        fields: {'uploadId': recording['uploadId']},
      );
      final originalDraft = Map<String, dynamic>.from(
        reviewed['result'] as Map,
      );
      expect(originalDraft['t'], 'voice.draft');
      expect(originalDraft['agentId'], recipientAgent);
      expect(originalDraft['text'], words['initial']);
      expect(
        originalDraft['context'],
        'With text from ${source['sourceName']}',
      );
      expect(reviewed['dispatches'], 0);
      final edit = await carryRequest(
        'record',
        agent: recipientAgent,
        fields: {
          'kind': 'replace',
          'draftId': originalDraft['id'],
          'revision': originalDraft['revision'],
        },
      );
      final edited = await carryRequest(
        'release-transcript',
        agent: recipientAgent,
        fields: {'uploadId': edit['uploadId']},
      );
      final editedDraft = Map<String, dynamic>.from(edited['result'] as Map);
      expect(editedDraft['id'], originalDraft['id']);
      expect(
        editedDraft['revision'],
        greaterThan(originalDraft['revision'] as int),
      );
      expect(editedDraft['agentId'], recipientAgent);
      expect(editedDraft['text'], words['replace']);
      expect(editedDraft['context'], originalDraft['context']);
      expect(jsonEncode(edited['source']), sourceJson);
      expect(edited['dispatches'], 0);

      Future<Map<String, dynamic>> sendDraft(int revision) => carryRequest(
        'draft',
        agent: recipientAgent,
        fields: {
          'action': 'send',
          'draftId': editedDraft['id'],
          'revision': revision,
        },
      );
      final staleSend = await sendDraft(originalDraft['revision'] as int);
      expect((staleSend['result'] as Map)['ok'], isFalse);
      expect(staleSend['dispatches'], isEmpty);
      final sent = await sendDraft(editedDraft['revision'] as int);
      expect((sent['result'] as Map)['sent'], isTrue);
      expect((sent['result'] as Map)['carryId'], carryId);
      final expectedDispatch =
          '${words['replace']}\n\n'
          'Context I selected from harness ${jsonEncode(source['sourceName'])}:\n'
          '${selectedText.split('\n').map((line) => '> $line').join('\n')}';
      expect(sent['dispatches'], [
        {'agentId': recipientAgent, 'text': expectedDispatch},
      ]);
      final duplicate = await sendDraft(editedDraft['revision'] as int);
      expect((duplicate['result'] as Map)['sent'], isTrue);
      expect(duplicate['dispatches'], sent['dispatches']);
      expect(app.focusedPane, same(other));
      final textBeforeReturn = latestTerminal.buffer.getText();
      final carryBack = await carryVisit('back', recipientAgent);
      expect((carryBack['result'] as Map)['active'], isFalse);
      expect(carryBack['result'], isNot(contains('note')));
      await until(
        () =>
            app.focusedPane == origin &&
            (latestScroll.offset - carryOriginOffset).abs() < .01,
        'reviewed Carry returns to the original fractional reading position',
      );
      expect(app.activeSwarmId, carryOriginTab);
      expect(origin.session, same(latestSession));
      expect(origin.session!.terminal, same(latestTerminal));
      expect(tester.state(latestFinder), same(latestRenderer));
      expect(
        tester.widget<TerminalView>(latestFinder).controller,
        same(latestController),
      );
      expect(
        tester.widget<TerminalView>(latestFinder).scrollController,
        same(latestScroll),
      );
      expect(readingIdentity(), carryIdentity);
      expect(latestTerminal.buffer.getText(), textBeforeReturn);
      expect(textBeforeReturn.length, greaterThan(carryTextBefore.length));
      final carryFinal = await request('/evidence');
      expect(carryFinal['inputFrames'], 0);
      expect(carryFinal['answerAttempts'], 0);
      expect(carryFinal['carryDispatches'], sent['dispatches']);
      expect(carryFinal['transcriptCalls'], hasLength(2));
      expect(jsonEncode(carryFinal['carriedSource']), sourceJson);
      await latestImage('native-carry-return');
      final carryViewport = {
        'original': {'offset': carryOriginOffset, 'identity': carryIdentity},
        'choosingSource': {'offset': originChoiceOffset, 'visitEnded': true},
        'returned': {
          'offset': latestScroll.offset,
          'identity': readingIdentity(),
        },
        'selectedText': selectedText,
        'textBeforeLength': carryTextBefore.length,
        'textAfterLength': textBeforeReturn.length,
        'sameTerminalTextOnReturn': true,
      };
      await carryRequest(
        'viewport-receipt',
        fields: {'viewport': carryViewport},
      );
      await File('$output/native-carry-source.txt').writeAsString(selectedText);
      await File('$output/native-carry-dispatch.txt')
          .writeAsString(expectedDispatch);
      await File('$output/native-carry.json').writeAsString(
        jsonEncode({
          'passed': true,
          'nativeRenderer': true,
          'physicalDevice': false,
          'realAppSocketSelectionCarryVoiceDraftAndVisit': true,
          'syntheticTranscript': true,
          'nativeCaptureReadinessClaimed': false,
          'dispatchBoundary':
              'DaemonCableHost sendTurn callback into owned memory',
          'terminalInput': false,
          'vendorAcceptance': false,
          'source': source,
          'recipientAgent': recipientAgent,
          'viewport': carryViewport,
          'sourceAlert': sourceAlert,
          'originalDraft': originalDraft,
          'editedDraft': editedDraft,
          'staleSend': staleSend,
          'sent': sent,
          'duplicate': duplicate,
          'dispatches': carryFinal['carryDispatches'],
          'cases': carryFinal['carryCases'],
          'choosingRecipientsNeverCaptured': true,
        }),
      );

      // Spoken Find searches this terminal's literal output. It does not open
      // a task draft, send input, or create a new reading Return bookmark.
      Future<Map<String, dynamic>> findRequest(
        String op, {
        String? agent,
        Map<String, dynamic> fields = const {},
      }) => request('/find', {
        'op': op,
        'agentId': agent ?? sourceAgent,
        ...fields,
      });
      final findStart = await findRequest('start');
      final phrase = findStart['phrase'] as String;
      final beforeFind = await request('/evidence');
      final findIdentity = readingIdentity();
      expect(beforeFind['hostDispatchAttempts'], 1);
      final initialSearchOutput = await findRequest(
        'output',
        fields: {'stage': 0},
      );
      await until(
        () => latestTerminal.buffer.getText().contains(
          initialSearchOutput['marker'] as String,
        ),
        'fresh literal phrases reach the real source terminal',
      );
      Map<String, dynamic> findState = {};
      Future<Map<String, dynamic>> beginFind() async {
        findState = await request('/selection', {
          'op': 'begin',
          'agentId': sourceAgent,
        });
        expect(findState['ok'], isTrue, reason: '$findState');
        expect(
          findState['selectionId'],
          matches(RegExp(r'^pick-[0-9a-f]{16}$')),
        );
        await tester.pump();
        return findState;
      }

      String highlightedWords() {
        final controller = latestController!;
        expect(controller.highlights, hasLength(1));
        return latestTerminal.buffer
            .getText(controller.highlights.single.range)
            .trimRight();
      }

      Future<Map<String, dynamic>> recordFind(String kind) => findRequest(
        'record',
        fields: {
          'kind': kind,
          'selectionId': findState['selectionId'],
          'revision': findState['revision'],
        },
      );
      Future<Map<String, dynamic>> releaseFind(
        Map<String, dynamic> recording,
      ) => findRequest(
        'release-transcript',
        fields: {'uploadId': recording['uploadId']},
      );
      Future<Map<String, dynamic>> selectFind(
        String op, {
        Map<String, dynamic> fields = const {},
      }) async {
        findState = await request('/selection', {
          'op': op,
          'agentId': sourceAgent,
          'selectionId': findState['selectionId'],
          'revision': findState['revision'],
          ...fields,
        });
        expect(findState['ok'], isTrue, reason: '$findState');
        await tester.pump();
        return findState;
      }

      await beginFind();
      final cancelledSearchId = findState['selectionId'];
      final cancelledSearch = await recordFind('match');
      await findRequest(
        'abort',
        fields: {'uploadId': cancelledSearch['uploadId']},
      );
      await until(
        () => latestController!.highlights.isEmpty,
        'Cancel search removes its old reading cursor',
      );
      await beginFind();
      expect(findState['selectionId'], isNot(cancelledSearchId));
      final replacementCursor = Map<String, dynamic>.from(findState);
      final replacementWords = highlightedWords();
      final cancelledResult = await releaseFind(cancelledSearch);
      expect(cancelledResult['suppressed'], isTrue);
      await tester.pump();
      expect(
        highlightedWords(),
        replacementWords,
        reason: 'late cancelled speech cannot replace the newer reading cursor',
      );

      // The source becomes the current pane again, but the old focus lifetime
      // still ended. This is external app navigation during held transcription.
      final staleSearch = await recordFind('match');
      app.focusPane(other.id, reveal: true);
      await until(
        () => app.focusedPane == other,
        'external focus leaves the search source',
      );
      await focusEvidence(recipientAgent);
      await findRequest(
        'focus-checkpoint',
        agent: recipientAgent,
        fields: {'phase': 'away'},
      );
      app.focusPane(origin.id, reveal: true);
      await until(
        () => app.focusedPane == origin,
        'external focus returns to the same source',
      );
      await focusEvidence(sourceAgent);
      await findRequest('focus-checkpoint', fields: {'phase': 'back'});
      final staleSearchResult = await releaseFind(staleSearch);
      expect((staleSearchResult['result'] as Map)['t'], 'voice.error');
      await until(
        () => latestController!.highlights.isEmpty,
        'A to B to A cannot revive the old selection',
      );
      expect(readingIdentity(), findIdentity);

      await beginFind();
      final missingRecording = await recordFind('missing');
      final missingSearch = await releaseFind(missingRecording);
      findState = Map<String, dynamic>.from(missingSearch['result'] as Map);
      expect(findState['t'], 'voice.search');
      expect(findState['agentId'], sourceAgent);
      expect(findState['query'], 'missing amber receipt');
      expect(findState['matches'], 0);
      expect(findState['match'], 0);
      expect(findState['rows'], 0);
      expect(findState['excerpt'], '');
      await until(
        () => latestController!.highlights.isEmpty,
        'zero matches have no selected quote',
      );
      await latestImage('native-spoken-find-no-match');
      final noMatchId = findState['selectionId'];
      final matchedRecording = await recordFind('match');
      final matchedSearch = await releaseFind(matchedRecording);
      findState = Map<String, dynamic>.from(matchedSearch['result'] as Map);
      expect(findState['t'], 'voice.search');
      expect(
        findState['selectionId'],
        noMatchId,
        reason:
            'a new phrase works after no matches without changing the source',
      );
      expect(findState['agentId'], sourceAgent);
      expect(findState['query'], phrase);
      expect(findState['matches'], 3);
      expect(findState['match'], inInclusiveRange(1, 3));
      await tester.pump();
      final firstMatch = Map<String, dynamic>.from(findState);
      final firstMatchWords = highlightedWords();
      expect(firstMatchWords.toLowerCase(), contains(phrase));
      await selectFind('match', fields: {'delta': 1});
      expect(findState['match'], (firstMatch['match'] as int) % 3 + 1);
      expect(highlightedWords(), isNot(firstMatchWords));
      await selectFind('match', fields: {'delta': -1});
      expect(findState['match'], firstMatch['match']);
      expect(highlightedWords(), firstMatchWords);
      for (var step = 0; step < 3; step++) {
        await selectFind('match', fields: {'delta': 1});
      }
      expect(findState['match'], firstMatch['match']);
      expect(highlightedWords(), firstMatchWords);
      await latestImage('native-spoken-find-matches');

      final addedSearchOutput = await findRequest(
        'output',
        fields: {'stage': 1},
      );
      await until(
        () => latestTerminal.buffer.getText().contains(
          addedSearchOutput['marker'] as String,
        ),
        'new matching output arrives while the selected source line remains anchored',
      );
      expect(
        highlightedWords(),
        firstMatchWords,
        reason: 'new output must not silently replace the selected passage',
      );
      await selectFind('match', fields: {'delta': 1});
      expect(findState['matches'], 4);
      expect(findState['match'], inInclusiveRange(1, 4));
      final afterNewOutputMatch = Map<String, dynamic>.from(findState);
      final matchWords = highlightedWords();
      await selectFind('lines');
      expect(findState.containsKey('query'), isFalse);
      expect(highlightedWords(), matchWords);
      await selectFind('extend', fields: {'extend': true});
      await selectFind('step', fields: {'delta': 1});
      expect(findState['rows'], 2);
      final selectedFoundWords = highlightedWords();
      expect(selectedFoundWords.toLowerCase(), contains(phrase));
      expect(selectedFoundWords, contains('CONTEXT_'));
      final selectedFoundState = Map<String, dynamic>.from(findState);
      await latestImage('native-spoken-find-range');
      final foundCarry = await findRequest(
        'carry',
        fields: {
          'selectionId': findState['selectionId'],
          'revision': findState['revision'],
        },
      );
      expect(
        (foundCarry['result'] as Map)['ok'],
        isTrue,
        reason: '$foundCarry',
      );
      expect((foundCarry['result'] as Map)['carryId'], findStart['carryId']);
      final foundSource = foundCarry['source'] as Map;
      expect(foundSource['agentId'], sourceAgent);
      expect(foundSource['sourceName'], source['sourceName']);
      expect(foundSource['selectionId'], selectedFoundState['selectionId']);
      expect(foundSource['text'], selectedFoundWords);
      expect(foundSource['rows'], 2);
      await until(
        () => latestController!.highlights.isEmpty,
        'Carry releases the found range highlight',
      );
      final afterFoundPin = await findRequest('output', fields: {'stage': 2});
      await until(
        () => latestTerminal.buffer.getText().contains(
          afterFoundPin['marker'] as String,
        ),
        'new output after Find Carry cannot rewrite the captured words',
      );
      final afterFind = await request('/evidence');
      expect((afterFind['foundCarry'] as Map)['text'], selectedFoundWords);
      expect(
        afterFind['hostDispatchAttempts'],
        beforeFind['hostDispatchAttempts'],
      );
      expect(afterFind['carryDispatches'], beforeFind['carryDispatches']);
      expect(afterFind['inputFrames'], 0);
      expect(afterFind['answerAttempts'], 0);
      expect(
        afterFind['appVisitCommands'],
        beforeFind['appVisitCommands'],
        reason: 'plain Find does not create a Return visit',
      );
      expect(app.focusedPane, same(origin));
      expect(origin.session, same(latestSession));
      expect(tester.state(latestFinder), same(latestRenderer));
      expect(readingIdentity(), findIdentity);
      final findEvidence = {
        'passed': true,
        'nativeRenderer': true,
        'physicalDevice': false,
        'syntheticTranscript': true,
        'realAppSocketSearchAndCarry': true,
        'phrase': phrase,
        'missingSearch': missingSearch,
        'firstMatch': firstMatch,
        'afterNewOutputMatch': afterNewOutputMatch,
        'cancelledResult': cancelledResult,
        'replacementCursor': replacementCursor,
        'staleFocusResult': staleSearchResult,
        'focusRoundtripInvalidatesSearch': true,
        'newOutputKeepsSelectedWords': firstMatchWords,
        'foundRange': selectedFoundState,
        'carried': foundCarry,
        'identity': findIdentity,
        'finalIdentity': readingIdentity(),
        'newDispatches': 0,
        'terminalInput': false,
        'createsReturn': false,
      };
      await findRequest('finish', fields: {'evidence': findEvidence});
      await File('$output/native-spoken-find.json')
          .writeAsString(jsonEncode(findEvidence));
      await File('$output/native-spoken-find-quote.txt')
          .writeAsString(selectedFoundWords);
      expect(tester.takeException(), isNull);
      await File('$output/native-result.json').writeAsString(
        jsonEncode({
          'passed': true,
          'nativeRenderer': true,
          'realWebSocketAndTmux': true,
          'framedCableEmulator': true,
          'syntheticOutput': true,
          'vendorInference': false,
          'physicalDevice': false,
          'selectedRows': state['rows'],
          'staleFocusRefused': true,
          'sameRenderer': true,
          'inputFrames': after['inputFrames'],
          'sameSessionQuestionRead': true,
          'lateReadAckPreservesPending': true,
          'exactQuestionClose': true,
          'staleClosePreservesNewOccurrence': true,
          'questionFocusAndReadingUnchanged': true,
          'answerAttempts': attention['answerAttempts'],
          'resultWordsByReceipt': true,
          'duplicateCompletionPreservesWords': true,
          'latestRecapCannotReplaceReceiptWords': true,
          'lateResultReadCannotClearNewOccurrence': true,
          'appReconnectRestoresExactResultWords': true,
          'resultFocusAndViewportUnchanged': true,
          'sameSessionAndRendererAfterReconnect': true,
          'sameLiveScrollControllerAfterReconnect': true,
          'currentTerminalTextUnchangedAfterReconnect': true,
          'terminalModelReplacedOnReconnect': !identical(
            other.session!.terminal,
            resultTerminal,
          ),
          'resultTokens': [firstToken, secondToken],
          'resultWords': [firstWords, secondWords],
          'resultViewportOffset': resultOffset,
          'latestOutputAndExactReturn': true,
          'selectedPassageReviewedCarryAndReturn': true,
          'spokenFindMatchesRangeAndCarry': true,
          'intentionalHostDispatches': 1,
          'terminalInput': false,
        }),
      );
      await tester.pumpWidget(const SizedBox());
      await request('/shutdown', {});
    },
  );
}
