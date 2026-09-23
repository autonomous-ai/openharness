import 'package:flutter/material.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'phone_destination.dart';
import 'phone_status.dart';

/// A search row's trailing edge: why it cannot be opened, and nothing else.
///
/// ⚠️ **The age is gone, on purpose.** The row used to end in `19h` or
/// `working`, and the desktop's picker ends in nothing — it puts recency in the
/// ordering instead, which the phone now does too. Two lists that hold the same
/// rows should not end differently.
///
/// What survives is the one thing a tap would NOT make obvious: a machine's
/// Unlock or Offline, and an agent whose terminal has gone. Dimming alone leaves
/// somebody tapping a row that cannot answer and reading nothing about why. The
/// desktop says the same thing in the line under its box, which a phone has no
/// room for.
class PhoneSearchTrailing extends StatelessWidget {
  const PhoneSearchTrailing({
    super.key,
    required this.row,
    required this.openable,
    required this.now,
    this.resuming = false,
  });

  final PhoneDestination row;
  final bool openable;

  /// Whether the agent is being restarted right now — see
  /// `PhoneSearchResults._resumeThenOpen`.
  final bool resuming;

  final DateTime now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (resuming) return const _Spinner();
    final badge = phoneSearchBadge(row, openable: openable);
    return badge == null ? const SizedBox.shrink() : _Badge(badge);
  }
}

/// The word a result ends in, or null for a row a tap simply opens — see
/// [PhoneSearchTrailing]. Shared with the terminal sheet's rows
/// (`sheet_search_row.dart`), which say the same thing in their own type.
String? phoneSearchBadge(PhoneDestination row, {required bool openable}) {
  final machine = row.machine;
  return switch (row.kind) {
    // Saved work, not a dead row: the tap resumes it and opens it. Said
    // plainly because the wait that follows is a second or two of nothing.
    // Stopped work with no conversation to reopen says so in the desktop's
    // words, rather than the `No terminal` of a live agent that lost its pane.
    PhoneDestinationKind.agent => switch (row.entry?.agent) {
      final agent? when agent.isStopped =>
        openable ? 'Stopped' : 'Resume unavailable',
      _ => openable ? null : 'No terminal',
    },
    PhoneDestinationKind.machine => switch (machine == null
        ? null
        : phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.offline => 'Offline',
      PhoneMachineStatus.needsPassword => 'Unlock',
      _ => null,
    },
    // A group says its size in its own detail line ("Project · 3 harnesses"),
    // and a command has nothing to be fresh about.
    _ => null,
  };
}

/// The wait between tapping stopped work and its terminal arriving. Sized to
/// the badge it replaces, so the row does not reflow when it appears.
class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: SizedBox(
        width: 13,
        height: 13,
        child: CircularProgressIndicator(
          strokeWidth: 1.6,
          color: AppPalette.textFaint,
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.only(left: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: AppGlass.hair),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: AppPalette.textFaint,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
