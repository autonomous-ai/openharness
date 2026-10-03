import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/status_line_style.dart';
import '../shared/theme/workspace_bar_style.dart';
import '../usage/models_menu_controller.dart' show subscriptionSearchId;
import 'engine_identity.dart';
import 'workspace_bar_control.dart';

enum WorkspaceUsageTone { normal, low, exhausted }

/// One account, already deduplicated across machines by ModelsMenuController.
class WorkspaceSubscriptionAccount {
  const WorkspaceSubscriptionAccount({
    required this.id,
    required this.engine,
    required this.searchId,
    required this.name,
    required this.figure,
    required this.detail,
    required this.tone,
  });
  final String id, engine, searchId, name, figure, detail;
  final WorkspaceUsageTone tone;

  Color ink(Color foreground, Color surface) =>
      statusLineInkOnSurface(switch (tone) {
        WorkspaceUsageTone.normal => foreground,
        WorkspaceUsageTone.low => grid.AppPalette.usageLow,
        WorkspaceUsageTone.exhausted => grid.AppPalette.usageCritical,
      }, surface);

  Map<String, Object?> native(Color foreground, Color surface, bool enabled) =>
      {
        'text': figure,
        'label': detail,
        'detail': detail,
        'field': searchId,
        'paneId': 0,
        'iconEngine': engine,
        'iconAsset': engineIdentity(engine).asset,
        if (engine == 'claude')
          'iconColor':
              (grid.AppTheme.isDark
                      ? const Color(0xffcc7c5e)
                      : const Color(0xffc2633f))
                  .toARGB32(),
        'interactive': enabled,
        'segments': [
          {'text': figure, 'foreground': ink(foreground, surface).toARGB32()},
        ],
      };
}

/// Shared remaining allowance, windows, freshness and account identity.
/// Unknown readings never become zero.
class WorkspaceSubscriptionUsage {
  const WorkspaceSubscriptionUsage._(this.accounts);
  final List<WorkspaceSubscriptionAccount> accounts;

  String get text => accounts.isEmpty
      ? 'Subscriptions'
      : accounts
            .map((a) => '${a.name} ${a.figure}')
            .join(workspaceBarGroupSeparator);
  String get detail => accounts.isEmpty
      ? 'View subscription allowance and reset times'
      : accounts.map((a) => a.detail).join('\n\n');

  List<({String text, WorkspaceUsageTone tone})> get segments => [
    for (final (index, account) in accounts.indexed) ...[
      (
        text: '${index == 0 ? '' : workspaceBarGroupSeparator}${account.name} ',
        tone: WorkspaceUsageTone.normal,
      ),
      (text: account.figure, tone: account.tone),
    ],
  ];

  List<StatusLinePaintSegment> paintSegments({
    required Color foreground,
    required Color surface,
  }) => [
    for (final (index, account) in accounts.indexed) ...[
      StatusLinePaintSegment(
        '${index == 0 ? '' : workspaceBarGroupSeparator}${account.name} ',
        statusLineInkOnSurface(foreground, surface),
        null,
      ),
      StatusLinePaintSegment(
        account.figure,
        account.ink(foreground, surface),
        null,
      ),
    ],
  ];

  factory WorkspaceSubscriptionUsage.fromRows(List<Map<String, Object?>> rows) {
    final accounts = <WorkspaceSubscriptionAccount>[];
    final occurrences = <String, int>{};
    for (final row in rows) {
      if (row['status'] == 'Not signed in') continue;
      final engine = row['engine'] as String? ?? '';
      final provider = engine == 'claude'
          ? 'Claude Code'
          : engine == 'codex'
          ? 'Codex'
          : row['title'] as String? ?? 'Subscription';
      final account = row['account'] as String? ?? '';
      final key = row['accountKey'] as String? ?? account;
      final base = '$engine:$key';
      final position = occurrences.update(
        base,
        (n) => n + 1,
        ifAbsent: () => 0,
      );
      final remaining = row['remainingPercent'];
      final left = remaining is num && remaining.isFinite
          ? remaining.clamp(0, 100)
          : null;
      final figure = left == null
          ? '—'
          : left > 0 && left < 1
          ? '<1%'
          : '${left.floor()}%';
      final status = left == null
          ? row['status'] as String? ?? 'Usage unavailable'
          : '$figure remaining${left == 0
                ? ' · Limit reached'
                : left.floor() <= 5
                ? ' · Nearly at limit'
                : left.floor() <= 20
                ? ' · Running low'
                : ''}';
      final machines =
          (row['machines'] as List?)?.whereType<String>().toList() ??
          const <String>[];
      final locations = [
        if (row['local'] == true) 'This computer',
        ...machines,
      ];
      accounts.add(
        WorkspaceSubscriptionAccount(
          id: '$base:$position',
          engine: engine,
          searchId: subscriptionSearchId(row),
          name: provider,
          figure: figure,
          detail: [
            provider,
            if (account.isNotEmpty) 'Account: $account',
            if (locations.isNotEmpty) 'On: ${locations.join(', ')}',
            status,
            if (row['details'] case final List details)
              ...details.whereType<String>(),
            'View subscription details.',
          ].join('\n'),
          tone: left == null || left.floor() > 20
              ? WorkspaceUsageTone.normal
              : left.floor() <= 5
              ? WorkspaceUsageTone.exhausted
              : WorkspaceUsageTone.low,
        ),
      );
    }
    return WorkspaceSubscriptionUsage._(List.unmodifiable(accounts));
  }
}

/// Whole account controls, with +N for overflow instead of clipped percentages.
class WorkspaceSubscriptionStrip extends StatelessWidget {
  const WorkspaceSubscriptionStrip({
    super.key,
    required this.usage,
    required this.foreground,
    required this.surface,
    required this.onOpen,
  });
  final WorkspaceSubscriptionUsage usage;
  final Color foreground, surface;
  final void Function(String? searchId)? onOpen;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final cell = workspaceBarCellSizeOf(context);
      final height = workspaceBarControlHeight(context);
      final iconSize = MediaQuery.textScalerOf(context).scale(14);
      double textWidth(String text) =>
          workspaceBarTextSizeOf(context, text).width;
      final widths = [
        for (final account in usage.accounts)
          cell.width * 3 + iconSize + textWidth(account.figure),
      ];
      var count = widths.length;
      var width = widths.fold(0.0, (a, b) => a + b);
      while (count > 0 &&
          width +
                  (count < widths.length
                      ? textWidth('+${widths.length - count}') + cell.width * 2
                      : 0) >
              constraints.maxWidth) {
        width -= widths[--count];
      }
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < count; i++)
            SizedBox(
              width: widths[i],
              height: height,
              child: WorkspaceBarControl(
                key: ValueKey('workspace-subscription:${usage.accounts[i].id}'),
                label: usage.accounts[i].detail,
                tooltip: usage.accounts[i].detail,
                onPressed: onOpen == null
                    ? null
                    : () => onOpen!(usage.accounts[i].searchId),
                builder: (context, emphasized) => Padding(
                  padding: EdgeInsets.symmetric(horizontal: cell.width),
                  child: Row(
                    children: [
                      EngineMark(
                        engine: usage.accounts[i].engine,
                        size: iconSize,
                      ),
                      SizedBox(width: cell.width),
                      Text(
                        usage.accounts[i].figure,
                        style: workspaceBarTextStyle(
                          color: usage.accounts[i].ink(foreground, surface),
                          emphasized: emphasized,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (count < widths.length)
            Flexible(
              child: WorkspaceBarControl(
                key: const ValueKey('workspace-subscriptions-overflow'),
                label: '${widths.length - count} more subscriptions',
                tooltip: usage.accounts
                    .skip(count)
                    .map((a) => a.detail)
                    .join('\n\n'),
                onPressed: onOpen == null ? null : () => onOpen!(null),
                builder: (context, emphasized) => Padding(
                  padding: EdgeInsets.symmetric(horizontal: cell.width),
                  child: SizedBox(
                    height: height,
                    child: Center(
                      widthFactor: 1,
                      child: Text(
                        '+${widths.length - count}',
                        maxLines: 1,
                        style: workspaceBarTextStyle(
                          color: foreground,
                          emphasized: emphasized,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}
