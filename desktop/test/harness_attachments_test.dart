import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/attached_task_delivery.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/terminal/terminal_session.dart';

HarnessAttachment _file(String name, [int size = 4]) =>
    HarnessAttachment(name, Uint8List(size));

const _codexComposer =
    '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m\r\n'
    '\r\n  GPT-6-Astra · /tmp/work\r\n  ? for shortcuts';

/// Records what a harness's terminal was handed, in order.
class _RecordingSession extends TerminalSession {
  _RecordingSession()
    : super(
        machineId: 'box',
        agentId: 'a1',
        agentName: 'Weather',
        engineId: 'claude',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      ) {
    status = TerminalSessionStatus.controlling;
    streamId = 's1';
  }

  final calls = <String>[];

  @override
  Future<bool> pasteFile(String filename, Uint8List content) async {
    calls.add('file:$filename');
    return true;
  }

  @override
  Future<bool> pasteText(String text, {String? tabId}) async {
    calls.add('paste:$text');
    return true;
  }

  @override
  Future<bool> sendComposerText(String text, {String? tabId}) async {
    calls.add('send:$text');
    return true;
  }

  /// "Take control": the daemon answers by handing this window the lease.
  @override
  Future<void> reopen({bool force = false}) async {
    calls.add('reopen:$force');
    watching = false;
    notifyListeners();
  }
}

AppNotifier _app({
  String launch = 'ready',
  bool canPasteFiles = true,
  String? engine,
}) {
  final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession());
  app.machineStates['box'] =
      MachineState(
          const Machine(
            machineId: 'box',
            name: 'Box',
            authMode: MachineAuthMode.remote,
          ),
        )
        ..terminalPasteFileAvailable = canPasteFiles
        ..terminalPasteRawAvailable = true
        ..agents = [
          Agent(id: 'a1', name: 'Weather', launchState: launch, engine: engine),
        ];
  return app;
}

void main() {
  group('HarnessAttachments', () {
    test('keeps one file per name and refuses what is over the limit', () {
      final files = HarnessAttachments();
      expect(files.add([_file('a.png'), _file('b.txt')]), isNull);
      expect(files.add([_file('a.png', 8)]), isNull);
      expect(files.files.map((f) => f.name), ['b.txt', 'a.png']);
      expect(files.files.last.bytes.length, 8);
      final problem = files.add([
        _file('huge.mov', HarnessAttachments.maxBytes + 1),
      ]);
      expect(problem, contains('huge.mov'));
      expect(files.files, hasLength(2));
      files.remove(files.files.first);
      expect(files.files.map((f) => f.name), ['a.png']);
    });
  });

  group('deliverAttachedTask', () {
    testWidgets('rechecks Codex readiness and follows a replacement keyframe', (
      tester,
    ) async {
      final app = _app(engine: 'codex');
      addTearDown(app.dispose);
      final session = _RecordingSession();
      session.terminal.write(_codexComposer);
      app.adoptSessionForTest(session);
      String? problem = 'pending';
      unawaited(
        deliverAttachedTask(
          app,
          machineId: 'box',
          agentId: 'a1',
          files: [_file('shot.png')],
          task: 'Look',
        ).then((value) => problem = value),
      );
      await tester.pump(const Duration(milliseconds: 400));
      // The old composer has scrolled away. It cannot make installer output
      // ready, including during the interval originally reserved for settling.
      session.terminal.write('${'\r\n' * 40}Updating Codex via installer…');
      await tester.pump(kAttachedTaskSettle);
      expect(session.calls, isEmpty);
      expect(problem, 'pending');
      final oldTerminal = session.terminal;
      session.terminal = Terminal();
      session.notifyListeners();
      oldTerminal.write('\u001b[2J\u001b[H$_codexComposer');
      await tester.pump(kAttachedTaskSettle);
      expect(session.calls, isEmpty);
      session.terminal.write(_codexComposer);
      await tester.pump(kAttachedTaskSettle + const Duration(milliseconds: 10));
      await tester.pump();
      expect(problem, isNull);
      expect(session.calls, ['file:shot.png', 'paste: ', 'send:Look']);
    });

    testWidgets('stops waiting if the updating Codex pane is closed', (
      tester,
    ) async {
      final app = _app(engine: 'codex');
      addTearDown(app.dispose);
      final session = _RecordingSession();
      session.terminal.write('Update available!\r\n› 1. Update now');
      final pane = app.adoptSessionForTest(session);
      String? problem = 'pending';
      unawaited(
        deliverAttachedTask(
          app,
          machineId: 'box',
          agentId: 'a1',
          files: [_file('shot.png')],
          task: 'Look',
        ).then((value) => problem = value),
      );
      await tester.pump(kAttachedTaskOpenTimeout + const Duration(seconds: 1));
      expect(problem, 'pending');
      app.panes.remove(pane);
      app.notifyListeners();
      await tester.pump();
      expect(problem, contains('did not open in time'));
      expect(session.calls, isEmpty);
      session.dispose();
    });

    testWidgets(
      'keeps the task and image queued through a Codex startup update',
      (tester) async {
        final app = _app(engine: 'codex');
        addTearDown(app.dispose);
        final session = _RecordingSession();
        session.terminal.write(
          'Update available!\r\n› 1. Update now\r\n  2. Skip\r\n'
          'Press enter to continue',
        );
        app.adoptSessionForTest(session);
        String? problem = 'pending';
        unawaited(
          deliverAttachedTask(
            app,
            machineId: 'box',
            agentId: 'a1',
            files: [_file('shot.png')],
            task: 'Fix the problem in this image',
          ).then((value) => problem = value),
        );
        // The updater is a running Codex process with an input-capable terminal,
        // but no conversation yet. Nothing may be pasted into its update menu.
        await tester.pump(
          kAttachedTaskOpenTimeout + const Duration(seconds: 30),
        );
        expect(session.calls, isEmpty);
        expect(problem, 'pending');
        app.notifyListeners(); // Rediscovery during installation is not readiness.
        await tester.pump(const Duration(seconds: 30));
        expect(session.calls, isEmpty);
        session.terminal.write(
          '\u001b[2J\u001b[HUpdating Codex via installer…',
        );
        await tester.pump(const Duration(seconds: 10));
        expect(session.calls, isEmpty);
        // A new empty chat is usable before its first session ID arrives. Only
        // terminal output changes here; no agent inventory notification is sent.
        session.terminal.write('\u001b[2J\u001b[H$_codexComposer');
        await tester.pump(
          kAttachedTaskSettle + const Duration(milliseconds: 10),
        );
        await tester.pump();
        expect(problem, isNull);
        expect(session.calls, [
          'file:shot.png',
          'paste: ',
          'send:Fix the problem in this image',
        ]);
        app.notifyListeners();
        await tester.pump(const Duration(seconds: 1));
        expect(session.calls, hasLength(3));
      },
    );

    test('files first, each followed by a space, then the task', () async {
      final app = _app();
      addTearDown(app.dispose);
      final session = _RecordingSession();
      app.adoptSessionForTest(session);
      final problem = await deliverAttachedTask(
        app,
        machineId: 'box',
        agentId: 'a1',
        files: [_file('shot.png'), _file('notes.md')],
        task: 'Summarise these',
      );
      expect(problem, isNull);
      expect(session.calls, [
        'file:shot.png',
        'paste: ',
        'file:notes.md',
        'paste: ',
        'send:Summarise these',
      ]);
    });

    testWidgets('waits for the engine to be ready before handing anything', (
      tester,
    ) async {
      final app = _app(launch: 'starting');
      addTearDown(app.dispose);
      final session = _RecordingSession();
      app.adoptSessionForTest(session);
      String? problem = 'pending';
      unawaited(
        deliverAttachedTask(
          app,
          machineId: 'box',
          agentId: 'a1',
          files: [_file('shot.png')],
          task: 'Look',
        ).then((value) => problem = value),
      );
      await tester.pump(const Duration(seconds: 5));
      expect(session.calls, isEmpty);
      app.machineStates['box']!.agents = [
        const Agent(id: 'a1', name: 'Weather'),
      ];
      app.notifyListeners();
      await tester.pump(kAttachedTaskSettle + const Duration(milliseconds: 10));
      await tester.pump();
      expect(problem, isNull);
      expect(session.calls.first, 'file:shot.png');
    });

    test('takes control of a pane that opened as a watcher', () async {
      final app = _app();
      addTearDown(app.dispose);
      // Another window on the account (the Mac's own app) holds the terminal.
      final session = _RecordingSession()..watching = true;
      app.adoptSessionForTest(session);
      final problem = await deliverAttachedTask(
        app,
        machineId: 'box',
        agentId: 'a1',
        files: [_file('shot.png')],
        task: 'Look',
      );
      expect(problem, isNull);
      expect(session.calls, [
        'reopen:true',
        'file:shot.png',
        'paste: ',
        'send:Look',
      ]);
    });

    testWidgets('gives up with a message when the harness never opens', (
      tester,
    ) async {
      final app = _app(launch: 'starting');
      addTearDown(app.dispose);
      String? problem;
      unawaited(
        deliverAttachedTask(
          app,
          machineId: 'box',
          agentId: 'a1',
          files: [_file('shot.png')],
          task: 'Look',
        ).then((value) => problem = value),
      );
      await tester.pump(kAttachedTaskOpenTimeout + const Duration(seconds: 1));
      await tester.pump();
      expect(problem, contains('did not open in time'));
    });
  });

  test('a machine whose CLI cannot paste files cannot take attachments', () {
    final app = _app(canPasteFiles: false);
    addTearDown(app.dispose);
    expect(canAttachFiles(app, 'box'), isFalse);
    expect(canAttachFiles(app, 'nowhere'), isFalse);
  });
}
