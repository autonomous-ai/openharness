import 'core/app_version.dart';

import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'
    show kIsWeb, LicenseRegistry, LicenseEntryWithLineBreaks;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'core/crash_log.dart';
import 'core/desktop_window.dart';
import 'core/linux_app_image.dart';
import 'screens/login_screen.dart';
import 'state/app_state.dart';
import 'stats/stats_lifecycle.dart';
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
import 'widgets/linux_menu_bar.dart';
import 'core/startup.dart';
import 'logging/app_log.dart';
import 'logging/install.dart';
import 'shortcuts/app_keymap.dart';
import 'shortcuts/keyboard_practice.dart';
import 'widgets/shortcuts_sheet.dart';
import 'widgets/new_device_notice.dart';
import 'widgets/update_notice.dart';
import 'widgets/window_chrome.dart';
import 'sharing/shared_agent_location.dart';
import 'branding/boot_splash.dart';
import 'sharing/shared_agent_page.dart';
import 'viewer/viewer_location.dart';
import 'viewer/viewer_page.dart';

/// The screen an app puts up once someone is signed in — the desktop's swarm of
/// panes, or the phone's one-agent-at-a-time shell. It is the only thing the two
/// entry points disagree about; everything below is shared.
typedef AuthenticatedScreenBuilder = Widget Function(AppNotifier app);

/// What a host draws around every screen of the app, sign-in included. The
/// desktop draws nothing; a browser build stands its store bar over the app.
typedef AppFrameBuilder = Widget Function(Widget app);

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

  /// See [AppFrameBuilder]; none leaves the app unframed.
  AppFrameBuilder? frame,

  /// A viewer build's second wire to each machine (see
  /// [TerminalTransportPlugin]); the desktop passes none.
  TerminalTransportPluginFactory? transportPlugins,
}) async {
  // Share links and OAuth own the browser URL. Flutter's default hash routing would
  // erase the share's pinned identity on the first navigation or window resize.
  if (kIsWeb) setUrlStrategy(null);
  WidgetsFlutterBinding.ensureInitialized();
  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks([
      'Roboto Mono',
    ], await rootBundle.loadString('assets/fonts/roboto-mono/OFL.txt'));
  });
  harnessTransportPlugins = transportPlugins;
  // Before anything else can fail. The file sinks come first so CrashLog's own
  // install has somewhere to mirror to — see CrashLog.record.
  installFileLogs();
  CrashLog.install();
  appLog.info('app', 'launched');
  final keymap = AppKeymap(store: kIsWeb ? null : AppKeymap.fileStore());
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
        frame: frame,
      ),
    ),
  );
  // After the first frame is on its way: a launcher entry is not worth
  // holding the window up for.
  unawaited(registerAppImageLauncher());
}

class HarnessApp extends StatelessWidget {
  const HarnessApp({
    super.key,
    this.keymap,
    required this.authenticatedScreen,
    this.frame,
  });
  final AppKeymap? keymap;
  final AuthenticatedScreenBuilder authenticatedScreen;
  final AppFrameBuilder? frame;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([appearancePrefsStore, terminalFontStore]),
      builder: (context, _) => _app(appearancePrefsStore.value),
    );
  }

  Widget _app(AppearancePrefs prefs) {
    grid.AppTheme.palette.value = prefs.palette;
    return MaterialApp(
      title: 'Harness',
      // OAuth callback paths are consumed by the sign-in adapter during boot.
      initialRoute: '/',
      themeAnimationDuration: Duration.zero,
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
      // The chosen palette owns the appearance; platform text scaling remains
      // available to app controls.
      theme: grid.buildAppTheme(brightness: prefs.palette.brightness),
      highContrastTheme: grid.buildAppTheme(
        brightness: prefs.palette.brightness,
        highContrast: true,
      ),
      // Desktop forms respect the platform's text size. Fixed-grid terminal
      // surfaces own their no-scaling boundary alongside terminal zoom.
      builder: (context, child) {
        final app = child ?? const SizedBox.shrink();
        final framed = frame?.call(app) ?? app;
        // The chosen boot logo lights up once on a cold launch while the app
        // builds underneath (lib/branding/boot_splash.dart); off by default.
        return BootSplash(
          child: _GridTokenScope(
            child: keymap == null
                ? framed
                : KeymapProvider(keymap: keymap!, child: framed),
          ),
        );
      },
      home: StatsLifecycle(
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
/// Set from the palette rather than read from `Theme.of(context)`: the palette
/// is where light or dark is chosen, and [HarnessApp] builds the theme from the
/// same value, so the two cannot disagree.
class _GridTokenScope extends StatelessWidget {
  const _GridTokenScope({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.brightness.value = grid.AppTheme.palette.value.brightness;
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
  SharedAgentLocation? _sharedLocation;

  @override
  void initState() {
    super.initState();
    if (kIsWeb) _sharedLocation = SharedAgentLocation.parse(Uri.base);
    WidgetsBinding.instance.addObserver(this);
    _appMenuChannel.setMethodCallHandler(_onAppMenu);
  }

  @override
  void dispose() {
    flushAppLog();
    WidgetsBinding.instance.removeObserver(this);
    _appMenuChannel.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) flushAppLog();
  }

  @override
  Future<AppExitResponse> didRequestAppExit() async {
    final app = ref.read(appStateProvider);
    // A sign-in still waiting on the browser or a phone ends with the app: its
    // CLI would otherwise wait on, holding the lock the next sign-in needs.
    if (app.canCancelLogin) app.cancelLogin();
    // Save the final arrangement, with a bound so an unavailable disk cannot
    // trap the user in the app. Input and tab switching never wait for disk.
    try {
      await app.flushPaneLayout().timeout(
        const Duration(seconds: 1),
        onTimeout: () {},
      );
    } finally {
      flushAppLog();
    }
    return AppExitResponse.exit;
  }

  Future<void> _onAppMenu(MethodCall call) async {
    await runAppMenuAction(call.method);
  }

  /// Runs one app-menu action.
  ///
  /// The macOS native menu reports over `harness/app_menu`; the Linux menu bar
  /// ([LinuxMenuBar]) fires the same strings directly, so one switch serves
  /// both platforms.
  Future<void> runAppMenuAction(String action) async {
    if (!mounted) return;
    switch (action) {
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
      case 'showAbout':
        // macOS shows AppKit's standard About panel; the Linux bar's row lands
        // here, with the version the Linux release stamps beside the binary.
        final version = await runningAppVersion();
        if (!mounted) return;
        await _menuDialog(
          () async => showAboutDialog(
            context: context,
            applicationName: 'Harness',
            applicationVersion: version,
          ),
        );
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
        Widget screen;
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
            final viewerLocation = kIsWeb
                ? ViewerLocation.parse(Uri.base)
                : null;
            screen = viewerLocation != null
                ? ViewerPage(app: app, location: viewerLocation)
                : kIsWeb && ViewerLocation.isRoute(Uri.base)
                ? const Center(
                    child: Text(
                      'This viewer link is incomplete. Run hn view again.',
                    ),
                  )
                : widget.authenticatedScreen(app);
        }
        // Preserve the fragment pin while dialogs navigate; an OAuth callback can restore it later.
        if (kIsWeb) _sharedLocation ??= SharedAgentLocation.parse(Uri.base);
        final shared = _sharedLocation;
        if (shared != null) {
          screen = SharedAgentPage(app: app, location: shared);
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
        // Device bands, most urgent first: a removal (red before neutral), a key that joined and left,
        // a new device, a held computer id. The mobile app stacks them in the same order.
        return Column(
          children: [
            // The app's commands as a menu strip (Linux only; macOS carries
            // them in its native menu bar, and this renders nothing there).
            LinuxMenuBar(onAction: runAppMenuAction),
            if (app.hasAvailableUpdate &&
                app.status != AppStatus.bootstrapping &&
                app.status != AppStatus.checkingEnvironment &&
                app.status != AppStatus.preparingEnvironment)
              UpdateNotice(notifier: app),
            if (app.visibleDeviceRemovals.isNotEmpty &&
                app.status == AppStatus.authenticated)
              DeviceRemovalNoticeBand(notifier: app),
            if (app.departedDevices.isNotEmpty &&
                app.status == AppStatus.authenticated)
              DeviceDepartedNoticeBand(notifier: app),
            if (app.newDevices.isNotEmpty &&
                app.status == AppStatus.authenticated)
              NewDeviceNotice(notifier: app),
            if (app.deviceConflict != null &&
                app.status == AppStatus.authenticated)
              DeviceConflictNoticeBand(notifier: app),
            Expanded(child: framed),
          ],
        );
      },
    );
  }
}
