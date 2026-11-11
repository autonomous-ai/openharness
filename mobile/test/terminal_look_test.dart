import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/agent_swipe.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/phone/terminal_page.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/shared/theme/system_bars.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_look.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:xterm/xterm.dart' show TerminalView;

import 'agent_pager_fixture.dart';

/// A [PagerConn] already through its handshake, so the page's open goes out at once.
class _HandshakenConn extends PagerConn {
  @override
  Future<void> waitUntilReady({required Duration timeout}) async {}
}

/// Keeps its State, so a test can tell a repaint from a remount.
class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  Color? ground;

  @override
  Widget build(BuildContext context) {
    ground = Tty.of(context).ground;
    return const SizedBox.expand();
  }
}

/// Settings' Theme turns every screen light but the terminal's page, which keeps the dark side
/// ([TerminalLook]): its chrome, its screen, its tokens, Material's theme and the status bar. A
/// sheet opened from it is the app's, like every other screen.
void main() {
  final paper = HarnessPalette.paper;
  final graphite = HarnessPalette.graphite;

  /// Light, chosen in Theme, as `applyAppearance` leaves it: the app on Paper, the terminal on
  /// Graphite.
  void themeLight() {
    AppTheme.palette.value = paper;
    AppTheme.brightness.value = Brightness.light;
    AppTheme.terminalPaletteOverride.value = graphite;
  }

  tearDown(() {
    AppTheme.palette.value = graphite;
    AppTheme.brightness.value = Brightness.dark;
    AppTheme.terminalPaletteOverride.value = null;
  });

  /// [home] as `HarnessApp` mounts it: the app's theme for the palette on, under the scope that
  /// makes `AppTheme.watch` work.
  Widget app(Widget home) => BrightnessScope(
    child: MaterialApp(
      theme: buildAppTheme(brightness: AppTheme.palette.value.brightness),
      home: home,
    ),
  );

  BuildContext? reached;
  Widget probe() => Builder(
    builder: (context) {
      reached = context;
      return const SizedBox.expand();
    },
  );

  testWidgets("off a terminal's page, everything reads the app's palette", (
    tester,
  ) async {
    themeLight();
    await tester.pumpWidget(app(probe()));
    final context = reached!;

    expect(TerminalLook.on(context), isFalse);
    expect(TerminalLook.paletteOf(context), paper);
    expect(
      TerminalLook.read(context, () => AppPalette.windowBg),
      paper.background,
    );
    expect(Tty.of(context).ground, paper.background);
    expect(TerminalLook.outside(context), same(context));
  });

  testWidgets("on one, the terminal's: Tty, the tokens, Material's theme and "
      'the status bar', (tester) async {
    themeLight();
    await tester.pumpWidget(app(TerminalLook(child: probe())));
    final context = reached!;

    expect(TerminalLook.on(context), isTrue);
    expect(TerminalLook.paletteOf(context), graphite);
    expect(Tty.of(context).ground, graphite.background);
    expect(Tty.of(context).isLight, isFalse);
    expect(Theme.of(context).brightness, Brightness.dark);
    expect(Theme.of(context).colorScheme.surface, graphite.background);
    expect(
      tester
          .widget<AnnotatedRegion<SystemUiOverlayStyle>>(
            find.descendant(
              of: find.byType(TerminalLook),
              matching: find.byType(AnnotatedRegion<SystemUiOverlayStyle>),
            ),
          )
          .value,
      systemBarsFor(Brightness.dark),
      reason: 'light icons over the dark page',
    );

    var broadcasts = 0;
    void heard() => broadcasts++;
    AppTheme.palette.addListener(heard);
    AppTheme.brightness.addListener(heard);
    addTearDown(() {
      AppTheme.palette.removeListener(heard);
      AppTheme.brightness.removeListener(heard);
    });
    expect(
      TerminalLook.read(
        context,
        () => (AppPalette.windowBg, AppPalette.textPrimary),
      ),
      (
        graphite.background,
        AppTheme.as(Brightness.dark, () => AppPalette.textPrimary),
      ),
    );
    expect(AppTheme.palette.value, paper, reason: 'put back');
    expect(AppTheme.brightness.value, Brightness.light, reason: 'put back');
    expect(broadcasts, 0, reason: 'a read is not a change');
  });

  testWidgets('the palettes agreeing — App colors, or Dark — it changes '
      'nothing', (tester) async {
    await tester.pumpWidget(app(TerminalLook(child: probe())));
    final context = reached!;

    expect(TerminalLook.paletteOf(context), graphite);
    expect(Theme.of(context).brightness, Brightness.dark);
    expect(
      TerminalLook.read(context, () => AppPalette.windowBg),
      graphite.background,
    );

    // App colors' Paper dresses the terminal too, as it always has.
    AppTheme.palette.value = paper;
    AppTheme.brightness.value = Brightness.light;
    await tester.pump();
    expect(TerminalLook.paletteOf(context), paper);
    expect(Tty.of(context).ground, paper.background);
  });

  testWidgets('a Theme switched under an open terminal repaints it and never '
      'remounts it', (tester) async {
    await tester.pumpWidget(app(const TerminalLook(child: _Probe())));
    final state = tester.state<_ProbeState>(find.byType(_Probe));
    expect(state.ground, graphite.background);

    themeLight();
    await tester.pump();
    expect(tester.state(find.byType(_Probe)), same(state));
    expect(state.ground, graphite.background, reason: 'still dark');

    // Back to App colors' Paper: the terminal follows the app again.
    AppTheme.terminalPaletteOverride.value = null;
    await tester.pump();
    expect(tester.state(find.byType(_Probe)), same(state));
    expect(state.ground, paper.background);
  });

  testWidgets("a sheet opened from the page is the app's, not the page's", (
    tester,
  ) async {
    themeLight();
    await tester.pumpWidget(
      app(
        Scaffold(
          body: TerminalLook(
            child: Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () => showPhoneSheet(
                    context,
                    title: 'Menu',
                    actions: [
                      PhoneSheetAction(
                        icon: LucideIcons.pencil300,
                        label: 'Rename',
                        onTap: () {},
                      ),
                    ],
                  ),
                  child: const Text('open'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    final page = tester.element(find.text('open'));
    expect(Theme.of(page).brightness, Brightness.dark);
    final outside = TerminalLook.outside(page);
    expect(TerminalLook.on(outside), isFalse);
    expect(Theme.of(outside).brightness, Brightness.light);

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    final sheet = tester.element(find.text('Rename'));
    expect(TerminalLook.on(sheet), isFalse);
    expect(
      Theme.of(sheet).brightness,
      Brightness.light,
      reason: "not the page's theme, carried across",
    );
    expect(Tty.of(sheet).ground, paper.background);
    expect(
      tester.widget<BottomSheet>(find.byType(BottomSheet)).backgroundColor,
      paper.background,
      reason: "the sheet's ground is the app's too",
    );
  });

  group("an agent's page", () {
    Future<AppNotifier> pumpPager(WidgetTester tester) async {
      final app = pagerApp(_HandshakenConn());
      addTearDown(app.dispose);
      final list = pagerList(app);
      await liveAgent(app, 'b');
      await tester.pumpWidget(
        BrightnessScope(
          child: MaterialApp(
            theme: buildAppTheme(brightness: AppTheme.palette.value.brightness),
            home: AgentSwipeHost(
              notifier: app,
              machineId: 'm',
              agentId: 'b',
              neighbours: list,
            ),
          ),
        ),
      );
      await tester.pump();
      return app;
    }

    /// Past the keyframe's ack and the view's first resize — timers the binding fails a test for
    /// leaving behind.
    Future<void> settle(WidgetTester tester) async {
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
    }

    Color? pageGround(WidgetTester tester) => tester
        .widget<Scaffold>(
          find
              .descendant(
                of: find.byType(TerminalPage),
                matching: find.byType(Scaffold),
              )
              .first,
        )
        .backgroundColor;

    Color screenGround(WidgetTester tester) => tester
        .widget<TerminalView>(find.byType(TerminalView).first)
        .theme
        .background;

    testWidgets('stays dark in an app Theme turned light', (tester) async {
      themeLight();
      await pumpPager(tester);

      expect(find.byType(TerminalLook), findsOneWidget);
      expect(pageGround(tester), graphite.background);
      expect(screenGround(tester), graphite.background);
      final header = tester.element(find.byType(TerminalPage).first);
      expect(Tty.of(header).ground, graphite.background);
      expect(Theme.of(header).brightness, Brightness.dark);
      await settle(tester);
    });

    testWidgets("wears App colors' Paper, as before Theme existed", (
      tester,
    ) async {
      AppTheme.palette.value = paper;
      AppTheme.brightness.value = Brightness.light;
      await pumpPager(tester);

      expect(pageGround(tester), paper.background);
      expect(screenGround(tester), paper.background);
      await settle(tester);
    });
  });
}
