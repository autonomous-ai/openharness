import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'welcome/connect_computer.dart';
import 'tty_controls.dart';
import 'tty.dart';
import 'find_row.dart';
import 'machine_actions.dart';
import 'machine_index.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';
import 'settings_page.dart' show PhoneSettingsButton;

/// The machines on the account, grouped by what they need.
///
/// The desktop lists machines in account order, because its rail shows every one at once and the
/// order is the only stable thing about it. A phone screen holds five or six rows, so the order
/// has to carry meaning instead: the machines that are linked and working go first, because those
/// are the ones somebody opens day to day. The machines that want something — a password, a
/// Harness that is not running — collect underneath, where they read as a to-do list rather than
/// as the thing standing between you and the machine you actually came for.
class MachinesTab extends StatelessWidget {
  const MachinesTab({
    super.key,
    required this.notifier,
    this.large = true,
    this.fromTerminal = false,
  });

  final AppNotifier notifier;

  /// The tab's big title. Off when this is PUSHED — from Settings or a swipe left on the terminal —
  /// where it draws the back chevron above its title instead, as Settings itself does.
  final bool large;

  /// Pushed by a swipe left on the terminal: a swipe right ANYWHERE goes back — the way home is the
  /// same swipe the other way, as on the New Harness form.
  final bool fromTerminal;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final tty = Tty.of(context);
      final page = Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!large)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TtyBackButton(
                    onPressed: () => Navigator.of(context).maybePop(),
                  ),
                ),
              Row(
                children: [
                  Expanded(
                    child: Padding(
                      padding: EdgeInsets.fromLTRB(
                        Tty.origin,
                        large ? 12 : 8,
                        Tty.origin,
                        4,
                      ),
                      child: TtyText(
                        'Computers',
                        size: large ? 24 : TtySize.title,
                        weight: FontWeight.w600,
                      ),
                    ),
                  ),
                  // What a pull on the list does, for whoever does not know to pull — or has
                  // nothing to pull: the empty and failed states draw no list.
                  _RefreshButton(
                    busy:
                        notifier.machinesRefreshing || notifier.machinesLoading,
                    trailing: !large,
                    onPressed: () => unawaited(notifier.retryMachines()),
                  ),
                  // Large, this is the home screen while no computer is ready — locked, or off —
                  // and nothing else on it leads to Settings or Sign out. Pushed (small) — from
                  // Settings, or by the terminal's swipe left — back is the way out.
                  if (large) PhoneSettingsButton(notifier: notifier),
                ],
              ),
              Expanded(child: _Body(notifier: notifier)),
            ],
          ),
        ),
      );
      return fromTerminal ? _SwipeBack(child: page) : page;
    },
  );
}

/// A swipe right anywhere on [child] pops it — not only the system's sliver of left edge, which a
/// thumb in the middle of the screen never finds. The New Harness form's reach and flick.
class _SwipeBack extends StatefulWidget {
  const _SwipeBack({required this.child});

  final Widget child;

  @override
  State<_SwipeBack> createState() => _SwipeBackState();
}

class _SwipeBackState extends State<_SwipeBack> {
  /// How far right the drag under way has gone.
  double _swiped = 0;

  @override
  Widget build(BuildContext context) => GestureDetector(
    // Translucent: the rows under the finger still take their taps; the list scrolls on the other
    // axis.
    behavior: HitTestBehavior.translucent,
    onHorizontalDragStart: (_) => _swiped = 0,
    onHorizontalDragUpdate: (details) => _swiped += details.primaryDelta ?? 0,
    onHorizontalDragEnd: (details) {
      if (_swiped >= 64 || (details.primaryVelocity ?? 0) >= 300) {
        unawaited(Navigator.of(context).maybePop());
      }
    },
    child: widget.child,
  );
}

class _Body extends StatelessWidget {
  const _Body({required this.notifier});

  final AppNotifier notifier;

  @override
  Widget build(BuildContext context) {
    // The order a swipe on the machine page walks, split back into the two sections this list draws.
    // Taken from [visibleMachines] rather than partitioned here so the page and the list cannot
    // drift apart — the split below is presentation, the order is not.
    final ordered = visibleMachines(notifier);
    if (ordered.isEmpty &&
        (notifier.machinesLoading || notifier.machinesRefreshing)) {
      return const PhoneListSkeleton();
    }
    // ⚠️ A list that could not be fetched is not an empty one. Drawn as "No machines yet", it told
    // somebody with three machines to go and set one up — and with nothing in the list there was no
    // pull-to-refresh either, so no way to try again short of restarting the app.
    final failure = notifier.lastError;
    if (ordered.isEmpty && failure != null) {
      return EmptyState(
        icon: LucideIcons.circleAlert300,
        title: "Couldn't reach your computers",
        message: failure,
        action: FilledButton(
          onPressed: () => unawaited(notifier.retryMachines()),
          child: const Text('Try again'),
        ),
      );
    }
    if (ordered.isEmpty) {
      // ⚠️ With the way to set one up, as the list's own last row offers it: reached from Settings
      // on a phone with no computer yet, this was a sentence and nothing to press.
      return EmptyState(
        icon: LucideIcons.laptopMinimal300,
        title: 'No computers yet',
        message:
            'Set up Harness on your computer, signed in to this account, and it '
            'appears here.',
        action: FilledButton(
          key: const ValueKey('machines-set-up'),
          onPressed: () => _setUpComputer(context),
          child: const Text('Set up a computer'),
        ),
      );
    }

    final tty = Tty.of(context);
    return RefreshIndicator(
      onRefresh: notifier.retryMachines,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.only(
          bottom: MediaQuery.paddingOf(context).bottom + 24,
        ),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 0, Tty.origin, 8),
            child: Text(
              'Your harnesses run on these.',
              style: tty.style(size: TtySize.meta, color: tty.faint),
            ),
          ),
          for (final state in ordered) _row(context, state, tty),
          const SizedBox(height: 8),
          FindAddRow(
            label: 'Set up another computer',
            onTap: () => _setUpComputer(context),
          ),
        ],
      ),
    );
  }

  /// The set-up page over this list — downloads, steps, and a scan that pairs — for a computer not
  /// on the account yet.
  void _setUpComputer(BuildContext context) => unawaited(
    Navigator.of(context).push(
      phoneRoute(
        (route) => ConnectComputerPage(
          notifier: notifier,
          signedIn: false,
          onBack: () => Navigator.of(route).maybePop(),
        ),
      ),
    ),
  );

  Widget _row(BuildContext context, MachineState state, Tty tty) {
    final status = phoneMachineStatusOf(state);
    final count = state.agents.length;
    final machineId = state.machine.machineId;
    var (String word, Color color, String detail) = switch (status) {
      PhoneMachineStatus.ready => (
        'ready',
        tty.green,
        count == 0
            ? 'nothing running'
            : '$count harness${count == 1 ? '' : 'es'}',
      ),
      PhoneMachineStatus.connecting => ('connecting', tty.faint, 'one moment…'),
      PhoneMachineStatus.needsPassword => (
        'locked',
        tty.yellow,
        'tap to unlock: scan its code',
      ),
      PhoneMachineStatus.offline => (
        'asleep',
        tty.faint,
        'turn it on, or run harness start there',
      ),
    };
    // Something asked of it by hand is still on its way: the row says so, rather than the state it
    // is about to leave.
    if (notifier.machineRemoving(machineId)) {
      (word, color) = ('removing…', tty.faint);
    } else if (notifier.machineRetrying(machineId)) {
      (word, color) = ('trying…', tty.faint);
    }
    return FindRow(
      title: state.machine.displayName,
      detail: detail,
      state: word,
      stateColor: color,
      // ⚠️ An asleep computer is tappable now. It used to be drawn inert, with nothing a tap could do
      // for it — and it is exactly the one somebody wants to try again, rename, or take off the
      // account.
      onTap: () => _open(context, state),
    );
  }

  /// One sheet for every computer, whatever it reads — see [openMachineActions]. A locked one has
  /// "Unlock…" at its head, the act its row offers; one place decides what a computer offers, so no
  /// state can lose the rename or the removal.
  void _open(BuildContext context, MachineState state) =>
      openMachineActions(context, notifier, state.machine.machineId);
}

/// The list read again — what a pull does ([AppNotifier.retryMachines]) — as a glyph beside
/// Settings.
///
/// While a read the person asked for is running ([busy]) the glyph turns and a press does nothing;
/// it keeps its ink rather than greying out, because it is working, not unavailable — the rail's
/// reload says the same (`AppIconButton.spinning`). The deaf poll's own reads do not turn it: every
/// few seconds, that would be a glyph that never stops.
class _RefreshButton extends StatefulWidget {
  const _RefreshButton({
    required this.busy,
    required this.trailing,
    required this.onPressed,
  });

  final bool busy;

  /// Last in its row, with no Settings after it (the list pushed from Settings): the glyph sits on
  /// the right gutter, in Settings' own box. Otherwise it stands left of Settings, which keeps its
  /// place on the gutter.
  final bool trailing;

  final VoidCallback onPressed;

  @override
  State<_RefreshButton> createState() => _RefreshButtonState();
}

class _RefreshButtonState extends State<_RefreshButton>
    with SingleTickerProviderStateMixin {
  /// One turn — the rail's reload's (`AppIconButton`).
  static const Duration _spinPeriod = Duration(milliseconds: 900);

  late final AnimationController _spin = AnimationController(
    vsync: this,
    duration: _spinPeriod,
  );

  @override
  void initState() {
    super.initState();
    if (widget.busy) _spin.repeat();
  }

  @override
  void didUpdateWidget(_RefreshButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.busy == oldWidget.busy) return;
    if (widget.busy) {
      _spin.repeat();
    } else {
      // The turn under way lands upright instead of freezing at whatever angle the reply arrived:
      // a glyph stopped askew reads as stuck.
      _spin
          .animateTo(1, duration: _spinPeriod * (1 - _spin.value))
          .whenComplete(() {
            if (mounted && !widget.busy) _spin.value = 0;
          });
    }
  }

  @override
  void dispose() {
    _spin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      enabled: !widget.busy,
      label: 'Refresh',
      excludeSemantics: true,
      child: GestureDetector(
        key: const ValueKey('machines-refresh'),
        behavior: HitTestBehavior.opaque,
        onTap: () {
          if (widget.busy) return;
          HapticFeedback.selectionClick();
          widget.onPressed();
        },
        // A thumb's 44. Beside Settings the glyph keeps to the box's right edge: Settings' box
        // already leaves room left of its own glyph, and centred here the two sat a button apart.
        child: SizedBox(
          width: widget.trailing ? 52 : 44,
          height: 44,
          child: Padding(
            padding: EdgeInsets.only(
              right: widget.trailing ? Tty.origin - 2 : 2,
            ),
            child: Align(
              alignment: Alignment.centerRight,
              child: RotationTransition(
                turns: _spin,
                child: Icon(
                  LucideIcons.refreshCw300,
                  size: 20,
                  color: tty.faint,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
