import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/phone/welcome/onboarding_picture.dart';
import 'package:harness_mobile/phone/welcome/your_computer.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'phone_edge/edge_fixture.dart';

/// ② Your computer, pushed from Computers ▸ Add computer: "On your computer, go to", the address
/// that sends the download, the account watched for the computer that opens it — and, when one
/// joins, its moment, then back to the list.
void main() {
  late List<String?> shared;
  late List<String?> chimes;
  late List<String?> haptics;

  setUp(() {
    shared = [];
    chimes = [];
    haptics = [];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      const MethodChannel('dev.fluttercommunity.plus/share'),
      (call) async {
        shared.add((call.arguments as Map)['uri'] as String?);
        return 'dev.fluttercommunity.plus/share/dismissed';
      },
    );
    messenger.setMockMethodCallHandler(const MethodChannel('harness/chime'), (
      call,
    ) async {
      chimes.add(call.arguments as String?);
      return true;
    });
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String?);
      }
      return null;
    });
  });

  tearDown(() {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final channel in const [
      MethodChannel('dev.fluttercommunity.plus/share'),
      MethodChannel('harness/chime'),
      SystemChannels.platform,
    ]) {
      messenger.setMockMethodCallHandler(channel, null);
    }
  });

  const studio = Machine(
    machineId: 'studio',
    authMode: MachineAuthMode.remote,
    name: 'studio',
  );

  /// The list Computers is, with the page pushed over it — as Add computer pushes it.
  Future<AppNotifier> pump(WidgetTester tester, {AppNotifier? app}) async {
    setPhone(tester, largePhone);
    final notifier = app ?? edgeApp(noMachines: true);
    addTearDown(notifier.dispose);
    await tester.pumpWidget(
      phoneApp(
        Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => YourComputerPage(notifier: notifier),
                  ),
                ),
                child: const Text('Computers'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Computers'));
    await frames(tester);
    return notifier;
  }

  /// A computer joins the account: the account's next answer has it.
  Future<void> join(WidgetTester tester, AppNotifier app) async {
    app.machines = [...app.machines, studio];
    app.notifyListeners();
    await tester.pump();
  }

  OnboardingScene scene(WidgetTester tester) =>
      tester.widget<OnboardingPicture>(find.byType(OnboardingPicture)).scene;

  final address = find.byKey(const ValueKey('go-address'));

  /// Whether the address stands on a fill — the green button — rather than as words.
  bool filled(WidgetTester tester) => tester
      .widgetList<Container>(
        find.descendant(of: address, matching: find.byType(Container)),
      )
      .any(
        (box) =>
            box.decoration is BoxDecoration &&
            (box.decoration! as BoxDecoration).color != null,
      );

  Text words(WidgetTester tester) => tester.widget<Text>(
    find.descendant(of: address, matching: find.text(OnboardingCopy.goAddress)),
  );

  testWidgets('On your computer, go to: the address, and the phone looking', (
    tester,
  ) async {
    await pump(tester);
    expect(find.text(OnboardingCopy.goToHeadline), findsOneWidget);
    expect(find.text('autonomous.ai/go'), findsOneWidget);
    // (1) under the address says it is the download (owner, 2026-10-19).
    expect(find.text('Download and install Harness'), findsOneWidget);
    expect(
      find.textContaining(OnboardingCopy.looking, findRichText: true),
      findsOneWidget,
    );
    expect(scene(tester), OnboardingScene.looking);
    expect(find.bySemanticsLabel('Back'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('the address is the button: it sends the link', (tester) async {
    await pump(tester);
    await tester.tap(find.byKey(const ValueKey('go-address')));
    await frames(tester);
    expect(shared, ['https://autonomous.ai/go']);
    expect(OnboardingCopy.goUrl, 'https://autonomous.ai/go');
    await unmount(tester);
  });

  testWidgets('② keeps the green button: the address on a fill', (
    tester,
  ) async {
    await pump(tester);
    expect(
      tester.widget<GoAddressButton>(find.byType(GoAddressButton)).inline,
      isFalse,
    );
    expect(filled(tester), isTrue);
    expect(words(tester).style!.decoration, isNot(TextDecoration.underline));
    await unmount(tester);
  });

  testWidgets(
    'inline, the address is words: green, underlined, no fill — and it sends the link',
    (tester) async {
      setPhone(tester, largePhone);
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        phoneApp(
          const Scaffold(body: Center(child: GoAddressButton(inline: true))),
        ),
      );
      final tty = Tty.of(tester.element(address));
      expect(filled(tester), isFalse);
      expect(words(tester).style!.color, tty.green);
      expect(words(tester).style!.decoration, TextDecoration.underline);
      // As wide as its words, and a thumb's height all the same.
      final size = tester.getSize(address);
      expect(size.height, greaterThanOrEqualTo(GoAddressButton.inlineHeight));
      expect(size.width, lessThan(300));
      expect(
        find.bySemanticsLabel('${OnboardingCopy.goAddress}, Send link'),
        findsOneWidget,
      );

      // Pressed, the words darken on the finger's way down, and come back on its way up.
      final finger = await tester.startGesture(tester.getCenter(address));
      await tester.pump();
      expect(words(tester).style!.color, isNot(tty.green));
      await finger.up();
      await tester.pump();
      expect(words(tester).style!.color, tty.green);
      expect(shared, [OnboardingCopy.goUrl]);
      semantics.dispose();
      await unmount(tester);
    },
  );

  testWidgets('the account is asked for its computers every five seconds', (
    tester,
  ) async {
    final app = edgeApp(noMachines: true);
    final api = _CountingApi(app);
    app.api = api;
    await pump(tester, app: app);
    expect(api.asked, 0);
    await tester.pump(ComputerWatch.every);
    expect(api.asked, 1);
    await tester.pump(ComputerWatch.every);
    expect(api.asked, 2);
    await unmount(tester);
  });

  testWidgets(
    'a computer joins: its moment — taps, the buzz and the notes — then back to the list',
    (tester) async {
      final app = await pump(tester);
      haptics.clear();
      await join(tester, app);
      expect(find.text(OnboardingCopy.ready('studio')), findsOneWidget);
      expect(scene(tester), OnboardingScene.joined);
      // Named as the person's own: no "New device" for the computer they are looking at.
      await tester.pump();
      expect(app.welcomedMachines, contains('studio'));

      // Three quickening taps while the laptop draws itself…
      await tester.pump(const Duration(milliseconds: 300));
      expect(
        haptics.where((h) => h == 'HapticFeedbackType.lightImpact'),
        hasLength(3),
      );
      expect(chimes, isEmpty);
      // …then, as its screen lights, the buzz and the only sound in setup.
      await tester.pump(const Duration(milliseconds: 350));
      expect(haptics.last, 'HapticFeedbackType.mediumImpact');
      expect(chimes, ['assets/sound/joined.wav']);

      // About two seconds in all, and the page goes back to the list by itself.
      await tester.pump(const Duration(milliseconds: 1600));
      await frames(tester);
      expect(find.byType(YourComputerPage), findsNothing);
      expect(find.text('Computers'), findsOneWidget);
      expect(chimes, hasLength(1), reason: 'the notes are played once');
      await unmount(tester);
    },
  );

  testWidgets(
    'a tap during the moment goes back sooner, and plays nothing more',
    (tester) async {
      final app = await pump(tester);
      await join(tester, app);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.tap(find.text(OnboardingCopy.ready('studio')));
      await tester.pump();
      await frames(tester);
      expect(find.byType(YourComputerPage), findsNothing);
      expect(chimes, isEmpty);
      await unmount(tester);
    },
  );

  testWidgets('a computer already on the account is not one joining', (
    tester,
  ) async {
    final app = edgeApp(machineName: 'old-mac');
    await pump(tester, app: app);
    // The account answers again, with only what it had.
    app.notifyListeners();
    await frames(tester);
    expect(find.text(OnboardingCopy.goToHeadline), findsOneWidget);
    expect(find.text(OnboardingCopy.ready('old-mac')), findsNothing);
    await unmount(tester);
  });
}

/// The account's API, counting how often it is asked for its computers.
class _CountingApi extends EdgeApi {
  _CountingApi(AppNotifier app) : super(app, AuthSession());

  int asked = 0;

  @override
  Future<List<Machine>> machines() {
    asked++;
    return super.machines();
  }
}
