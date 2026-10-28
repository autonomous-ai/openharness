import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/harness_activity.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';

/// The approved receipt line, scoped by the chat to its newest own message.
/// No new transport is inferred: missing native activity simply reads Delivered.
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

  String _clockText(Duration value) {
    final seconds = value.inSeconds.clamp(0, 1 << 31);
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }

  String _replyDuration(Duration value) {
    final seconds = value.inSeconds.clamp(0, 1 << 31);
    return seconds < 60 ? '${seconds}s' : '${seconds ~/ 60}m ${seconds % 60}s';
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
    final working =
        delivery?.delivered == true &&
        agent != null &&
        widget.app != null &&
        harnessActivity(widget.app!, agent.machineId, agent.harnessId) ==
            HarnessActivity.working;
    final fresh =
        delivery?.pending == true &&
        message.createdAt != null &&
        now.difference(message.createdAt!) < const Duration(seconds: 3);
    var color = DesktopChrome.muted;
    var icon = AppIcons.check;
    String title = 'Sent';
    String? detail, note, elapsed;
    bool sending = false;
    final actions = <(String, VoidCallback?)>[];
    final canResolve = c.canWrite && !c.saving && delivery?.id != null;

    if (delivery?.status == 'uncertain') {
      title = "Couldn't confirm delivery";
      icon = AppIcons.triangleAlert;
      color = Theme.of(context).colorScheme.error;
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
    } else if (delivery?.status == 'answered') {
      title = 'Replied';
      icon = AppIcons.checkCheck;
      final answer = delivery?.answeredAt ?? delivery?.updatedAt;
      final start = delivery?.deliveredAt ?? message.createdAt;
      if (answer != null && start != null) {
        title += ' · ${_replyDuration(answer.difference(start))}';
      }
    } else if (delivery?.delivered == true) {
      icon = AppIcons.checkCheck;
      final at = (delivery!.deliveredAt ?? delivery.updatedAt)?.toLocal();
      title = at == null
          ? 'Delivered'
          : 'Delivered ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';
      if (working) {
        color = DesktopChrome.accent;
        detail = '$name is working';
        if (delivery.deliveredAt != null) {
          elapsed = _clockText(now.difference(delivery.deliveredAt!));
        }
      }
    } else if (delivery == null &&
        c.selected?.leadId == null &&
        // Every person reads the Product Managers' conversation; a post there
        // stands even before any Product Manager receives it.
        c.selected?.id != c.snapshot?.leadsConversationId) {
      title = 'Not sent · this chat has no Lead';
      icon = AppIcons.triangleAlert;
      color = Theme.of(context).colorScheme.error;
      actions.add(('Add a Lead', c.canWrite ? widget.onAddLead : null));
    } else if (delivery?.status == 'cancelled') {
      title = 'Not sent';
      icon = AppIcons.triangleAlert;
      color = Theme.of(context).colorScheme.error;
    } else if (delivery?.pending == true && offline) {
      color = grid.AppPalette.warn;
      detail = "$name's computer is offline";
      final host =
          machine?['name'] as String? ?? widget.machineName(agent!.machineId);
      note = readingAt == null
          ? "$host is offline. Your message goes in when it's back online."
          : "$host was last seen ${superTabAgo(now.difference(readingAt))}. Your message goes in when it's back online.";
    } else if (fresh) {
      title = 'Sending…';
      sending = true;
    }
    _clock(fresh || working || (delivery?.pending == true && offline));
    final style = DesktopChrome.metadata(color: color).copyWith(
      fontSize: 12,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    final motion = !MediaQuery.disableAnimationsOf(context);
    final parts = <Widget>[
      if (sending && motion)
        SizedBox(
          width: 12,
          height: 12,
          child: CircularProgressIndicator(strokeWidth: 1.5, color: color),
        )
      else
        Icon(sending ? AppIcons.loaderCircle : icon, size: 14, color: color),
      Text(title, style: style),
      if (detail != null) ...[
        Text('·', style: style),
        Text(detail, style: style),
      ],
      if (working) ...[
        ExcludeSemantics(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < 3; i++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 1.5),
                  child: Opacity(
                    opacity:
                        !motion || (now.millisecondsSinceEpoch ~/ 500) % 3 == i
                        ? 1
                        : .25,
                    child: Container(
                      width: 4,
                      height: 4,
                      decoration: BoxDecoration(
                        color: color,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        if (elapsed != null) Text(elapsed, style: style),
      ],
      for (final (label, action) in actions) ...[
        Text('·', style: style),
        TextButton(
          onPressed: action,
          style: TextButton.styleFrom(
            foregroundColor: DesktopChrome.accent,
            padding: const EdgeInsets.symmetric(horizontal: 2),
            minimumSize: const Size(0, 32),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            textStyle: style,
          ),
          child: Text(label),
        ),
      ],
    ];
    return Padding(
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
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: color.withValues(alpha: .09),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 6,
                  ),
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
      ),
    );
  }
}
