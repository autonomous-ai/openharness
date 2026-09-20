import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'analytics/analytics_lifecycle.dart';
import 'core/crash_log.dart';
import 'core/desktop_window.dart';
import 'screens/login_screen.dart';
import 'state/app_state.dart';
import 'viewer/viewer_services.dart';
import 'ws/terminal_transport_plugin.dart';
import 'shared/theme/app_theme.dart' as grid;
import 'shared/theme/appearance_prefs_store.dart';
import 'terminal/terminal_font_store.dart';
import 'widgets/bootstrapping_screen.dart';
import 'widgets/layout_palette.dart';
import 'widgets/environment_preflight_screen.dart';
import 'widgets/environment_setup_screen.dart';
import 'widgets/export_logs_dialog.dart';
import 'widgets/flash_firmware_dialog.dart';
import 'core/startup.dart';
import 'logging/app_log.dart';
import 'logging/install.dart';
import 'shortcuts/app_keymap.dart';
import 'shortcuts/keyboard_practice.dart';
import 'widgets/shortcuts_sheet.dart';
import 'widgets/update_notice.dart';
import 'widgets/window_chrome.dart';

/// The screen an app puts up once someone is signed in — the desktop's swarm of
/// panes, or the phone's one-agent-at-a-time shell. It is the only thing the two
/// entry points disagree about; everything below is shared.
typedef AuthenticatedScreenBuilder = Widget Function(AppNotifier app);

/// Everything both entry points do before their first frame: file logs, the
/// crash log, the keyboard config, the saved appearance, and the native window
/// where there is one.
///
/// Lives here rather than in `main.dart` so every screen up to sign-in has one
/// definition of what precedes it. `../mobile` carries its own vendored copy of
/// this file — it depended on this package until it was made standalone — so a
/// change here that belongs on the phone too has to be carried across; the two
/// trees are otherwise byte-identical outside `lib/phone/` and `lib/p2p/`.
Future<void> startHarness({
  required AuthenticatedScreenBuilder authenticatedScreen,

  /// A viewer build's second wire to each machine (see
  /// [TerminalTransportPlugin]); the desktop passes none.
  TerminalTransportPluginFactory? transportPlugins,
}) async {
  WidgetsFlutterBinding.ensureInitialized();
  harnessTransportPlugins = transportPlugins;
  // Before anything else can fail. The file sinks come first so CrashLog's own
  // install has somewhere to mirror to — see CrashLog.record.
  installFileLogs();
  CrashLog.install();
  appLog.info('app', 'launched');
  final keymap = AppKeymap(store: AppKeymap.fileStore());
  // Keyboard configuration has its own file and watchers. It can load beside
  // the appearance, but both must be ready before the window becomes usable.
  await Future.wait([loadPersistedSettings(), keymap.start()]);
  // Apply the saved palette to native chrome as well as the Flutter theme.
  await configureDesktopWindow(palette: appearancePrefsStore.value.palette);
  runApp(
    ProviderScope(
      child: HarnessApp(
        keymap: keymap,
        authenticatedScreen: authenticatedScreen,
      ),
    ),
  );
}

class HarnessApp extends StatelessWidget {
  const HarnessApp({super.key, this.keymap, required this.authenticatedScreen});
  final AppKeymap? keymap;
  final AuthenticatedScreenBuilder authenticatedScreen;

  @override
  Widget build(BuildContext context) {
    // Rebuilds MaterialApp on a font/size change, which is what re-resolves
    // every Grid token with it.
    //
    // `buildAppTheme` bakes `AppControl.*Scaled` into plain numbers at the
    // moment it runs, so a UI size that changed without rebuilding this would
    // repaint nothing at all.
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: appearancePrefsStore,
      builder: (context, prefs, _) => _app(prefs),
    );
  }

  Widget _app(AppearancePrefs prefs) {
    grid.AppTheme.palette.value = prefs.palette;
    // ⚠️ ORDER MATTERS, and it is why this is a statement rather than something
    // tucked into the tree below: `buildAppTheme` reads `AppFont.sans` and
    // `AppControl.*Scaled`, so the settings have to be on `AppFont` BEFORE the
    // theme is built, in this same frame.
    //
    // Pushed through the notifier rather than calling `AppFont.apply` directly,
    // so widgets past a `const` boundary — which a top-down rebuild never
    // reaches — are marked dirty too.
    //
    // `codeSize` is passed through unchanged: code type is not on this screen
    // yet, and `apply` takes the whole set, so reading the current value back is
    // how "leave it alone" is spelled.
    final scale = prefs.uiSize / grid.AppFont.uiSizeDefault;
    grid.AppTheme.fonts.apply(
      uiFamily: prefs.uiFamily,
      uiScale: scale,
      codeSize: grid.AppFont.codeSize,
    );
    return MaterialApp(
      title: 'OpenHarness',
      // Flutter's DEBUG ribbon stays on a debug build: it is how a locally built
      // app is told apart from the installed release at a glance (owner,
      // 2026-09-16). It never appears in a release build whatever this says.
      // A preview capture that wants a clean corner passes
      // `--dart-define=HARNESS_CLEAN_PREVIEW=true` instead of turning it off
      // for everyone.
      debugShowCheckedModeBanner: !const bool.fromEnvironment(
        'HARNESS_CLEAN_PREVIEW',
      ),
      // The design system's own `buildAppTheme` — see the note where a second,
      // hand-written `ThemeData` used to shadow it, in `lib/theme/app_theme.dart`.
      // Harness Desktop is dark-only: one theme, no `darkTheme`/`themeMode` to
      // resolve between.
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      // The UI size reaches every `Text` as a text SCALE rather than as hundreds
      // of edited call sites. `withClampedTextScaling` with both bounds equal IS
      // the way to force a factor — MediaQuery has no "set the scale"
      // constructor that still inherits the platform's other metrics.
      //
      // ⚠️ It is a matched pair with the `AppControl.*Scaled` reads above, not a
      // separate nicety: those grow the BOXES and this grows the TYPE, and
      // `AppControl.fontSize` deliberately has no scaled twin so that the factor
      // is applied exactly once. Ship one without the other and a 19px setting
      // gives 19px-tall buttons wrapped around 13pt labels.
      //
      // ⚠️ The terminal is fenced out of this at five seams — see
      // `terminal_panel.dart`, `terminal_composer.dart`, `engine_identity.dart`
      // and `terminal_section.dart`, and the regression test in
      // `test/terminal_ui_scale_isolation_test.dart`. The terminal keeps its own
      // font settings because its type is a grid a remote program draws into.
      //
      // Outermost inside `builder`, with `_GridTokenScope` inside it: the clamp
      // has to be an ancestor of everything that lays out text, while the scope
      // only reads `Theme.of`, which comes from above the builder either way.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        minScaleFactor: scale,
        maxScaleFactor: scale,
        child: _GridTokenScope(
          child: keymap == null
              ? child ?? const SizedBox.shrink()
              : KeymapProvider(
                  keymap: keymap!,
                  child: child ?? const SizedBox.shrink(),
                ),
        ),
      ),
      home: AnalyticsLifecycle(
        child: RootShell(authenticatedScreen: authenticatedScreen),
      ),
    );
  }
}

/// Carries Grid's design tokens past this app's `const` chrome.
///
/// A `const` widget is reference-identical across its parent's rebuild, so a
/// top-down rebuild never reaches one — it would keep the palette it first
/// mounted with. [grid.BrightnessScope] marks the ones that called
/// `AppTheme.watch` dirty directly, across that boundary.
///
/// Pinned to [Brightness.dark] rather than read from `Theme.of(context)`:
/// Harness Desktop is dark-only, and there is no other theme for `Theme.of`
/// to ever resolve to here.
class _GridTokenScope extends StatelessWidget {
  const _GridTokenScope({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.brightness.value = Brightness.dark;
    return grid.BrightnessScope(child: child);
  }
}

/// Carries "Check for Updates…" from the macOS application menu into Dart.
///
/// The item is installed natively (MainFlutterWindow.swift) so the rest of the
/// menu bar keeps coming from the nib; all this side does is act on the tap.
const _appMenuChannel = MethodChannel('harness/app_menu');

class RootShell extends ConsumerStatefulWidget {
  const RootShell({super.key, required this.authenticatedScreen});

  final AuthenticatedScreenBuilder authenticatedScreen;

  @override
  ConsumerState<RootShell> createState() => _RootShellState();
}

class _RootShellState extends ConsumerState<RootShell>
    with WidgetsBindingObserver {
  bool _menuDialogOpen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _appMenuChannel.setMethodCallHandler(_onAppMenu);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _appMenuChannel.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  Future<AppExitResponse> didRequestAppExit() async {
    // Save the final arrangement, with a bound so an unavailable disk cannot
    // trap the user in the app. Input and tab switching never wait for disk.
    await ref
        .read(appStateProvider)
        .flushPaneLayout()
        .timeout(const Duration(seconds: 1), onTimeout: () {});
    return AppExitResponse.exit;
  }

  Future<void> _onAppMenu(MethodCall call) async {
    if (!mounted) return;
    switch (call.method) {
      case 'checkForUpdates':
        final app = ref.read(appStateProvider);
        await _menuDialog(() => checkForUpdatesAndShowResult(context, app));
      case 'flashFirmware':
        await _menuDialog(() => showFlashFirmwareDialog(context));
      case 'exportLogs':
        await _menuDialog(() => showExportLogsDialog(context));
      case 'showLayout':
        if (advanceLayoutPalette()) return;
        await _menuDialog(
          () => showLayoutPalette(context, ref.read(appStateProvider)),
        );
      case 'showShortcuts':
        await _menuDialog(() => showShortcutsSheet(context));
      case 'keyboardPractice':
        await _menuDialog(() => showKeyboardPractice(context));
      case 'increaseTerminalFontSize':
        await terminalFontStore.increaseSize();
      case 'decreaseTerminalFontSize':
        await terminalFontStore.decreaseSize();
      case 'resetTerminalFontSize':
        await terminalFontStore.reset();
    }
  }

  Future<void> _menuDialog(Future<void> Function() action) async {
    if (_menuDialogOpen || ModalRoute.isCurrentOf(context) == false) return;
    // Reserve before the first frame too: held menu shortcuts can arrive
    // before the new dialog has changed the route's current state.
    _menuDialogOpen = true;
    try {
      await action();
    } finally {
      _menuDialogOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = ref.watch(appStateProvider);
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) {
        final Widget screen;
        switch (app.status) {
          case AppStatus.bootstrapping:
            // `bootstrapping` covers two unrelated moments: the app starting
            // cold, and a sign-in the user just began. The second keeps
            // LoginScreen, which carries the wait as a state of its own
            // button; swapping the window for a separate screen there was a
            // hard cut in the middle of a flow, and it is why that button's
            // spinner was almost never seen.
            //
            // ⚠️ Keyed on `signingIn`, NOT on `pendingAuthorizeUrl`. The URL
            // only exists for the middle stretch of the flow — the CLI has to
            // start before it can print one, and it is cleared again while
            // the post-login restore is still running — so keying on it blew
            // the user's own screen away twice per sign-in: once on the click
            // and again on success.
            screen = app.signingIn
                ? LoginScreen(notifier: app)
                : BootstrappingScreen(statusMessage: app.bootStatusMessage);
          case AppStatus.checkingEnvironment:
            screen = EnvironmentPreflightScreen(
              readiness: app.environmentReadiness,
            );
          case AppStatus.preparingEnvironment:
            screen = EnvironmentSetupScreen(notifier: app);
          case AppStatus.unauthenticated:
            screen = LoginScreen(notifier: app);
          case AppStatus.authenticated:
            screen = widget.authenticatedScreen(app);
        }
        // Only the home shell carries its own drag handle and traffic-light
        // clearance (the rail's head). Every other screen fills the window
        // with a centred card, so the strip goes over it here, once, instead
        // of inside each of them.
        final framed = app.status == AppStatus.authenticated
            ? screen
            : FullWindowScreen(child: screen);
        // The band takes a row of its own rather than floating over one. As an
        // overlay it landed on the rail's head — covering the wordmark and the
        // three buttons beside it, which is the one strip of this window that
        // must stay reachable.
        return Column(
          children: [
            if (app.hasAvailableUpdate &&
                app.status != AppStatus.bootstrapping &&
                app.status != AppStatus.checkingEnvironment &&
                app.status != AppStatus.preparingEnvironment)
              UpdateNotice(notifier: app),
            Expanded(child: framed),
          ],
        );
      },
    );
  }
}
