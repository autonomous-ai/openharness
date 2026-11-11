import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../core/models.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'machine_status.dart';
import 'model.dart';
import 'personal_lead.dart';

/// How long a queued delivery's claims fail before its sender is told, and how
/// long a queued message waits with no claim fields before the same (prod 10-30,
/// v1.3.71: claims failed for two hours and nothing showed).
const superTabClaimFailingNotice = Duration(seconds: 60);
const superTabQueuedNotice = Duration(minutes: 2);

/// The line under the chat's newest own message, as iMessage's Delivered:
/// Sending…, Sent once the server has it, Typed once it is in its agent's
/// session, and nothing once its agent answers, the answer being the third
/// state (Swarm plan, step 1, item 2, 2026-11-11). Two minutes on and not
/// typed, it says why; Not sent, offline and a delivery that needs a hand keep
/// their own lines.
class SuperTabMessageReceipt extends StatefulWidget {
  const SuperTabMessageReceipt({
    super.key,
    required this.message,
    required this.controller,
    required this.onResolve,
    required this.onAddLead,
    required this.machineName,
    this.app,
    this.now,
  });
  final SuperTabMessage message;
  final SuperTabController controller;
  final AppNotifier? app;
  final void Function(SuperTabDelivery delivery, String resolution) onResolve;
  final VoidCallback onAddLead;
  final String Function(String machineId) machineName;

  /// Defaults to the package clock, which tests move (a const default cannot).
  final DateTime Function()? now;

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
    _listen(widget.app);
  }

  /// [app], and the Lead its Personal project starts (personal_lead.dart).
  void _listen(AppNotifier? app) {
    app?.addListener(_changed);
    if (app != null) PersonalLeadStarter.of(app).addListener(_changed);
  }

  void _unlisten(AppNotifier? app) {
    app?.removeListener(_changed);
    if (app != null) PersonalLeadStarter.of(app).removeListener(_changed);
  }

  @override
  void didUpdateWidget(SuperTabMessageReceipt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.app != widget.app) {
      _unlisten(oldWidget.app);
      _listen(widget.app);
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

  void _clock(bool needed, [Duration? until]) {
    _timer?.cancel();
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    if (!needed ||
        !_enabled ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed)) {
      return;
    }
    // A notice threshold is one wake-up at its time, not a tick every 500 ms.
    final wait = until ?? const Duration(milliseconds: 500);
    _timer = Timer(wait.isNegative ? Duration.zero : wait, _changed);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _unlisten(widget.app);
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
    final now = widget.now?.call() ?? clock.now();
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
    // Waiting to be typed into an agent of this Swarm on an online, readable
    // computer. Two minutes after it was sent, or a minute into failing claims
    // (prod 10-30, v1.3.71: claims failed for two hours and nothing showed),
    // the line says why it is not typed yet. Either reason shows it, so it
    // never drops out when the other one starts.
    final waiting =
        delivery?.pending == true &&
        agent != null &&
        !offline &&
        !c.backendUnreachable;
    // A claim's failure fields mean something only while it is queued: a
    // claimed copy may carry an earlier one's.
    final failingSince = delivery?.status == 'queued'
        ? delivery?.claimFailingSince
        : null;
    final failingAt = failingSince?.add(superTabClaimFailingNotice);
    final lateAt = message.createdAt?.add(superTabQueuedNotice);
    final late =
        waiting &&
        ((failingAt != null && !failingAt.isAfter(now)) ||
            (lateAt != null && !lateAt.isAfter(now)));
    // Until a threshold is crossed the receipt must tick by itself: no snapshot
    // arrives to rebuild it. The earlier of the two is the next to cross.
    final upcoming = [
      failingAt,
      lateAt,
    ].whereType<DateTime>().where((t) => t.isAfter(now));
    final nextAt = waiting && !late && upcoming.isNotEmpty
        ? upcoming.reduce((a, b) => a.isBefore(b) ? a : b)
        : null;
    final error = Theme.of(context).colorScheme.error;
    var color = error;
    var icon = AppIcons.triangleAlert;
    String? title, note;
    bool sending = false, quiet = false;
    final actions = <(String, VoidCallback?)>[];
    final canResolve = c.canWrite && !c.saving && delivery?.id != null;
    // Only the person's own words wait: a row the server wrote under their
    // name (a start that failed) says what happened itself.
    final waitingFor = delivery == null && message.source['kind'] is! String
        ? c.snapshot?.projectWaitingIn(message.conversationId)
        : null;

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
    } else if (waitingFor case final project?) {
      // Its PM's own chat while the PM starts (backend pmChat.ts): the server
      // keeps the message for it. A Personal Swarm's start that failed here
      // says why.
      final app = widget.app;
      final start = app == null
          ? null
          : PersonalLeadStarter.of(app).statusOf(c, project.leadConversationId);
      if (start?.reason case final reason?) {
        title = 'Couldn’t start the Product Manager: $reason';
      } else {
        color = DesktopChrome.muted;
        icon = AppIcons.clock;
        title = 'Waiting for the Product Manager';
      }
    } else if (delivery == null &&
        c.selected?.leadId == null &&
        // An agent's own chat has no Lead: its agent takes the message.
        c.selected?.isAgentChat != true) {
      // A Personal project's PM starts from its channel's card, and its
      // person talks to it in its own chat (personal_lead.dart).
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
    } else if (late) {
      // Send again would wait behind the same thing: the line says what it is,
      // and offers the terminal when its person can see to it there.
      color = grid.AppPalette.warn;
      icon = AppIcons.clock;
      title = 'Not typed yet';
      final host =
          machine?['name'] as String? ?? widget.machineName(agent.machineId);
      final (why, inTerminal) = superTabNotTypedWhy(
        delivery!,
        name: name,
        host: host,
        stopped: agent.downSince != null,
      );
      note = why;
      if (inTerminal) {
        actions.add((
          'Open terminal',
          canResolve ? () => widget.onResolve(delivery, 'open') : null,
        ));
      }
    } else if (fresh) {
      color = DesktopChrome.muted;
      title = 'Sending…';
      sending = true;
    } else if (delivery?.pending == true) {
      color = DesktopChrome.muted;
      title = 'Sent';
      quiet = true;
    } else if (delivery?.delivered == true) {
      color = DesktopChrome.muted;
      title = 'Typed';
      quiet = true;
    }
    final ticking = fresh || (delivery?.pending == true && offline);
    _clock(ticking || nextAt != null, ticking ? null : nextAt?.difference(now));
    if (title == null) return const SizedBox.shrink();
    final style = superTabReceiptStyle(color);
    final parts = <Widget>[
      if (sending)
        _sendingMark(context, color)
      else if (!quiet)
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

/// Why [delivery], sent to [name] on [host], is not typed yet, and whether its
/// person can see to it in the agent's terminal: what holds it there, as the
/// daemon reads the pane (cli core/input.ts; closeAgentService.ts reads
/// `team_waiting_user` as waiting on its person and `team_waiting_draft` as
/// unsent text), else why its computer has not taken it.
(String, bool) superTabNotTypedWhy(
  SuperTabDelivery delivery, {
  required String name,
  required String host,
  required bool stopped,
}) {
  if (stopped) {
    return (
      "$name isn't running. Your message goes in when it runs again.",
      false,
    );
  }
  if (delivery.status == 'queued') {
    return (
      delivery.claimFailingSince != null
          ? "$host is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can."
          : "$host is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can.",
      false,
    );
  }
  return switch (delivery.holdReason) {
    'team_waiting_idle' || 'team_waiting_busy' => (
      '$name is working. Your message goes in when this turn ends.',
      false,
    ),
    'team_waiting_user' => (
      '$name is waiting on your answer in its terminal.',
      true,
    ),
    'team_waiting_draft' => ("$name's terminal has unsent text.", true),
    'team_waiting_dialog' => ("$name's terminal has a menu open.", true),
    _ => (
      "$name can't take messages right now. Harness keeps trying, and it goes in as soon as it can.",
      false,
    ),
  };
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

/// The line under your own message: [parts] in a row that wraps, announced as
/// it changes, with [below] under it, at the bubble's side as iMessage's
/// Delivered is (desktop-design-system.md, Message states).
Widget _receiptLine(List<Widget> parts, {List<Widget> below = const []}) =>
    Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Semantics(
            liveRegion: true,
            child: Wrap(
              alignment: WrapAlignment.end,
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
    this.inline = false,
  });
  final SuperTabOutgoing message;
  final bool inline;

  Widget _line(List<Widget> parts) => inline
      ? Semantics(
          liveRegion: true,
          child: Wrap(
            spacing: grid.AppDesktop.controlGap,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: parts,
          ),
        )
      : _receiptLine(parts);

  /// Null while it cannot be done now, as during another send.
  final VoidCallback? onRetry;
  final VoidCallback onDelete;

  @override
  Widget build(BuildContext context) {
    if (message.state == SuperTabOutgoingState.sending) {
      final style = superTabReceiptStyle(DesktopChrome.muted);
      return _line([
        if (!inline) _sendingMark(context, DesktopChrome.muted),
        Text('Sending…', style: style),
      ]);
    }
    final color = Theme.of(context).colorScheme.error;
    final style = superTabReceiptStyle(color);
    final refused = message.state == SuperTabOutgoingState.refused;
    return _line([
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
