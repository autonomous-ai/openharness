import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'viewer_app_fixture.dart';
import 'voice_fakes.dart';

/// Records the flows begun and how each ended, for an account that shares.
class _Recorder extends ProductMeasurement {
  _Recorder()
    : super(surface: 'phone', automatic: false, sendSetup: (_) async => {});

  final ended = <String>[];

  @override
  bool get sharing => true;

  @override
  bool get declined => false;

  @override
  void Function(ProductOutcome) begin(
    ProductFlow flow, {
    Duration elapsed = Duration.zero,
  }) =>
      (outcome) => ended.add('${flow.name}:${outcome.name}');

  /// How the onboarding's first message ended, if it has.
  List<String> get firstMessage =>
      ended.where((e) => e.startsWith('firstMessage:')).toList();
}

/// The onboarding's first message is the first line sent after the hand-over in ANY session, or a
/// task typed into New Harness: on 2026-10-19 only the session the hand-over opened counted, and a
/// person signing in again who went to a session of their own read as no first message.
void main() {
  group('a line sent', () {
    late _Recorder usage;
    late AppNotifier notifier;
    late TerminalSession session;
    late VoiceInputController voice;
    late ValueNotifier<String> language;

    setUp(() {
      usage = _Recorder();
      notifier = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        productMeasurement: usage,
      );
      session = TerminalSession(
        machineId: 'm',
        agentId: 'a',
        agentName: 'Agent',
        engineId: 'claude',
        send: (type, payload) async => true,
        sendBinary: (_) async => true,
      );
      session.status = TerminalSessionStatus.controlling;
      session.streamId = 's';
      notifier.adoptSessionForTest(session);
      language = ValueNotifier('en');
      voice = VoiceInputController(
        transcriber: FakeTranscriber().call,
        recorder: FakeVoiceRecorder(),
        language: language,
      );
    });

    tearDown(() {
      voice.dispose();
      language.dispose();
      notifier.dispose();
    });

    Future<void> pumpSession(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: TerminalPage(
            notifier: notifier,
            machineId: 'm',
            agentId: 'a',
            voice: voice,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
    }

    testWidgets('in another session than the hand-over opened answers it', (
      tester,
    ) async {
      // The hand-over opened `b`; the person went to `a` and wrote there.
      notifier.firstSessionLine = (machineId: 'm', agentId: 'b', text: 'Say');
      notifier.onboardingMeasurement.start(ProductFlow.firstMessage);
      await pumpSession(tester);

      expect(await session.sendComposerText('fix the build'), isTrue);
      await tester.pump();

      expect(usage.firstMessage, ['firstMessage:ok']);
      // `b`'s line by the mic is `b`'s page's to spend.
      expect(notifier.firstSessionLine?.agentId, 'b');
      // Once: a second line answers nothing more.
      await session.sendComposerText('and run it');
      await tester.pump();
      expect(usage.firstMessage, ['firstMessage:ok']);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('in the session the hand-over opened answers it, as before', (
      tester,
    ) async {
      notifier.firstSessionLine = (machineId: 'm', agentId: 'a', text: 'Say');
      notifier.onboardingMeasurement.start(ProductFlow.firstMessage);
      await pumpSession(tester);

      await session.sendComposerText('fix the build');
      await tester.pump();

      expect(usage.firstMessage, ['firstMessage:ok']);
      expect(notifier.firstSessionLine, isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('leaving the session the hand-over opened does not end it', (
      tester,
    ) async {
      notifier.firstSessionLine = (machineId: 'm', agentId: 'a', text: 'Say');
      notifier.onboardingMeasurement.start(ProductFlow.firstMessage);
      await pumpSession(tester);

      await tester.pumpWidget(const SizedBox());

      expect(usage.firstMessage, isEmpty);
      // The page's line by the mic is still spent on the way out.
      expect(notifier.firstSessionLine, isNull);
      // A sign-out is what ends it unanswered.
      notifier.onboardingMeasurement.reset();
      expect(usage.firstMessage, ['firstMessage:cancelled']);
    });

    testWidgets('before the hand-over answers nothing', (tester) async {
      await pumpSession(tester);

      await session.sendComposerText('fix the build');
      await tester.pump();

      expect(usage.firstMessage, isEmpty);
      await tester.pumpWidget(const SizedBox());
    });
  });

  group('a task typed into New Harness', () {
    Map<String, dynamic> created(Map<String, dynamic> payload, String id) => {
      'creationId': payload['creationId'],
      'state': 'created',
      'agent': agentJson(id),
    };

    /// [pending] finishing, with the terminal it opens measured the way its panel would measure it.
    Future<T> measured<T>(ViewerRig rig, Future<T> pending) async {
      await settle();
      for (final pane in rig.app.panesFor('m')) {
        pane.session?.reportViewport(80, 24);
      }
      return pending;
    }

    Future<(ViewerRig, _Recorder)> waiting() async {
      final usage = _Recorder();
      final rig = await signedInWith({'m': []}, productMeasurement: usage);
      addTearDown(rig.app.dispose);
      rig.app.onboardingMeasurement.start(ProductFlow.firstMessage);
      return (rig, usage);
    }

    test('answers the first message once the harness is made', () async {
      final (rig, usage) = await waiting();
      rig.conn('m').answers['agent_create'] = (p) => created(p, 'new');

      final error = await measured(
        rig,
        rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/work',
          prompt: 'fix the build',
        ),
      );

      expect(error, isNull);
      expect(usage.firstMessage, ['firstMessage:ok']);
    });

    test('without a task, or refused, answers nothing', () async {
      final (rig, usage) = await waiting();
      rig.conn('m').answers['agent_create'] = (p) => created(p, 'new');
      await measured(
        rig,
        rig.app.createAgent('m', engine: 'claude', folder: '/work'),
      );
      await measured(
        rig,
        rig.app.createAgent('m', engine: 'claude', folder: '/a', prompt: '  '),
      );
      rig.conn('m').answers['agent_create'] = (_) => {'error': 'INVALID_CWD'};
      final refused = await measured(
        rig,
        rig.app.createAgent(
          'm',
          engine: 'claude',
          folder: '/missing',
          prompt: 'fix the build',
        ),
      );

      expect(refused, isNotNull);
      expect(usage.firstMessage, isEmpty);
    });
  });
}
