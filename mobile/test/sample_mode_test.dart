import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/demo/sample_mode.dart';
import 'package:harness_mobile/demo/sample_screen.dart' show SayEntry;
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/voice_mic_face.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/state/app_state.dart';

const _studio = 'sample-studio';

/// Sample mode, walked as somebody trying the app for the first time would: it opens on a
/// harness at work, Find lists the rest, a message gets an answer, the question gets answered,
/// New makes another harness — and leaving takes all of it away.
void main() {
  Future<void> settle(WidgetTester tester, Duration total) async {
    const step = Duration(milliseconds: 100);
    for (var spent = Duration.zero; spent < total; spent += step) {
      await tester.pump(step);
    }
  }

  Future<AppNotifier> openSample(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => openSampleMode(context),
                child: const Text('Try a sample'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Try a sample'));
    await settle(tester, const Duration(seconds: 2));
    // It opens on its sessions to pick from, as a new phone does: the working one is picked.
    expect(find.byKey(const ValueKey('pick-up-title')), findsOneWidget);
    await tester.tap(find.text('fix-login', findRichText: true).first);
    await settle(tester, const Duration(seconds: 2));
    return tester.widget<PhoneShell>(find.byType(PhoneShell)).notifier;
  }

  /// Everything in the agent's terminal, scrollback included — as one line, so a sentence the
  /// pane wrapped still reads as the sentence.
  String screenOf(AppNotifier notifier, String agentId, [String? machineId]) {
    final session = notifier
        .paneOfAgent(machineId ?? _studio, agentId)
        ?.session;
    if (session == null) return '';
    final lines = session.terminal.buffer.lines;
    return [for (var i = 0; i < lines.length; i++) lines[i].toString()]
        .join('\n')
        .replaceAll(RegExp(r'\s*\n\s*'), ' ');
  }

  /// Puts [agentId] on screen the way Find does — through the shell.
  Future<void> open(
    WidgetTester tester,
    String agentId, [
    String machineId = _studio,
  ]) async {
    PhoneShellScope.maybeOf(tester.element(find.byType(AgentHome)))!
        .onOpenAgent(machineId, agentId);
    await settle(tester, const Duration(seconds: 2));
  }

  /// Takes the app down. No clock is run out after it: taking the sample down cancels every
  /// timer it started, and the framework fails the test if one is left pending.
  Future<void> closeDown(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  testWidgets('opens on the working harness, and it keeps working', (
    tester,
  ) async {
    final notifier = await openSample(tester);

    expect(
      screenOf(notifier, 'sample-fix-login'),
      contains('Read(src/auth/session.ts)'),
      reason: 'the terminal shows the session so far',
    );
    expect(notifier.agentIsProcessing(_studio, 'sample-fix-login'), isTrue);
    await settle(tester, const Duration(seconds: 6));
    expect(
      screenOf(notifier, 'sample-fix-login'),
      contains('ensureSession'),
      reason: 'new output streams in while it works',
    );
    await closeDown(tester);
  });

  testWidgets('Find lists every harness, and the question is waiting', (
    tester,
  ) async {
    final notifier = await openSample(tester);

    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) - const Offset(120, 0),
      const Offset(300, 0),
    );
    await settle(tester, const Duration(milliseconds: 600));
    for (final name in [
      'fix-login',
      'api-tests',
      'docs-site',
      'refactor-db',
      'mobile-ui',
    ]) {
      expect(
        find.textContaining(name, findRichText: true),
        findsWidgets,
        reason: '$name is in Find',
      );
    }
    expect(
      notifier.questionFor(_studio, 'sample-refactor-db')?.prompt,
      'Do you want to proceed?',
    );
    await closeDown(tester);
  });

  testWidgets('text sent to a harness gets a reply in its terminal', (
    tester,
  ) async {
    final notifier = await openSample(tester);
    await open(tester, 'sample-docs-site', 'sample-laptop');
    final session = notifier
        .paneOfAgent('sample-laptop', 'sample-docs-site')!
        .session!;

    expect(await session.sendComposerText('add a search box'), isTrue);
    await settle(tester, const Duration(seconds: 8));

    final screen = screenOf(notifier, 'sample-docs-site', 'sample-laptop');
    expect(screen, contains('> add a search box'));
    expect(screen, contains('⏺ On it — add a search box'));
    expect(screen, contains('Update(src/components/Header.astro)'));
    expect(screen, contains('Done —'));
    await closeDown(tester);
  });

  testWidgets('a voice take is heard and answered', (tester) async {
    final notifier = await openSample(tester);
    await open(tester, 'sample-mobile-ui', 'sample-laptop');

    await tester.tap(find.byType(VoiceMicCore));
    await settle(tester, const Duration(milliseconds: 800));
    await tester.tap(find.byType(VoiceMicCore));
    await settle(tester, const Duration(seconds: 12));

    final screen = screenOf(notifier, 'sample-mobile-ui', 'sample-laptop');
    expect(screen, contains('› run the tests and fix whatever fails'));
    expect(screen, contains('• On it — run the tests and fix whatever fails'));
    expect(screen, contains('Ran flutter test'));
    await closeDown(tester);
  });

  testWidgets('answering the question closes it and the harness goes on', (
    tester,
  ) async {
    final notifier = await openSample(tester);
    await open(tester, 'sample-refactor-db');

    expect(screenOf(notifier, 'sample-refactor-db'), contains('❯ 1. Yes'));
    await tester.tap(find.textContaining('1 yes', findRichText: true).first);
    await settle(tester, const Duration(seconds: 12));

    final screen = screenOf(notifier, 'sample-refactor-db');
    expect(screen, contains('COMMIT'));
    expect(screen, contains('Migration applied'));
    expect(notifier.questionFor(_studio, 'sample-refactor-db'), isNull);
    await closeDown(tester);
  });

  testWidgets('answering No closes the question and asks what to do instead', (
    tester,
  ) async {
    final runtime = SampleRuntime();
    final harness = runtime.harnessOf(_studio, 'sample-refactor-db')!;
    expect(harness.asking, isTrue);

    harness.keys('3');
    expect(runtime.notifier.questionFor(_studio, 'sample-refactor-db'), isNull);
    await tester.pump(const Duration(seconds: 3));

    expect(
      harness.transcript.whereType<SayEntry>().last.text,
      contains('What should I do instead?'),
    );
    expect(harness.working, isFalse);
    runtime.dispose();
  });

  testWidgets('New makes a harness, and one with a first task works on it', (
    tester,
  ) async {
    final notifier = await openSample(tester);

    // New is a swipe left from the terminal.
    await tester.dragFrom(
      tester.getCenter(find.byType(TerminalPage).first) + const Offset(120, 0),
      const Offset(-240, 0),
    );
    await settle(tester, const Duration(seconds: 1));
    await tester.tap(find.text('project'));
    await settle(tester, const Duration(milliseconds: 500));
    await tester.tap(
      find.textContaining('studio:~/code/web', findRichText: true),
    );
    await settle(tester, const Duration(milliseconds: 500));
    // The first task, typed into New's task field, goes with Start.
    await tester.enterText(find.byType(TextField), 'fix the flaky test');
    await tester.tap(find.text('Start'));
    await settle(tester, const Duration(seconds: 3));

    final made = notifier
        .stateOf(_studio)!
        .agents
        .where((agent) => agent.id.startsWith('sample-new-'))
        .single;
    expect(notifier.focusedPane?.agentId, made.id, reason: 'it opens');
    expect(screenOf(notifier, made.id), contains('Welcome to Claude Code'));

    // A first task: what `createAgent` sends with one.
    final reply = await notifier.connectionForTest!(_studio).request(
      'agent_create',
      payload: {
        'engine': 'codex',
        'cwd': '~/code/api',
        'creationId': 'first-task',
        'prompt': 'add rate limiting to the login route',
      },
    );
    final id = (reply['agent'] as Map)['id'] as String;
    await tester.pump();
    expect(
      notifier.stateOf(_studio)!.agents.map((agent) => agent.id),
      contains(id),
      reason: 'every app hears about the new harness',
    );
    await open(tester, id);
    await settle(tester, const Duration(seconds: 6));
    final screen = screenOf(notifier, id);
    expect(screen, contains('› add rate limiting to the login route'));
    expect(screen, contains('• On it — add rate limiting to the login route'));
    await closeDown(tester);
  });

  testWidgets('Rename and Stop in the … menu work', (tester) async {
    final notifier = await openSample(tester);
    await open(tester, 'sample-docs-site', 'sample-laptop');

    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await settle(tester, const Duration(milliseconds: 500));
    await tester.tap(find.text('Rename…'));
    await settle(tester, const Duration(milliseconds: 500));
    await tester.enterText(find.byType(TextField).last, 'docs-dark-mode');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester, const Duration(seconds: 1));
    expect(
      notifier
          .stateOf('sample-laptop')!
          .agents
          .any((agent) => agent.name == 'docs-dark-mode'),
      isTrue,
    );

    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await settle(tester, const Duration(milliseconds: 500));
    await tester.tap(find.text('Stop this harness…'));
    await settle(tester, const Duration(milliseconds: 500));
    await tester.tap(find.text('Stop').last);
    await settle(tester, const Duration(seconds: 2));
    expect(
      notifier
          .stateOf('sample-laptop')!
          .agents
          .any((agent) => agent.id == 'sample-docs-site'),
      isFalse,
    );
    await closeDown(tester);
  });

  testWidgets('Leave sample in Settings goes back and ends it', (tester) async {
    final notifier = await openSample(tester);

    await tester.tap(find.byKey(const ValueKey('terminal-title')).first);
    await settle(tester, const Duration(milliseconds: 500));
    await tester.tap(find.text('Settings'));
    await settle(tester, const Duration(seconds: 1));
    expect(find.text('Sign out'), findsNothing);
    await tester.tap(find.text('Leave sample'));
    await settle(tester, const Duration(seconds: 2));

    expect(find.byType(PhoneShell), findsNothing);
    expect(find.text('Try a sample'), findsOneWidget);
    expect(SampleMode.ofNotifier(notifier), isNull);
    expect(() => notifier.addListener(() {}), throwsFlutterError);
    await closeDown(tester);
  });
}
