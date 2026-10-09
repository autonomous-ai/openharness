import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/setup_progress.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/setup_tour.dart';

/// The welcome tour as a fresh computer sees it while setup installs, and as
/// Help ▸ Welcome Tour shows it. Progress is a plain [ValueNotifier]: the
/// tour reads nothing else, so no installer, clock or app is involved.
const _macTitles = [
  'All your machines,\none window.',
  'All your agents,\nside by side.',
  '⌘P finds\nany harness.',
  '⌘N starts\na new harness.',
  'Sessions that\nkeep going.',
  'Your agents\nin your pocket.',
  'The Harness\ndevice.',
];

const _kickers = [
  'WELCOME TO HARNESS',
  'EVERY AGENT',
  'KEYBOARD FIRST',
  'KEYBOARD FIRST',
  'ALWAYS THERE',
  'ON THE GO',
  'ON YOUR DESK',
];

final _title = find.byKey(const ValueKey('tour-title'));
final _line = find.byKey(const ValueKey('tour-install-line'));
final _next = find.byKey(const ValueKey('tour-next'));
final _toggle = find.byKey(const ValueKey('tour-details-toggle'));
final _retry = find.byKey(const ValueKey('tour-retry'));

String _shownTitle(WidgetTester tester) =>
    tester.widget<Text>(_title.last).data!;

Future<void> _mount(
  WidgetTester tester, {
  ValueNotifier<SetupProgress>? progress,
  VoidCallback? onOpen,
  VoidCallback? onRetry,
  VoidCallback? onManual,
  VoidCallback? onClose,
  bool reduceMotion = false,
  bool screenReader = false,
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          disableAnimations: reduceMotion,
          accessibleNavigation: screenReader,
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: SetupTour(
        progress: progress,
        onOpen: onOpen,
        onRetry: onRetry,
        onManual: onManual,
        onClose: onClose,
        details: const Text('Setup log body'),
      ),
    ),
  );
  await tester.pump();
  // The slide timer must not outlive the test.
  addTearDown(() => tester.pumpWidget(const SizedBox()));
}

/// Past a slide's 6 s and its cross-fade.
Future<void> _nextSlide(WidgetTester tester) async {
  await tester.pump(tourSlideDuration);
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('seven slides in the approved order, each with the tagline', (
    tester,
  ) async {
    await _mount(tester);
    for (var i = 0; i < 7; i++) {
      expect(_shownTitle(tester), _macTitles[i], reason: 'slide ${i + 1}');
      expect(find.text(_kickers[i]).last, findsWidgets);
      expect(find.text(tourTagline), findsOneWidget);
      await tester.tap(_next);
      await tester.pump(const Duration(milliseconds: 400));
    }
    // The arrow loops back to the first.
    expect(_shownTitle(tester), _macTitles.first);
    expect(
      find.text(
        'Your laptop, the desktop under your desk, a box in the cloud. Run '
        'agents on any of them and switch between them like tabs.',
      ),
      findsOneWidget,
    );
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('Linux names its own chords and its computer', (tester) async {
    final progress = ValueNotifier(SetupProgress.starting);
    addTearDown(progress.dispose);
    await _mount(tester, progress: progress);
    expect(
      tester.widget<Text>(_line).data,
      'Setting up Harness on this computer',
    );
    await tester.tap(find.byKey(const ValueKey('tour-dot-2')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), 'Alt+Shift+P finds\nany harness.');
    await tester.tap(_next);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), 'Alt+N starts\na new harness.');
  }, variant: TargetPlatformVariant.only(TargetPlatform.linux));

  testWidgets('advances every 6 s and loops', (tester) async {
    await _mount(tester);
    for (var i = 1; i < 7; i++) {
      await _nextSlide(tester);
      expect(_shownTitle(tester), _macTitles[i]);
    }
    await _nextSlide(tester);
    expect(_shownTitle(tester), _macTitles.first);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('the arrow, the dots and the arrow keys move it by hand', (
    tester,
  ) async {
    await _mount(tester);
    await tester.tap(_next);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), _macTitles[1]);
    // Moving by hand gives the new slide its full 6 s.
    await tester.pump(const Duration(seconds: 5));
    expect(_shownTitle(tester), _macTitles[1]);

    await tester.tap(find.byKey(const ValueKey('tour-dot-5')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), _macTitles[5]);

    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), _macTitles[6]);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), _macTitles[4]);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('one install line with the time left; ▸ unfolds the details', (
    tester,
  ) async {
    final progress = ValueNotifier(
      const SetupProgress(fraction: 0.22, left: Duration(seconds: 36)),
    );
    addTearDown(progress.dispose);
    await _mount(tester, progress: progress);

    expect(tester.widget<Text>(_line).data, 'Setting up Harness on this Mac');
    expect(find.text('about 36 s left'), findsOneWidget);
    expect(find.text('Setup log body'), findsNothing);
    expect(_retry, findsNothing);

    await tester.tap(_toggle);
    await tester.pump();
    expect(find.text('Setup log body'), findsOneWidget);
    await tester.tap(_toggle);
    await tester.pump();
    expect(find.text('Setup log body'), findsNothing);

    progress.value = const SetupProgress(
      fraction: 0.4,
      left: Duration(seconds: 130),
    );
    await tester.pump();
    expect(find.text('about 2 min left'), findsOneWidget);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('a failure turns the line red with Retry and opens the details', (
    tester,
  ) async {
    final progress = ValueNotifier(
      const SetupProgress(fraction: 0.3, left: Duration(seconds: 30)),
    );
    addTearDown(progress.dispose);
    var retries = 0;
    var manual = 0;
    await _mount(
      tester,
      progress: progress,
      onRetry: () => retries++,
      onManual: () => manual++,
    );
    expect(find.byKey(const ValueKey('tour-manual')), findsNothing);

    progress.value = const SetupProgress(
      fraction: 0.3,
      failed: true,
      failure: 'Could not install Harness',
    );
    await tester.pump();

    final line = tester.widget<Text>(_line);
    expect(line.data, 'Could not install Harness');
    final context = tester.element(_line);
    expect(line.style!.color, Theme.of(context).colorScheme.error);
    expect(find.text('Setup log body'), findsOneWidget);
    expect(find.text('about 30 s left'), findsNothing);
    await tester.tap(_retry);
    expect(retries, 1);
    // The setup screen's way out stays: by hand, with its commands.
    await tester.tap(find.byKey(const ValueKey('tour-manual')));
    expect(manual, 1);

    // Retry clears it; the line and the time come back.
    progress.value = const SetupProgress(
      fraction: 0.3,
      left: Duration(seconds: 40),
    );
    await tester.pump();
    expect(_retry, findsNothing);
    expect(find.text('about 40 s left'), findsOneWidget);
  });

  testWidgets(
    'opens Harness only once everything is done, at the end of the slide',
    (tester) async {
      final progress = ValueNotifier(
        const SetupProgress(fraction: 0.5, left: Duration(seconds: 10)),
      );
      addTearDown(progress.dispose);
      var opened = 0;
      await _mount(tester, progress: progress, onOpen: () => opened++);

      // Not done: slides keep cycling, nothing opens.
      await _nextSlide(tester);
      await _nextSlide(tester);
      expect(opened, 0);
      expect(_shownTitle(tester), _macTitles[2]);

      // Setup finished but a download is still pending: the tracker keeps
      // done false, so the tour still waits.
      progress.value = const SetupProgress(fraction: 0.95);
      await _nextSlide(tester);
      expect(opened, 0);

      // Done partway through slide 4 (which ends 6 s after it began, at
      // 24 s): it stays on screen until then.
      await tester.pump(const Duration(seconds: 2));
      progress.value = const SetupProgress(
        fraction: 1,
        left: Duration.zero,
        done: true,
      );
      await tester.pump();
      expect(tester.widget<Text>(_line).data, 'Harness is ready. Opening…');
      expect(find.text('about 0 s left'), findsNothing);
      await tester.pump(const Duration(seconds: 2));
      expect(opened, 0);
      await tester.pump(const Duration(seconds: 1));
      expect(opened, 1);
      expect(_shownTitle(tester), _macTitles[3]);

      // Once.
      await tester.pump(const Duration(seconds: 12));
      expect(opened, 1);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
  );

  testWidgets('Reduce Motion: no cross-fade, but the slides still advance', (
    tester,
  ) async {
    await _mount(tester, reduceMotion: true);
    await tester.pump(tourSlideDuration);
    await tester.pump(const Duration(milliseconds: 50));
    expect(_title, findsOneWidget);
    expect(_shownTitle(tester), _macTitles[1]);

    // Without it the outgoing slide fades out under the new one.
    await tester.pumpWidget(const SizedBox());
    await _mount(tester);
    await tester.pump(tourSlideDuration);
    await tester.pump(const Duration(milliseconds: 50));
    expect(_title, findsNWidgets(2));
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('a screen reader turns the slides itself; Harness still opens', (
    tester,
  ) async {
    final progress = ValueNotifier(SetupProgress.starting);
    addTearDown(progress.dispose);
    var opened = 0;
    await _mount(
      tester,
      progress: progress,
      screenReader: true,
      onOpen: () => opened++,
    );
    await _nextSlide(tester);
    await _nextSlide(tester);
    expect(_shownTitle(tester), _macTitles.first);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump(const Duration(milliseconds: 400));
    expect(_shownTitle(tester), _macTitles[1]);

    progress.value = const SetupProgress(fraction: 1, done: true);
    await _nextSlide(tester);
    expect(opened, 1);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('the keyboard reaches ▸ and opens the details', (tester) async {
    final progress = ValueNotifier(
      const SetupProgress(fraction: 0.22, left: Duration(seconds: 36)),
    );
    addTearDown(progress.dispose);
    await _mount(tester, progress: progress);
    final toggle = tester.widget<InkWell>(_toggle);
    expect(toggle.onTap, isNotNull);
    Focus.of(
      tester.element(
        find.descendant(of: _toggle, matching: find.byType(Padding)).first,
      ),
    ).requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(find.text('Setup log body'), findsOneWidget);
  }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

  testWidgets('Welcome Tour: no install line, Escape and Close end it', (
    tester,
  ) async {
    var closed = 0;
    await _mount(tester, onClose: () => closed++);
    expect(_line, findsNothing);
    expect(find.text(tourTagline), findsOneWidget);

    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    expect(closed, 1);
    await tester.tap(find.byKey(const ValueKey('tour-close')));
    expect(closed, 2);
  });

  for (final (brightness, textScale) in [
    (Brightness.dark, 1.0),
    (Brightness.light, 1.0),
    (Brightness.dark, 1.6),
  ]) {
    testWidgets('draws every slide in ${brightness.name} at ${textScale}x '
        'without overflow', (tester) async {
      final progress = ValueNotifier(
        const SetupProgress(fraction: 0.2, left: Duration(seconds: 40)),
      );
      addTearDown(progress.dispose);
      // The smallest window the app allows.
      await _mount(
        tester,
        progress: progress,
        brightness: brightness,
        textScale: textScale,
      );
      tester.view.physicalSize = const Size(880, 560);
      await tester.pump();
      for (var i = 0; i < 7; i++) {
        await tester.tap(_next);
        await tester.pump(const Duration(milliseconds: 400));
        expect(tester.takeException(), isNull);
      }
      await tester.tap(_toggle);
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  }

  test('time left reads in seconds, then minutes', () {
    expect(
      formatSetupLeft(const Duration(milliseconds: 41200)),
      'about 42 s left',
    );
    expect(
      formatSetupLeft(const Duration(milliseconds: 300)),
      'about 1 s left',
    );
    expect(formatSetupLeft(const Duration(seconds: 61)), 'about 1 min left');
    expect(formatSetupLeft(const Duration(seconds: 150)), 'about 3 min left');
  });
}
