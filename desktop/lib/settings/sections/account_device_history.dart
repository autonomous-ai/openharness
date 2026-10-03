import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/relative_time.dart';
import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/widgets/app_dialog.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../viewer/device_history.dart';
import 'account_device_detail.dart';

/// Settings ▸ Your devices ▸ History… — every device added to or removed from the account, newest
/// first, as this end verified the log. A device that was removed stays in it, named as it was.
Future<void> showAccountDeviceHistory(BuildContext context, AppNotifier app) =>
    showAppDialog<void>(
      context: context,
      builder: (context) => _AccountDeviceHistory(app: app),
    );

class _AccountDeviceHistory extends StatefulWidget {
  const _AccountDeviceHistory({required this.app});

  final AppNotifier app;

  @override
  State<_AccountDeviceHistory> createState() => _AccountDeviceHistoryState();
}

class _AccountDeviceHistoryState extends State<_AccountDeviceHistory> {
  DeviceLogHistory? _history;
  bool _loading = true;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    DeviceLogHistory? history;
    var failed = false;
    try {
      history = await widget.app.loadDeviceHistory();
    } catch (_) {
      failed = true;
    }
    if (!mounted) return;
    setState(() {
      _history = history;
      _failed = failed || history == null;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final history = _history;
    final Widget body;
    if (_loading) {
      body = Text(
        'Loading…',
        style: grid.AppType.body(color: grid.AppPalette.textSecondary),
      );
    } else if (history == null || _failed) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Couldn’t load the history. Try again.',
            key: const Key('device-history-error'),
            style: grid.AppType.body(color: AppColors.danger),
          ),
          const SizedBox(height: 8),
          OutlinedButton(
            key: const Key('device-history-retry'),
            onPressed: () => unawaited(_load()),
            child: const Text('Try again'),
          ),
        ],
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final row in history.rows)
            _HistoryRow(
              key: ValueKey('device-history-${row.seq}'),
              row: row,
              onOpen: row.active
                  ? () => unawaited(
                      showAccountDeviceDetail(
                        context,
                        widget.app,
                        pub: row.pub,
                        isNew: row.pending,
                      ),
                    )
                  : null,
            ),
          if (history.rows.isEmpty && history.complete)
            Text(
              'No history yet.',
              key: const Key('device-history-empty'),
              style: grid.AppType.body(color: grid.AppPalette.textSecondary),
            ),
          if (!history.complete)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                'Older history needs a connection.',
                key: const Key('device-history-incomplete'),
                style: grid.AppType.body(color: grid.AppPalette.textSecondary),
              ),
            ),
        ],
      );
    }
    return AlertDialog(
      title: const Text('Device history'),
      content: SizedBox(
        width: 460,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Every device added to or removed from your account, newest first, as this device verified it.',
                style: grid.AppType.body(
                  color: grid.AppPalette.textSecondary,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 14),
              body,
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('device-history-close'),
          onPressed: () => Navigator.pop(context),
          style: TextButton.styleFrom(
            foregroundColor: grid.AppPalette.textSecondary,
            overlayColor: grid.AppSurface.hoverFill,
          ),
          child: const Text('Close'),
        ),
      ],
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({super.key, required this.row, required this.onOpen});

  final DevLogHistoryRow row;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final when = fullDateTime(DateTime.fromMillisecondsSinceEpoch(row.at));
    final what = row.kind == 'machine' ? 'Computer' : 'App';
    final detail =
        '$when · $what${row.fingerprint.isEmpty ? '' : ' · ${row.fingerprint}'}';
    final content = Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(
                child: Text(
                  historySentence(row),
                  style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                ),
              ),
              if (row.thisDevice) ...[
                const SizedBox(width: 6),
                Text(
                  '(this device)',
                  style: grid.AppType.caption(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ],
              if (row.pending) ...[
                const SizedBox(width: 6),
                DecoratedBox(
                  decoration: BoxDecoration(
                    color: grid.AppPalette.warn.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 1,
                    ),
                    child: Text(
                      // A key that was new and is gone again: its flag stays until dismissed.
                      row.active ? 'New' : 'Left before you looked',
                      style: grid.AppType.caption(color: grid.AppPalette.warn),
                    ),
                  ),
                ),
              ],
            ],
          ),
          Text(
            detail,
            style: grid.AppType.caption(color: grid.AppPalette.textSecondary),
          ),
        ],
      ),
    );
    if (onOpen == null) return content;
    // A device still on the account opens its page — by keyboard too (Tab, then Enter or Space).
    return InkWell(
      onTap: onOpen,
      borderRadius: BorderRadius.circular(4),
      hoverColor: grid.AppSurface.hoverFill,
      child: content,
    );
  }
}
