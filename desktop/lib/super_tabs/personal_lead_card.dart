import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'personal_lead.dart';

/// A Personal project's channel with no PM: one line and Start PM (Huy 11-04, task #2815; Swarm v4). The click starts it
/// on the person's own computer, with Claude Code and in the repo's folder (personal_lead.dart), and opens the PM's own
/// chat at once, where the person tells it what to do while it starts: only agents post in the channel.
class PersonalLeadStartCard extends StatelessWidget {
  const PersonalLeadStartCard({
    super.key = const ValueKey('super-lead-start'),
    required this.controller,
    required this.conversationId,
    required this.app,
  });

  final SuperTabController controller;
  final String conversationId;
  final AppNotifier app;

  @override
  Widget build(BuildContext context) {
    final starter = PersonalLeadStarter.of(app);
    return ListenableBuilder(
      listenable: starter,
      builder: (context, _) {
        final status = starter.statusOf(controller, conversationId);
        final starting = status != null && !status.failed;
        String? unavailable;
        try {
          starter.planFor(controller, conversationId);
        } on SuperTabFailure catch (failure) {
          unavailable = failure.message;
        }
        final line = switch ((unavailable, status?.reason)) {
          (final why?, _) => 'Can’t start a Product Manager: $why',
          (_, final reason?) => 'Couldn’t start the Product Manager: $reason',
          _ => 'This project has no Product Manager.',
        };
        return SwarmPmStart(
          line: line,
          button: unavailable == null,
          starting: starting,
          onStart: starting || controller.saving
              ? null
              : () => unawaited(starter.start(controller, conversationId)),
        );
      },
    );
  }
}

/// What a Personal project's channel with no PM shows (design doc, Swarm elements): [line], then Start PM, or
/// `Starting…` while [starting]; no [button] when none of the person's computers can start it. No [onStart]: the button
/// waits.
class SwarmPmStart extends StatelessWidget {
  const SwarmPmStart({
    super.key,
    required this.line,
    this.button = true,
    this.starting = false,
    this.onStart,
  });

  final String line;
  final bool button, starting;
  final VoidCallback? onStart;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: DesktopChrome.surface,
      borderRadius: BorderRadius.circular(grid.AppCard.radius),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Padding(
      padding: const EdgeInsets.all(grid.AppDesktop.groupGap),
      child: Row(
        children: [
          Expanded(
            child: Text(
              line,
              key: const ValueKey('super-lead-start-line'),
              style: DesktopChrome.control(),
            ),
          ),
          if (button) ...[
            const SizedBox(width: grid.AppDesktop.controlGap),
            FilledButton(
              onPressed: onStart,
              child: Text(starting ? 'Starting…' : 'Start PM'),
            ),
          ],
        ],
      ),
    ),
  );
}
