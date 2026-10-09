import 'dart:async';
import 'dart:math' as math;

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../state/notification_inbox.dart';
import 'desktop_chrome.dart';

Future<void> showNotificationInbox(
  BuildContext context, {
  required AppNotifier app,
  required Future<bool> Function(InboxNotification) onOpen,
  double topInset = 0,
}) => showAppDialog<void>(
  context: context,
  veilTint: Colors.transparent,
  builder: (_) =>
      NotificationInbox(app: app, onOpen: onOpen, topInset: topInset),
);

/// The existing unread notifications in a quiet, live list beside the bell.
class NotificationInbox extends StatefulWidget {
  const NotificationInbox({
    super.key,
    required this.app,
    required this.onOpen,
    this.topInset = 0,
  });

  final AppNotifier app;
  final Future<bool> Function(InboxNotification) onOpen;
  final double topInset;

  @override
  State<NotificationInbox> createState() => _NotificationInboxState();
}

class _NotificationInboxState extends State<NotificationInbox> {
  final _scroll = ScrollController();
  final _focus = FocusNode(debugLabel: 'Notifications');
  List<InboxNotification> _rows = [];
  String? _selected, _opening, _error;

  @override
  void initState() {
    super.initState();
    _refresh();
    widget.app.addListener(_changed);
    widget.app.agentUnread.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  void _refresh() {
    final next = {for (final row in notificationInbox(widget.app)) row.id: row};
    // Keep the list under the pointer still. New notifications append while
    // the popup is open; selection follows identity rather than an index.
    _rows = [for (final row in _rows) ?next.remove(row.id), ...next.values];
    if (!_rows.any((row) => row.id == _selected)) _selected = null;
  }

  void _changed() {
    if (mounted) setState(_refresh);
  }

  void _move(int delta) {
    if (_rows.isEmpty || _opening != null) return;
    final current = _rows.indexWhere((row) => row.id == _selected);
    final index = current < 0
        ? (delta > 0 ? 0 : _rows.length - 1)
        : (current + delta).clamp(0, _rows.length - 1);
    setState(() => _selected = _rows[index].id);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final extent = _rowExtent;
      final top = 8 + index * extent;
      final bottom = top + extent;
      final viewport = _scroll.position.viewportDimension;
      final offset = top < _scroll.offset
          ? top
          : bottom > _scroll.offset + viewport
          ? bottom - viewport
          : _scroll.offset;
      _scroll.jumpTo(offset.clamp(0.0, _scroll.position.maxScrollExtent));
    });
  }

  Future<void> _open(InboxNotification row) async {
    if (_opening != null) return;
    final current = notificationInbox(widget.app)
        .where((item) => item.id == row.id)
        .firstOrNull;
    if (current == null || current.unavailable != null) return;
    setState(() {
      _opening = row.id;
      _error = null;
    });
    try {
      final opened = await widget.onOpen(current);
      if (!mounted) return;
      if (opened) {
        Navigator.of(context).pop();
      } else {
        setState(() => _error = 'Could not open this harness. Try again.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not open this harness. Try again.');
      }
    } finally {
      if (mounted) setState(() => _opening = null);
    }
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    widget.app.agentUnread.removeListener(_changed);
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  double _lineHeight(TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: 'Ag', style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final height = painter.height.ceilToDouble();
    painter.dispose();
    return height;
  }

  double get _rowExtent =>
      _lineHeight(DesktopChrome.control(medium: true)) +
      _lineHeight(DesktopChrome.metadata()) +
      28;

  Color _statusColor(HarnessActivity activity) => switch (activity) {
    HarnessActivity.needsInput ||
    HarnessActivity.starting => grid.AppPalette.warn,
    HarnessActivity.failed => Theme.of(context).colorScheme.error,
    HarnessActivity.done => grid.AppPalette.online,
    _ => DesktopChrome.muted,
  };

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (!node.hasPrimaryFocus ||
        event is! KeyDownEvent ||
        HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed) {
      return KeyEventResult.ignored;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowDown ||
        event.logicalKey == LogicalKeyboardKey.arrowUp) {
      _move(event.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : -1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter ||
        event.logicalKey == LogicalKeyboardKey.numpadEnter) {
      final row = _rows.where((row) => row.id == _selected).firstOrNull;
      if (row != null) unawaited(_open(row));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return DesktopChrome(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final width = math.min(
            440.0,
            math.max(0.0, constraints.maxWidth - 32),
          );
          final available = math.max(
            0.0,
            constraints.maxHeight - widget.topInset - 32,
          );
          return Dialog(
            alignment: Alignment.topRight,
            insetPadding: EdgeInsets.fromLTRB(16, widget.topInset + 16, 16, 16),
            backgroundColor: Colors.transparent,
            surfaceTintColor: Colors.transparent,
            elevation: 0,
            constraints: BoxConstraints(maxWidth: width),
            child: SizedBox(
              key: const ValueKey('notification-inbox'),
              width: width,
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: math.min(520, available),
                ),
                child: DesktopDialogSurface(
                  radius: 12,
                  elevation: 12,
                  child: Semantics(
                    scopesRoute: true,
                    namesRoute: true,
                    explicitChildNodes: true,
                    label: 'Notifications',
                    child: Focus(
                      focusNode: _focus,
                      autofocus: true,
                      onKeyEvent: _onKey,
                      child: ListenableBuilder(
                        listenable: _focus,
                        builder: (context, _) => Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            _header(),
                            Divider(height: 1, color: DesktopChrome.rim),
                            Flexible(
                              child: _rows.isEmpty
                                  ? Padding(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 24,
                                        vertical: 40,
                                      ),
                                      child: Text(
                                        'No notifications',
                                        textAlign: TextAlign.center,
                                        style: DesktopChrome.control(
                                          color: DesktopChrome.muted,
                                        ),
                                      ),
                                    )
                                  : ListView.builder(
                                      controller: _scroll,
                                      shrinkWrap: true,
                                      itemCount: _rows.length,
                                      padding: const EdgeInsets.all(8),
                                      itemExtent: _rowExtent,
                                      itemBuilder: (context, index) =>
                                          _notificationRow(_rows[index]),
                                    ),
                            ),
                            if (_error != null && _rows.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.fromLTRB(
                                  20,
                                  4,
                                  20,
                                  16,
                                ),
                                child: Semantics(
                                  liveRegion: true,
                                  child: Text(
                                    _error!,
                                    style: DesktopChrome.control(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .error,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _header() => Padding(
    padding: const EdgeInsets.fromLTRB(20, 12, 12, 12),
    child: Row(
      children: [
        Expanded(
          child: Semantics(
            header: true,
            label: 'Notifications${_rows.isEmpty ? '' : ', ${_rows.length}'}',
            excludeSemantics: true,
            child: Row(
              children: [
                Flexible(
                  child: Text(
                    'Notifications',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.heading(),
                  ),
                ),
                if (_rows.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Text('${_rows.length}', style: DesktopChrome.metadata()),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        IconButton(
          key: const ValueKey('notification-inbox-close'),
          tooltip: 'Close notifications',
          onPressed: () => Navigator.of(context).pop(),
          icon: const Icon(AppIcons.close, size: 18),
          constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
          padding: const EdgeInsets.all(6),
        ),
      ],
    ),
  );

  Widget _notificationRow(InboxNotification row) {
    final opening = row.id == _opening;
    final activity = opening
        ? HarnessActivity.starting
        : switch (row.unavailable) {
            null => row.activity,
            'Starting' || 'Waiting' => HarnessActivity.starting,
            'Start failed' => HarnessActivity.failed,
            _ => HarnessActivity.offline,
          };
    final statusLabel = opening
        ? 'Opening…'
        : row.unavailable == null
        ? row.label
        : '${row.label} · ${row.unavailable}';
    final onTap = row.unavailable == null && _opening == null
        ? () => unawaited(_open(row))
        : null;
    final selected = row.id == _selected;
    final focused = selected && _focus.hasPrimaryFocus;
    return Semantics(
      label: '${row.title}, $statusLabel, ${row.detail}',
      button: true,
      excludeSemantics: true,
      enabled: onTap != null,
      onTap: onTap,
      selected: selected,
      focused: focused,
      child: MouseRegion(
        cursor: onTap != null
            ? SystemMouseCursors.click
            : SystemMouseCursors.basic,
        onEnter: (_) {
          if (_opening == null) setState(() => _selected = row.id);
        },
        child: Material(
          color: selected ? DesktopChrome.selection : Colors.transparent,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
            side: BorderSide(
              width: 1.5,
              color: focused ? DesktopChrome.accent : Colors.transparent,
            ),
          ),
          child: InkWell(
            key: ValueKey('notification:${row.id}'),
            canRequestFocus: false,
            onTap: onTap,
            borderRadius: BorderRadius.circular(8),
            hoverColor: DesktopChrome.foreground.withValues(alpha: .05),
            highlightColor: DesktopChrome.foreground.withValues(alpha: .10),
            splashFactory: NoSplash.splashFactory,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: Tooltip(
                      message: '${row.title}\n${row.detail}',
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            row.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.control(
                              medium: true,
                              color: row.unavailable == null
                                  ? DesktopChrome.foreground
                                  : DesktopChrome.muted,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            row.detail,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: DesktopChrome.metadata(),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Tooltip(
                    message: statusLabel,
                    child: SizedBox(
                      width: math.max(
                        20,
                        MediaQuery.textScalerOf(context).scale(16),
                      ),
                      child: Text(
                        activity.mark,
                        textAlign: TextAlign.center,
                        maxLines: 1,
                        style:
                            DesktopChrome.text(
                              size: 16,
                              medium: true,
                              color: _statusColor(activity),
                            ).copyWith(
                              fontFamilyFallback: [
                                ...?DesktopChrome.text().fontFamilyFallback,
                                'Apple Symbols',
                                'DejaVu Sans',
                              ],
                            ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
