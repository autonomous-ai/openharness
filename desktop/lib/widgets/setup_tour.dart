import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../bootstrap/environment_provisioner.dart';
import '../bootstrap/setup_progress.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_icon_button.dart';
import '../shortcuts/app_shortcuts.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../state/app_state.dart';
import 'environment_setup_screen.dart';
import 'setup_tour_art.dart';
import 'window_chrome.dart';

/// The welcome tour: seven slides on what Harness does.
///
/// A fresh computer sees it while setup installs with nobody at the keyboard
/// ([SetupTourScreen]), with the install as one line under it, like an OS
/// installer; Help ▸ Welcome Tour shows the slides alone ([showWelcomeTour]).
/// Design: `docs/research/2026-10-08-onboarding-redesign/index.html`, section 1.

/// Under every slide.
const tourTagline = 'All your machines. All your agents. One command center.';

/// How long a slide stays before the next; the tour loops.
const tourSlideDuration = Duration(seconds: 6);

/// One slide: a kicker, a title, two lines of copy and a picture.
@immutable
class TourSlide {
  const TourSlide({
    required this.kicker,
    required this.title,
    required this.copy,
    required this.artLabel,
    required this.art,
  });

  final String kicker;

  /// Two short lines, broken where the render breaks them.
  final String title;
  final String copy;

  /// What the picture shows, for a screen reader.
  final String artLabel;
  final WidgetBuilder art;
}

bool get _onMac => defaultTargetPlatform == TargetPlatform.macOS;

/// "Mac" on a Mac and "computer" elsewhere: the tour names the machine it is
/// setting up.
String get tourComputerNoun => _onMac ? 'Mac' : 'computer';

/// The install line under the slides.
String get setupTourInstallLine =>
    'Setting up Harness on this $tourComputerNoun';

/// The keycaps for the Cmd-P search, from the live default keymap, so Linux
/// (Alt, where the Mac takes ⌘) reads its own chord.
List<String> get tourSearchKeys {
  final command = harnessCommands.firstWhere(
    (command) => command.id == 'harnesses.list',
  );
  final keys = command.keys;
  return keys.isEmpty
      ? const ['⌘', 'P']
      : describeKeyStrokeKeys(KeyStroke.parse(keys.first));
}

/// The keycaps for New Harness (Cmd-N), the same way.
List<String> get tourNewHarnessKeys {
  for (final shortcut in appShortcuts()) {
    if (shortcut.action == ShortcutAction.newAgent) {
      return describeShortcutKeys(shortcut.activator);
    }
  }
  return const ['⌘', 'N'];
}

/// The seven slides, in order of importance. Copy is the approved render's.
List<TourSlide> tourSlides() {
  final search = tourSearchKeys;
  final create = tourNewHarnessKeys;
  final searchChord = search.join(chordKeySeparator);
  final createChord = create.join(chordKeySeparator);
  final computer = tourComputerNoun;
  return [
    TourSlide(
      kicker: 'Welcome to Harness',
      title: 'All your machines,\none window.',
      copy:
          'Your laptop, the desktop under your desk, a box in the cloud. Run '
          'agents on any of them and switch between them like tabs.',
      artLabel: 'Three machines connected to Harness on this $computer',
      art: (_) => TourMachinesArt(thisComputer: 'this $computer'),
    ),
    TourSlide(
      kicker: 'Every agent',
      title: 'All your agents,\nside by side.',
      copy:
          'Claude Code, Codex, OpenCode and a dozen more in one grid. Give '
          'each job to the agent that is best at it.',
      artLabel: 'Four agents working in a two by two grid',
      art: (_) => const TourAgentsArt(),
    ),
    TourSlide(
      kicker: 'Keyboard first',
      title: '$searchChord finds\nany harness.',
      copy:
          'One search over every harness on all your machines, with all your '
          "agents. A few letters, Return, you're in it.",
      artLabel: 'Search results from three machines and three agents',
      art: (_) => TourSearchArt(keys: search),
    ),
    TourSlide(
      kicker: 'Keyboard first',
      title: '$createChord starts\na new harness.',
      copy:
          'Any agent, on any of your machines, in any project. Pick them by '
          'keys, type what you want, press Return.',
      artLabel: 'The New Harness box with an agent, a machine and a project',
      art: (_) => TourNewHarnessArt(keys: create),
    ),
    TourSlide(
      kicker: 'Always there',
      title: 'Sessions that\nkeep going.',
      copy:
          'Close the lid, quit, restart. Every session on all your machines '
          'is where you left it, conversation and all.',
      artLabel: 'One conversation that carries on after a restart',
      art: (_) => TourSessionsArt(computer: _onMac ? 'Mac' : 'Computer'),
    ),
    TourSlide(
      kicker: 'On the go',
      title: 'Your agents\nin your pocket.',
      copy:
          'The Harness phone app shows every session on all your machines. '
          'When an agent needs you, answer from anywhere.',
      artLabel: 'The Harness phone app showing an agent that needs an answer',
      art: (_) => const TourPhoneArt(),
    ),
    TourSlide(
      kicker: 'On your desk',
      title: 'The Harness\ndevice.',
      copy:
          'It shows what every agent on all your machines is doing. Turn and '
          'press to answer the one that needs you.',
      artLabel: 'The Harness device on a desk',
      art: (_) => const TourDeviceArt(),
    ),
  ];
}

/// "about 42 s left", "about 2 min left".
String formatSetupLeft(Duration left) {
  final seconds = (left.inMilliseconds / 1000).ceil();
  if (seconds < 60) return 'about ${seconds < 1 ? 1 : seconds} s left';
  final minutes = (seconds / 60).round();
  return 'about $minutes min left';
}

/// The slides, full window, with the install line under them when there is
/// one.
class SetupTour extends StatefulWidget {
  const SetupTour({
    super.key,
    this.progress,
    this.onOpen,
    this.onRetry,
    this.onManual,
    this.details,
    this.onClose,
    this.slideDuration = tourSlideDuration,
  });

  /// The install to show under the slides. Null for Help ▸ Welcome Tour,
  /// which has no install line.
  final ValueListenable<SetupProgress>? progress;

  /// Called once, at the end of the slide on screen, after [progress] says
  /// done. There is no button for it: Harness opens by itself.
  final VoidCallback? onOpen;

  /// Restarts a failed setup. Null while that is not possible (a retry in
  /// flight).
  final VoidCallback? onRetry;

  /// Beside Retry on a failure: leave the tour for the setup screen's manual
  /// commands, the way out the setup screen has always offered when the
  /// automatic install keeps failing.
  final VoidCallback? onManual;

  /// What ▸ unfolds under the install line: the setup screen's step list and
  /// log ([EnvironmentSetupDetails]).
  final Widget? details;

  /// Shows a close button and lets Escape close the tour.
  final VoidCallback? onClose;

  final Duration slideDuration;

  @override
  State<SetupTour> createState() => _SetupTourState();
}

class _SetupTourState extends State<SetupTour> {
  late final List<TourSlide> _slides = tourSlides();
  final _focus = FocusNode(debugLabel: 'Welcome tour');
  var _index = 0;
  Timer? _timer;
  var _detailsOpen = false;
  var _wasFailed = false;
  var _opened = false;

  @override
  void initState() {
    super.initState();
    widget.progress?.addListener(_progressChanged);
    _wasFailed = widget.progress?.value.failed ?? false;
    _detailsOpen = _wasFailed;
    _restartTimer();
  }

  @override
  void didUpdateWidget(SetupTour old) {
    super.didUpdateWidget(old);
    if (old.progress != widget.progress) {
      old.progress?.removeListener(_progressChanged);
      widget.progress?.addListener(_progressChanged);
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.progress?.removeListener(_progressChanged);
    _focus.dispose();
    super.dispose();
  }

  void _progressChanged() {
    final failed = widget.progress?.value.failed ?? false;
    // A failure opens Details by itself, once: the log is what the person
    // needs next, and they may fold it away again.
    if (failed && !_wasFailed && mounted) setState(() => _detailsOpen = true);
    _wasFailed = failed;
  }

  void _restartTimer() {
    _timer?.cancel();
    _timer = Timer(widget.slideDuration, _slideEnded);
  }

  void _slideEnded() {
    if (!mounted) return;
    final onOpen = widget.onOpen;
    if (!_opened && onOpen != null && (widget.progress?.value.done ?? false)) {
      // Opened at the end of a slide rather than the moment setup finishes,
      // so the window never changes under someone mid-sentence.
      _opened = true;
      onOpen();
      return;
    }
    // Someone on a screen reader turns the slides themselves (arrows, the
    // dots): text that changes by itself every few seconds loses their place.
    if (MediaQuery.maybeAccessibleNavigationOf(context) ?? false) {
      _restartTimer();
      return;
    }
    _show(_index + 1);
  }

  void _show(int index) {
    setState(() => _index = index % _slides.length);
    _restartTimer();
  }

  void _next() => _show(_index + 1);
  void _previous() => _show(_index - 1 + _slides.length);

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final progress = widget.progress;
    final onClose = widget.onClose;
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.arrowRight): _next,
        const SingleActivator(LogicalKeyboardKey.arrowLeft): _previous,
        const SingleActivator(LogicalKeyboardKey.escape): ?onClose,
      },
      child: Focus(
        focusNode: _focus,
        autofocus: true,
        child: Material(
          color: grid.AppPalette.windowBg,
          child: LayoutBuilder(
            builder: (context, constraints) {
              // The render's margins are 5% of the window's width.
              final gutter = (constraints.maxWidth * 0.05).clamp(28.0, 72.0);
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: _stage(context, gutter)),
                  if (progress != null)
                    ValueListenableBuilder<SetupProgress>(
                      valueListenable: progress,
                      builder: (context, value, _) => _InstallBar(
                        progress: value,
                        gutter: gutter,
                        detailsOpen: _detailsOpen,
                        detailsMaxHeight: constraints.maxHeight * 0.45,
                        onToggleDetails: () =>
                            setState(() => _detailsOpen = !_detailsOpen),
                        onRetry: widget.onRetry,
                        onManual: widget.onManual,
                        details: widget.details,
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _stage(BuildContext context, double gutter) {
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final swap = reduceMotion
        ? Duration.zero
        : const Duration(milliseconds: 280);
    final slide = _slides[_index];
    final width = MediaQuery.sizeOf(context).width;
    final titleSize = (width * 0.034).clamp(30.0, 48.0);
    final copyColor = Color.lerp(
      grid.AppPalette.textPrimary,
      grid.AppPalette.textSecondary,
      0.45,
    )!;
    final text = Column(
      key: ValueKey('tour-text-$_index'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          slide.kicker.toUpperCase(),
          key: const ValueKey('tour-kicker'),
          style: grid.AppType.caption(
            color: grid.AppPalette.onboardingAccent,
            fontWeight: FontWeight.w600,
          ).copyWith(fontSize: 13.5, letterSpacing: 1.9),
        ),
        const SizedBox(height: 15),
        Semantics(
          header: true,
          child: Text(
            slide.title,
            key: const ValueKey('tour-title'),
            style:
                grid.AppType.display(
                  color: grid.AppPalette.textPrimary,
                  fontWeight: FontWeight.w700,
                ).copyWith(
                  fontSize: titleSize,
                  height: 1.08,
                  letterSpacing: -0.02 * titleSize,
                ),
          ),
        ),
        const SizedBox(height: 20),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Text(
            slide.copy,
            key: const ValueKey('tour-copy'),
            style: grid.AppType.body(color: copyColor)
                .copyWith(fontSize: 19, height: 1.5),
          ),
        ),
      ],
    );
    final body = Row(
      children: [
        Expanded(
          flex: 100,
          child: Center(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _fade(swap, text),
                  const SizedBox(height: 38),
                  _Pager(count: _slides.length, index: _index, onSelect: _show),
                ],
              ),
            ),
          ),
        ),
        SizedBox(width: gutter * 0.6),
        Expanded(
          flex: 115,
          child: _fade(
            swap,
            KeyedSubtree(
              key: ValueKey('tour-art-$_index'),
              child: TourArtFrame(
                label: slide.artLabel,
                child: Builder(builder: slide.art),
              ),
            ),
          ),
        ),
      ],
    );
    return Stack(
      children: [
        const Positioned.fill(child: _Glow()),
        Positioned.fill(
          child: Padding(
            // Top: clear of the traffic lights' band. Right: room for the
            // arrow. Bottom: room for the tagline.
            padding: EdgeInsets.fromLTRB(
              gutter,
              windowDragBandHeight + 16,
              gutter + 44,
              56,
            ),
            child: Opacity(
              // Details open: the slide steps back behind the log.
              opacity: _detailsOpen && widget.progress != null ? 0.45 : 1,
              child: body,
            ),
          ),
        ),
        Positioned(
          left: gutter,
          right: gutter,
          bottom: 20,
          child: Text(
            tourTagline,
            key: const ValueKey('tour-tagline'),
            style: grid.AppType.label(color: grid.AppPalette.onboardingTagline)
                .copyWith(fontSize: 13.5, letterSpacing: 0.3),
          ),
        ),
        Positioned(
          right: 16,
          top: 0,
          bottom: 0,
          child: Center(child: _NextButton(onPressed: _next)),
        ),
        if (widget.onClose != null)
          Positioned(
            top: windowDragBandHeight + 8,
            right: 16,
            child: AppIconButton(
              key: const ValueKey('tour-close'),
              icon: AppIcons.close,
              size: AppIcons.controlSize,
              tooltip: 'Close',
              onPressed: widget.onClose,
            ),
          ),
      ],
    );
  }

  /// A cross-fade between slides; with Reduce Motion the next slide simply
  /// replaces the last.
  Widget _fade(Duration duration, Widget child) => duration == Duration.zero
      ? child
      : AnimatedSwitcher(
          duration: duration,
          layoutBuilder: (current, previous) => Stack(
            alignment: Alignment.centerLeft,
            children: [...previous, ?current],
          ),
          child: child,
        );
}

/// The stage's two soft glows, amber up right and gold down left, as in the
/// render.
class _Glow extends StatelessWidget {
  const _Glow();

  @override
  Widget build(BuildContext context) {
    // Const, so it repaints on a light/dark flip only because it watches the theme.
    grid.AppTheme.watch(context);
    final strength = grid.AppTheme.pick(0.06, 0.10);
    return IgnorePointer(
      child: Stack(
        children: [
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: const Alignment(0.6, -0.2),
                  radius: 0.9,
                  colors: [
                    grid.AppPalette.onboardingAccent.withValues(
                      alpha: strength,
                    ),
                    grid.AppPalette.onboardingAccent.withValues(alpha: 0),
                  ],
                ),
              ),
            ),
          ),
          Positioned.fill(
            child: DecoratedBox(
              decoration: BoxDecoration(
                gradient: RadialGradient(
                  center: const Alignment(-0.8, 0.9),
                  radius: 0.8,
                  colors: [
                    grid.AppPalette.onboardingTagline.withValues(
                      alpha: strength * 0.7,
                    ),
                    grid.AppPalette.onboardingTagline.withValues(alpha: 0),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Pager extends StatelessWidget {
  const _Pager({
    required this.count,
    required this.index,
    required this.onSelect,
  });

  final int count;
  final int index;
  final ValueChanged<int> onSelect;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < count; i++)
          Semantics(
            button: true,
            selected: i == index,
            label: 'Slide ${i + 1} of $count',
            child: MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                key: ValueKey('tour-dot-$i'),
                behavior: HitTestBehavior.opaque,
                onTap: () => onSelect(i),
                child: Padding(
                  // A 10-point dot inside a target a finger can find.
                  padding: const EdgeInsets.symmetric(
                    horizontal: 4.5,
                    vertical: 8,
                  ),
                  child: Container(
                    width: i == index ? 31 : 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: i == index
                          ? grid.AppPalette.onboardingAccent
                          : grid.AppPalette.guide,
                      borderRadius: BorderRadius.circular(5),
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _NextButton extends StatelessWidget {
  const _NextButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Next',
      child: Semantics(
        button: true,
        label: 'Next slide',
        child: Material(
          type: MaterialType.circle,
          color: grid.AppSurface.recess,
          child: InkWell(
            key: const ValueKey('tour-next'),
            customBorder: const CircleBorder(),
            onTap: onPressed,
            child: Container(
              width: 46,
              height: 46,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                border: Border.all(color: grid.AppPalette.divider),
              ),
              child: Icon(
                AppIcons.chevronRight,
                size: AppIcons.controlSize,
                color: grid.AppPalette.textPrimary,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The only sign of the install: one line, a thin bar, the time left, and ▸
/// for the details.
class _InstallBar extends StatelessWidget {
  const _InstallBar({
    required this.progress,
    required this.gutter,
    required this.detailsOpen,
    required this.detailsMaxHeight,
    required this.onToggleDetails,
    required this.onRetry,
    required this.onManual,
    required this.details,
  });

  final SetupProgress progress;
  final double gutter;
  final bool detailsOpen;
  final double detailsMaxHeight;
  final VoidCallback onToggleDetails;
  final VoidCallback? onRetry;
  final VoidCallback? onManual;
  final Widget? details;

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final danger = Theme.of(context).colorScheme.error;
    final done = progress.done;
    final failed = progress.failed;
    final tone = done
        ? grid.AppPalette.online
        : failed
        ? danger
        : grid.AppPalette.onboardingAccent;
    final line = done
        ? 'Harness is ready. Opening…'
        : failed
        ? progress.failure ?? 'Setup could not finish'
        : setupTourInstallLine;
    final left = progress.left;
    // A button the keyboard reaches too (Tab, then Return or Space), not just a click target.
    final toggle = Semantics(
      button: !done,
      expanded: done ? null : detailsOpen,
      child: InkWell(
        key: const ValueKey('tour-details-toggle'),
        onTap: done ? null : onToggleDetails,
        mouseCursor: done ? MouseCursor.defer : SystemMouseCursors.click,
        borderRadius: BorderRadius.circular(4),
        hoverColor: Colors.transparent,
        splashColor: Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (done)
                Container(
                  width: 8,
                  height: 8,
                  margin: const EdgeInsets.symmetric(horizontal: 3),
                  decoration: BoxDecoration(
                    color: grid.AppPalette.online,
                    shape: BoxShape.circle,
                  ),
                )
              else
                Icon(
                  detailsOpen ? AppIcons.chevronDown : AppIcons.chevronRight,
                  size: 14,
                  color: failed ? danger : grid.AppPalette.textSecondary,
                ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  line,
                  key: const ValueKey('tour-install-line'),
                  overflow: TextOverflow.ellipsis,
                  style: grid.AppType.label(
                    color: done
                        ? grid.AppPalette.textPrimary
                        : failed
                        ? danger
                        : grid.AppPalette.textSecondary,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    final detailsBody = details;
    return Container(
      padding: EdgeInsets.fromLTRB(gutter, 14, gutter, 16),
      decoration: BoxDecoration(
        color: grid.AppPalette.panelBg,
        border: Border(top: BorderSide(color: grid.AppPalette.divider)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Semantics(
                  button: !done,
                  expanded: detailsOpen,
                  liveRegion: failed || done,
                  hint: done ? null : 'Setup details',
                  child: Align(alignment: Alignment.centerLeft, child: toggle),
                ),
              ),
              const SizedBox(width: 12),
              if (failed) ...[
                if (onManual != null) ...[
                  TextButton(
                    key: const ValueKey('tour-manual'),
                    onPressed: onRetry == null ? null : onManual,
                    child: const Text('Switch to Manual'),
                  ),
                  const SizedBox(width: 8),
                ],
                FilledButton(
                  key: const ValueKey('tour-retry'),
                  onPressed: onRetry,
                  child: const Text('Retry'),
                ),
              ] else if (!done && left != null)
                Text(
                  formatSetupLeft(left),
                  key: const ValueKey('tour-time-left'),
                  style: grid.AppType.label(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 9),
          Semantics(
            label: 'Setup progress',
            value: '${(progress.fraction * 100).round()}%',
            child: ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: Container(
                height: 5,
                color: grid.AppPalette.cardBgHover,
                alignment: Alignment.centerLeft,
                child: AnimatedFractionallySizedBox(
                  key: const ValueKey('tour-progress-bar'),
                  // Progress may move while real work is in flight; with
                  // Reduce Motion it steps.
                  duration: reduceMotion
                      ? Duration.zero
                      : const Duration(milliseconds: 900),
                  widthFactor: progress.fraction.clamp(0.0, 1.0),
                  heightFactor: 1,
                  child: ColoredBox(color: tone),
                ),
              ),
            ),
          ),
          if (detailsOpen && detailsBody != null) ...[
            const SizedBox(height: 12),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: detailsMaxHeight),
              child: SingleChildScrollView(
                key: const ValueKey('tour-details'),
                child: detailsBody,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The setup tour bound to the app: shown by RootShell in place of the setup
/// screen while an unattended install runs (see
/// [AppNotifier.setupTourShowing]).
class SetupTourScreen extends StatefulWidget {
  const SetupTourScreen({super.key, required this.app});

  final AppNotifier app;

  @override
  State<SetupTourScreen> createState() => _SetupTourScreenState();
}

class _SetupTourScreenState extends State<SetupTourScreen> {
  late final SetupProgressTracker _progress = SetupProgressTracker(
    setup: widget.app,
    readiness: () => widget.app.environmentReadiness,
    // Past the app's own start: the tour hands over to the workspace (or,
    // after an error there, to sign-in), never to the boot screen.
    appReady: () =>
        widget.app.status == AppStatus.authenticated ||
        widget.app.status == AppStatus.unauthenticated,
    downloads: widget.app.setupDownloads,
  );

  @override
  void dispose() {
    _progress.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = widget.app;
    return ListenableBuilder(
      listenable: Listenable.merge([app, app.setupDownloads]),
      builder: (context, _) => SetupTour(
        progress: _progress,
        onOpen: app.finishSetupTour,
        // As the setup screen's own Retry: resume the install it asked for.
        onRetry: app.environmentSetupInFlight
            ? null
            : app.environmentInstallRequested
            ? app.startEnvironmentSetup
            : app.retryEnvironmentSetup,
        // The setup screen's own Switch to Manual; the tour then gives way to
        // that screen (see [AppNotifier.setupTourShowing]).
        onManual: () {
          app.selectEnvironmentSetupMode(EnvironmentSetupMode.manual);
          app.showEnvironmentMethodChoice();
        },
        details: EnvironmentSetupDetails(
          readiness: app.environmentReadiness,
          downloadLines: app.setupDownloads.value.lines,
        ),
      ),
    );
  }
}

/// Help ▸ Welcome Tour: the slides alone, full window, until Escape or Close.
Future<void> showWelcomeTour(BuildContext context) {
  final duration = MediaQuery.disableAnimationsOf(context)
      ? Duration.zero
      : const Duration(milliseconds: 180);
  return Navigator.of(context).push<void>(
    PageRouteBuilder<void>(
      settings: const RouteSettings(name: 'welcome-tour'),
      transitionDuration: duration,
      reverseTransitionDuration: duration,
      pageBuilder: (context, _, _) => FullWindowScreen(
        child: SetupTour(onClose: () => Navigator.of(context).maybePop()),
      ),
      transitionsBuilder: (context, animation, _, child) =>
          FadeTransition(opacity: animation, child: child),
    ),
  );
}
