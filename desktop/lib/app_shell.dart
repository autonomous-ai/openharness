import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'
    show kIsWeb, LicenseRegistry, LicenseEntryWithLineBreaks;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

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
import 'core/test_run.dart';
import 'core/web_form_factor.dart';
import 'logging/app_log.dart';
import 'logging/install.dart';
import 'shortcuts/app_keymap.dart';
import 'shortcuts/keyboard_practice.dart';
import 'widgets/shortcuts_sheet.dart';
import 'widgets/update_notice.dart';
import 'widgets/window_chrome.dart';
import 'sharing/shared_agent_location.dart';
import 'sharing/shared_agent_page.dart';
import 'viewer/pending_pair.dart';
import 'viewer/pending_pair_store.dart';
import 'widgets/add_machine_dialog.dart';

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
      // Harness Desktop is dark-only: one theme, no `darkTheme`/`themeMode` to
      // resolve between.
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      // The chosen point size is already applied to every style and terminal
      // cell. A second UI scale would make the chrome disagree with the grid.
      builder: (context, child) => MediaQuery.withNoTextScaling(
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
  SharedAgentLocation? _sharedLocation;

  /// A machine's QR opened here by a phone's camera (`/pair#…`), held across sign-in
  /// (`viewer/pending_pair_store.dart`) and asked about once this tab is signed in.
  PendingPair? _pendingPair;
  bool _pendingPairAsked = false;

  @override
  void initState() {
    super.initState();
    if (kIsWeb) {
      // Before anything else reads the URL: the code leaves the address bar here.
      _pendingPair = const PendingPairStore().capture(DateTime.now());
    }
    if (kIsWeb) _sharedLocation = SharedAgentLocation.parse(Uri.base);
    WidgetsBinding.instance.addObserver(this);
    _appMenuChannel.setMethodCallHandler(_onAppMenu);
  }

  ({String name, String? fingerprint})? _pairingWith() {
    final pending = _pendingPair;
    if (pending == null || pending.isExpired(DateTime.now())) return null;
    final fp = pending.code.fingerprint;
    return (
      name: pending.code.hostname ?? 'this machine',
      fingerprint: fp == null ? null : spacedFingerprint(fp),
    );
  }

  /// Whether this visit to the web sign-in page already began a sign-in by phone. Once per visit:
  /// someone who cancels, or picks SSO, is not sent back to the QR behind their back.
  bool _webQrStarted = false;

  /// A web desktop's sign-in page opens on its QR — nothing to press first. Not a phone's browser
  /// (it approves, and cannot scan itself), not a tab opened by a machine's QR or a shared link
  /// (those arrive to do something else), and never under `flutter test`.
  void _startWebQr(AppNotifier app) {
    if (_webQrStarted || !kIsWeb || isMobileWeb || kUnderTest) return;
    if (_pairingWith() != null || _sharedLocation != null) return;
    if (app.signingIn || app.signingOut || app.lastError != null) return;
    _webQrStarted = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && app.status == AppStatus.unauthenticated) {
        unawaited(app.login(qr: true));
      }
    });
  }

  /// The group join after a web sign-in by phone has settled: the page moves on to home by itself —
  /// a moment to read "reaches N machines", a little longer for a problem, which the Machines list
  /// can still fix from there.
  bool _phoneLinkHolding = false;
  void _holdPhoneLink(AppNotifier app) {
    final link = app.phoneLink;
    if (_phoneLinkHolding || link == null || !link.settled) return;
    _phoneLinkHolding = true;
    final failed = link.stage == PhoneLinkStage.failed;
    Timer(Duration(milliseconds: failed ? 4000 : 1500), () {
      _phoneLinkHolding = false;
      if (mounted) app.dismissPhoneLink();
    });
  }

  /// Signed in (or just back from SSO) with a scanned machine code waiting: ask about it, once.
  void _askAboutPendingPair(AppNotifier app) {
    final pending = _pendingPair;
    if (pending == null || _pendingPairAsked) return;
    _pendingPairAsked = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      const PendingPairStore().clear();
      _pendingPair = null;
      unawaited(
        showAddMachineDialog(
          context,
          app,
          pending.code,
          expired: pending.isExpired(DateTime.now()),
        ),
      );
    });
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
                ? LoginScreen(notifier: app, pairingWith: _pairingWith())
                : BootstrappingScreen(statusMessage: app.bootStatusMessage);
          case AppStatus.checkingEnvironment:
            screen = EnvironmentPreflightScreen(
              readiness: app.environmentReadiness,
            );
          case AppStatus.preparingEnvironment:
            screen = EnvironmentSetupScreen(notifier: app);
          case AppStatus.unauthenticated:
            screen = LoginScreen(notifier: app, pairingWith: _pairingWith());
            _startWebQr(app);
          case AppStatus.authenticated when kIsWeb && app.phoneLink != null:
            // Signed in by phone: the sign-in page stays up through the link that follows and
            // moves on once it is done — as the desktop app's sign-in sheet does.
            screen = LoginScreen(notifier: app, onClose: app.dismissPhoneLink);
            _holdPhoneLink(app);
          case AppStatus.authenticated:
            _webQrStarted = false;
            screen = widget.authenticatedScreen(app);
            _askAboutPendingPair(app);
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
