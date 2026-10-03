import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'link_page.dart';
import 'welcome/connect_computer.dart';
import 'tty_controls.dart';
import 'tty.dart';
import 'find_row.dart';
import 'machine_actions.dart';
import 'machine_index.dart';
import 'phone_card.dart';
import 'phone_navigation.dart';
import 'phone_status.dart';

/// The machines on the account, grouped by what they need.
///
/// The desktop lists machines in account order, because its rail shows every one at once and the
/// order is the only stable thing about it. A phone screen holds five or six rows, so the order
/// has to carry meaning instead: the machines that are linked and working go first, because those
/// are the ones somebody opens day to day. The machines that want something — a password, a
/// Harness that is not running — collect underneath, where they read as a to-do list rather than
/// as the thing standing between you and the machine you actually came for.
class MachinesTab extends StatelessWidget {
  const MachinesTab({super.key, required this.notifier, this.large = true});

  final AppNotifier notifier;

  /// The tab's big title. Off when this is PUSHED — from the terminal's `⋯` sheet — where it needs
  /// the back chevron that a large header does not draw.
  final bool large;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: notifier,
    builder: (context, _) {
      AppTheme.watch(context);
      final tty = Tty.of(context);
      return Scaffold(
        backgroundColor: tty.ground,
        body: SafeArea(
          bottom: false,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Tty.origin,
                  12,
                  Tty.origin,
                  4,
                ),
                child: TtyText(
                  'Computers',
                  size: large ? 24 : TtySize.title,
                  weight: FontWeight.w600,
                ),
              ),
              Expanded(child: _Body(notifier: notifier)),
            ],
          ),
        ),
      );
    },
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
      return const EmptyState(
        icon: LucideIcons.laptopMinimal300,
        title: 'No computers yet',
        message:
            'Set up Harness on your computer, signed in to this account, and it '
            'appears here.',
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
            onTap: () => Navigator.of(context).push(
              phoneRoute(
                (route) => ConnectComputerPage(
                  notifier: notifier,
                  signedIn: false,
                  onBack: () => Navigator.of(route).maybePop(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _row(BuildContext context, MachineState state, Tty tty) {
    final status = phoneMachineStatusOf(state);
    final count = state.agents.length;
    final (String word, Color color, String detail) = switch (status) {
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
    return FindRow(
      title: state.machine.displayName,
      detail: detail,
      state: word,
      stateColor: color,
      enabled: status != PhoneMachineStatus.offline,
      onTap: status == PhoneMachineStatus.offline
          ? null
          : () => _open(context, state),
    );
  }

  void _open(BuildContext context, MachineState state) {
    if (state.needsLink) {
      Navigator.of(context).push(
        phoneRoute(
          (_) =>
              LinkPage(notifier: notifier, machineId: state.machine.machineId),
        ),
      );
      return;
    }
    // The same sheet the terminal's `⋯` used to open for a machine — reload its agents, re-enter its
    // password, unlink this phone. One place decides what a machine offers, so a machine tapped here
    // and a machine tapped from there cannot drift apart.
    openMachineActions(context, notifier, state.machine.machineId);
  }
}
