import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';

/// The line under the chat's newest own message, shown only while it sends,
/// when it was not sent, or when its delivery needs a hand; a message that
/// arrived carries none, as in Slack.
class SuperTabMessageReceipt extends StatefulWidget {
  const SuperTabMessageReceipt({
    super.key,
    required this.message,
    required this.controller,
    required this.onResolve,
    required this.onAddLead,
    required this.machineName,
    this.app,
    this.now = DateTime.now,
  });
  final SuperTabMessage message;
  final SuperTabController controller;
  final AppNotifier? app;
  final void Function(SuperTabDelivery delivery, String resolution) onResolve;
  final VoidCallback onAddLead;
  final String Function(String machineId) machineName;
  final DateTime Function() now;

  @override
  State<SuperTabMessageReceipt> createState() => _SuperTabMessageReceiptState();
}

class _SuperTabMessageReceiptState extends State<SuperTabMessageReceipt>
    with WidgetsBindingObserver {
  Timer? _timer;
  bool _enabled = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.app?.addListener(_changed);
  }

  @override
  void didUpdateWidget(SuperTabMessageReceipt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      oldWidget.app?.removeListener(_changed);
      widget.app?.addListener(_changed);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled =
        TickerMode.valuesOf(context).enabled &&
        ModalRoute.isCurrentOf(context) != false;
    if (!_enabled) _timer?.cancel();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => _changed();

  void _changed() {
    if (mounted) setState(() {});
  }

  void _clock(bool needed) {
    _timer?.cancel();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (!needed ||
        !_enabled ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      return;
    }
    _timer = Timer(const Duration(milliseconds: 500), _changed);
  }

  @override
  void dispose() {
    _timer?.cancel();
    widget.app?.removeListener(_changed);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final message = widget.message, c = widget.controller;
    final delivery = message.receiptDelivery;
    final agent = c.snapshot?.agent(delivery?.agentId ?? '');
    final name =
        c.snapshot?.agentName(delivery?.agentId ?? '', fallback: 'Lead') ??
        'Lead';
    final now = widget.now();
    final machine = c.snapshot?.machines
        .where((m) => m['machineId'] == agent?.machineId)
        .firstOrNull;
    final observation = machine?['observation'];
    final receivedAt = observation is Map ? observation['receivedAt'] : null;
    final readingAt = receivedAt is num
        ? DateTime.fromMillisecondsSinceEpoch(receivedAt.toInt())
        : null;
    final native = agent == null ? null : widget.app?.stateOf(agent.machineId);
    final direct = native?.isLocalMachine == true;
    // A computer this Desktop reads itself is known by its own connection, not by a Swarm reading it may not have.
    final offline =
        !c.backendUnreachable &&
        (direct
            ? native!.connectionStatus != ConnectionStatus.connected ||
                  native.isOffline
            : machine != null &&
                  superTabMachineStatus(
                        age: readingAt == null
                            ? null
                            : now.difference(readingAt),
                      ) ==
                      SuperTabMachineStatus.offline);
    final fresh =
        delivery?.pending == true &&
        message.createdAt != null &&
        now.difference(message.createdAt!) < const Duration(seconds: 3);
    final error = Theme.of(context).colorScheme.error;
    var color = error;
    var icon = AppIcons.triangleAlert;
    // Like Slack, a message that went where it was sent carries no line: only
    // sending, not sending and what needs a hand show (Dee, 10-29).
    String? title, note;
    bool sending = false;
    final actions = <(String, VoidCallback?)>[];
    final canResolve = c.canWrite && !c.saving && delivery?.id != null;

    if (delivery?.status == 'uncertain') {
      title = "Couldn't confirm delivery";
      note =
          "$name's computer may have typed this into the terminal without confirming. Check the terminal before sending again, or it could run twice.";
      for (final (label, resolution) in [
        ('Open terminal', 'open'),
        ('Send again', 'resend'),
        ('It arrived', 'received'),
      ]) {
        actions.add((
          label,
          canResolve && (resolution != 'open' || agent != null)
              ? () => widget.onResolve(delivery!, resolution)
              : null,
        ));
      }
    } else if (delivery == null &&
        c.selected?.leadId == null &&
        // Every person reads the Product Managers' conversation; a post there
        // stands even before any Product Manager receives it.
        c.selected?.id != c.snapshot?.leadsConversationId &&
        // A Buddy chat has no Lead: its Buddy takes the message.
        c.selected?.isBuddyChat != true) {
      title = 'Not sent · this chat has no Lead';
      actions.add(('Add a Lead', c.canWrite ? widget.onAddLead : null));
    } else if (delivery?.status == 'cancelled') {
      title = 'Not sent';
    } else if (delivery?.pending == true && offline) {
      color = grid.AppPalette.warn;
      icon = AppIcons.cloudOff;
      title = "$name's computer is offline";
      final host =
          machine?['name'] as String? ?? widget.machineName(agent!.machineId);
      note = readingAt == null
          ? "$host is offline. Your message goes in when it's back online."
          : "$host was last seen ${superTabAgo(now.difference(readingAt))}. Your message goes in when it's back online.";
    } else if (fresh) {
      color = DesktopChrome.muted;
      title = 'Sending…';
      sending = true;
    }
    _clock(fresh || (delivery?.pending == true && offline));
    if (title == null) return const SizedBox.shrink();
    final style = superTabReceiptStyle(color);
    final parts = <Widget>[
      if (sending)
        _sendingMark(context, color)
      else
        Icon(icon, size: 14, color: color),
      Text(title, style: style),
      for (final (label, action) in actions) ...[
        Text('·', style: style),
        _receiptAction(label, action, style),
      ],
    ];
    return _receiptLine(
      parts,
      below: [
        if (note != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: color.withValues(alpha: .09),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Text(
                  note,
                  style: DesktopChrome.metadata().copyWith(
                    fontSize: 12,
                    height: 1.45,
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// Sending's mark: a small spinner, or a still loader when motion is off.
Widget _sendingMark(BuildContext context, Color color) =>
    MediaQuery.disableAnimationsOf(context)
    ? Icon(AppIcons.loaderCircle, size: 14, color: color)
    : SizedBox(
        width: 12,
        height: 12,
        child: CircularProgressIndicator(strokeWidth: 1.5, color: color),
      );

/// A receipt line's text: small metadata in [color], with figures that keep
/// their width as a clock counts.
TextStyle superTabReceiptStyle(Color color) => DesktopChrome.metadata(
  color: color,
).copyWith(fontSize: 12, fontFeatures: const [FontFeature.tabularFigures()]);

/// An action on a receipt line, read as a link in the line's text; a
/// destructive one passes the error [color].
Widget _receiptAction(
  String label,
  VoidCallback? onPressed,
  TextStyle style, {
  Color? color,
}) => TextButton(
  onPressed: onPressed,
  // Quiet, as inline controls are: no fill or rim at rest, the shared hover
  // wash, and the focus ring for the keyboard. Every receipt action (Retry,
  // Delete, Add a Lead, Open terminal, Send again, It arrived) is drawn here.
  style:
      TextButton.styleFrom(
        foregroundColor: color ?? DesktopChrome.accent,
        backgroundColor: Colors.transparent,
        // Given a foreground, styleFrom tints hover with it; quiet controls
        // share the neutral wash the theme's buttons and rows use.
        overlayColor: grid.AppSurface.hoverFill,
        padding: const EdgeInsets.symmetric(horizontal: 2),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        textStyle: style,
      ).copyWith(
        side: WidgetStateProperty.resolveWith(
          (states) => BorderSide(
            width: grid.AppDesktop.focusWidth,
            color: states.contains(WidgetState.focused)
                ? DesktopChrome.focusRing
                : Colors.transparent,
          ),
        ),
      ),
  child: Text(label),
);

/// The line under a message: [parts] in a row that wraps, announced as it
/// changes, with [below] under it.
Widget _receiptLine(List<Widget> parts, {List<Widget> below = const []}) =>
    Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            liveRegion: true,
            child: Wrap(
              spacing: 6,
              runSpacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: parts,
            ),
          ),
          ...below,
        ],
      ),
    );

/// The line under a message the transcript does not hold yet: Sending…, or
/// Not sent with what can be done about it (design: Ken, 10-28).
class SuperTabOutgoingReceipt extends StatelessWidget {
  const SuperTabOutgoingReceipt({
    super.key,
    required this.message,
    required this.onDelete,
    this.onRetry,
  });
  final SuperTabOutgoing message;

  /// Null while it cannot be done now, as during another send.
  final VoidCallback? onRetry;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    if (message.state == SuperTabOutgoingState.sending) {
      final style = superTabReceiptStyle(DesktopChrome.muted);
      return _receiptLine([
        _sendingMark(context, DesktopChrome.muted),
        Text('Sending…', style: style),
      ]);
    }
    final color = Theme.of(context).colorScheme.error;
    final style = superTabReceiptStyle(color);
    final refused = message.state == SuperTabOutgoingState.refused;
    return _receiptLine([
      Icon(AppIcons.triangleAlert, size: 14, color: color),
      Text('Not sent', style: style),
      if (refused && message.error != null) ...[
        Text('·', style: style),
        Text(message.error!, style: style),
      ],
      Text('·', style: style),
      _receiptAction('Retry', onRetry, style),
      Text('·', style: style),
      _receiptAction('Delete', onDelete, style, color: color),
    ]);
  }
}
