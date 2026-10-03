import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'stats/stats_lifecycle.dart';
import 'core/crash_log.dart';
import 'state/app_state.dart';
import 'viewer/viewer_services.dart';
import 'ws/terminal_transport_plugin.dart';
import 'shared/theme/app_theme.dart' as grid;
import 'shared/theme/appearance_prefs_store.dart';
import 'core/startup.dart';
import 'logging/app_log.dart';
import 'logging/install.dart';
import 'logging/startup_trace.dart';

/// A screen the app puts up for one of its states — signed in, signed out, starting.
typedef AuthenticatedScreenBuilder = Widget Function(AppNotifier app);

/// Everything the app does before its first frame: file logs, the crash log and
/// the saved appearance.
///
/// Lives here rather than in either `main.dart` so the two cannot drift — the
/// mobile app is a separate package (`../mobile`) that depends on this one, and
/// a second copy of this preamble is exactly how the last mobile build ended up
/// stranded from the desktop it shared a codebase with.
Future<void> startHarness({
  required AuthenticatedScreenBuilder authenticatedScreen,

  /// The signed-out screen — the phone's welcome.
  required AuthenticatedScreenBuilder signedOutScreen,

  /// The screen while the app starts.
  required AuthenticatedScreenBuilder bootScreen,

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
  // Reads the clock, which starts it — from here every `startup` line in the log
  // is an offset into THIS launch. Touched before any awaited work so the origin
  // is the entrypoint rather than whatever step happens to mark itself first.
  StartupTrace.mark('startHarness');
  // ⚠️ **No keymap.** The desktop loads its keyboard configuration here, a file
  // and its watchers, beside the appearance. Nothing on the phone reads a keymap
  // — no key is ever matched against one — so the file a touchscreen could not
  // have edited is not read either.
  await StartupTrace.time('settings.load', loadPersistedSettings);
  runApp(
    ProviderScope(
      child: HarnessApp(
        authenticatedScreen: authenticatedScreen,
        signedOutScreen: signedOutScreen,
        bootScreen: bootScreen,
      ),
    ),
  );
  StartupTrace.mark('runApp');
  // The frame itself, not the call that scheduled it: `runApp` returns before
  // anything is rasterised, so the gap between these two marks is the build and
  // paint of the first screen — the part a person actually waits through while
  // looking at a blank window.
  WidgetsBinding.instance.addPostFrameCallback(
    (_) => StartupTrace.mark('firstFrame'),
  );
}

class HarnessApp extends StatelessWidget {
  const HarnessApp({
    super.key,
    required this.authenticatedScreen,
    required this.signedOutScreen,
    required this.bootScreen,
  });
  final AuthenticatedScreenBuilder authenticatedScreen;
  final AuthenticatedScreenBuilder signedOutScreen;
  final AuthenticatedScreenBuilder bootScreen;

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
      title: 'Harness',
      // The corner ribbon stays. A phone carries both builds under one icon and
      // one name, and telling them apart otherwise means reading `dumpsys` over
      // a cable — by which point a bug has already been reported against the
      // wrong build. Flutter draws it in DEBUG ONLY, so a release ships clean
      // without anyone having to remember to switch this back. Off only for a
      // recording of the app (`--dart-define=HARNESS_RECORDING=true`), which a
      // simulator can only make from a debug build.
      debugShowCheckedModeBanner: !const bool.fromEnvironment(
        'HARNESS_RECORDING',
      ),
      // The design system's own `buildAppTheme` — see the note where a second,
      // hand-written `ThemeData` used to shadow it, in `lib/theme/app_theme.dart`.
      // One theme, no `darkTheme`/`themeMode` to resolve between: the chosen
      // palette says whether it is light or dark.
      theme: grid.buildAppTheme(brightness: prefs.palette.brightness),
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
      // ⚠️ The terminal is fenced out of this — see `terminal_panel.dart`
      // (`textScaler: TextScaler.noScaling`) and `engine_identity.dart`. The
      // terminal keeps its own font settings because its type is a grid a remote
      // program draws into.
      //
      // Outermost inside `builder`, with `_GridTokenScope` inside it: the clamp
      // has to be an ancestor of everything that lays out text, while the scope
      // only reads `Theme.of`, which comes from above the builder either way.
      builder: (context, child) => MediaQuery.withClampedTextScaling(
        minScaleFactor: scale,
        maxScaleFactor: scale,
        child: _GridTokenScope(child: child ?? const SizedBox.shrink()),
      ),
      home: StatsLifecycle(
        child: RootShell(
          authenticatedScreen: authenticatedScreen,
          signedOutScreen: signedOutScreen,
          bootScreen: bootScreen,
        ),
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
/// Set from the palette rather than read from `Theme.of(context)`: the palette
/// is where light or dark is chosen, and [HarnessApp] builds the theme from the
/// same value, so the two cannot disagree.
///
/// The status and navigation bar icons follow it too. Nothing else sets them —
/// the phone draws no `AppBar` — so without this they kept the OS's own style
/// and went dark-on-dark or light-on-light with the app.
class _GridTokenScope extends StatelessWidget {
  const _GridTokenScope({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final brightness = grid.AppTheme.palette.value.brightness;
    grid.AppTheme.brightness.value = brightness;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: systemBarsFor(brightness),
      child: grid.BrightnessScope(child: child),
    );
  }
}

/// The system bars' style for an app of [brightness]: icons that contrast with it, over the
/// transparent bars `main.dart` draws edge to edge under. The colours are restated because an
/// [AnnotatedRegion]'s style replaces the one set at launch.
SystemUiOverlayStyle systemBarsFor(Brightness brightness) {
  // The icons are the opposite of the app; iOS's `statusBarBrightness` names the GROUND instead.
  final icons = brightness == Brightness.dark
      ? Brightness.light
      : Brightness.dark;
  return SystemUiOverlayStyle(
    statusBarColor: const Color(0x00000000),
    systemNavigationBarColor: const Color(0x00000000),
    statusBarIconBrightness: icons,
    systemNavigationBarIconBrightness: icons,
    statusBarBrightness: brightness,
  );
}

/// Which screen the app's state calls for.
///
/// ⚠️ **What a desktop window also had here, and why it is gone.** The macOS application menu
/// (`harness/app_menu`: check for updates, flash firmware, layouts, shortcuts, terminal font
/// size), the update band, and the two first-run provisioning screens. No iOS or Android runner
/// registers that channel, and a viewer build never provisions or self-updates — an app the store
/// updates installs nothing — so neither the provisioner nor the updater is in this package.
class RootShell extends ConsumerWidget {
  const RootShell({
    super.key,
    required this.authenticatedScreen,
    required this.signedOutScreen,
    required this.bootScreen,
  });

  final AuthenticatedScreenBuilder authenticatedScreen;
  final AuthenticatedScreenBuilder signedOutScreen;
  final AuthenticatedScreenBuilder bootScreen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final app = ref.watch(appStateProvider);
    return ListenableBuilder(
      listenable: app,
      builder: (context, _) => switch (app.status) {
        // `bootstrapping` covers two unrelated moments: the app starting
        // cold, and a sign-in the user just began. The second keeps the
        // signed-out screen, which carries the wait as a state of its own
        // button; swapping the window for a separate screen there was a
        // hard cut in the middle of a flow, and it is why that button's
        // spinner was almost never seen. Keyed on `signingIn`, which spans
        // the whole of it — see [AppNotifier.signingIn].
        AppStatus.bootstrapping =>
          app.signingIn ? signedOutScreen(app) : bootScreen(app),
        AppStatus.unauthenticated => signedOutScreen(app),
        AppStatus.authenticated => authenticatedScreen(app),
      },
    );
  }
}
