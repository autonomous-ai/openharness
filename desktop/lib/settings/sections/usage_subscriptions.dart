import 'dart:async';

import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/empty_state.dart';
import '../../shared/widgets/setting_row.dart';
import '../../usage/models_menu_controller.dart';
import '../../widgets/workspace_subscription_usage.dart';

/// Settings ▸ Usage in a browser: the account's Claude Code and Codex
/// subscriptions, read from its computers as the footer reads them. A browser
/// runs no agent CLI, so it has no transcripts or tokens of its own to count.
class UsageSubscriptions extends StatefulWidget {
  const UsageSubscriptions({super.key, required this.subscriptions});

  final ModelsMenuController subscriptions;

  @override
  State<UsageSubscriptions> createState() => _UsageSubscriptionsState();
}

class _UsageSubscriptionsState extends State<UsageSubscriptions> {
  @override
  void initState() {
    super.initState();
    // Opening the page asks for a fresh reading, as opening Models does (at most once a minute).
    unawaited(widget.subscriptions.refresh());
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.subscriptions,
    builder: (context, _) {
      final accounts = WorkspaceSubscriptionUsage.fromRows(
        widget.subscriptions.rows,
      ).accounts;
      if (accounts.isEmpty) {
        return const EmptyState(
          icon: AppIcons.gauge,
          title: 'No subscriptions yet',
          message:
              'Claude Code and Codex usage shows here once one of your '
              'computers is online and signed in to them.',
        );
      }
      return ListView(
        padding: EdgeInsets.zero,
        children: [
          for (final account in accounts)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: SettingRow(
                title: account.name,
                detail: _detail(account),
                control: Text(
                  account.figure,
                  textAlign: TextAlign.end,
                  style: AppType.heading(
                    color: account.ink(
                      AppPalette.textPrimary,
                      AppGlass.surfaceFill,
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );

  /// The tooltip's lines under its title: account, computers, status, resets. Not its last line,
  /// which points at the footer's own details, and not the figure the row already shows at its
  /// end: "62% remaining · Running low" keeps only "Running low".
  static String _detail(WorkspaceSubscriptionAccount account) {
    final lines = account.detail.split('\n');
    final left = '${account.figure} remaining';
    return [
      for (final line in lines.skip(1).take(lines.length - 2))
        if (!line.startsWith(left))
          line
        else if (line.startsWith('$left · '))
          line.substring('$left · '.length),
    ].join('\n');
  }
}
