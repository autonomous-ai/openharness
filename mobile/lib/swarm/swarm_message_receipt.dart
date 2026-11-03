import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_conversation.dart';
import 'swarm_message_row.dart' show swarmChatText;
import 'swarm_new_project_sheet.dart' show SwarmLeadMachine, swarmLeadMachines;
import 'swarm_request.dart';
import 'swarm_thread_line.dart' show swarmAgo;

/// How long a queued delivery's claims fail before its sender is told, and how
/// long a queued message waits with no claim fields before the same: the
/// desktop's `superTabClaimFailingNotice` and `superTabQueuedNotice` (prod
/// 10-30, v1.3.71: claims failed for two hours and nothing showed).
const swarmClaimFailingNotice = Duration(seconds: 60);
const swarmQueuedNotice = Duration(minutes: 2);

/// How long a machine's reading may stand before it is called offline: the
/// desktop's `kSuperTabMachineOfflineAfter`.
const _machineOfflineAfter = Duration(seconds: 35);

/// The line under the person's newest message while its delivery is queued and
/// not getting in, or when its computer could not confirm it: the desktop's
/// `SuperTabMessageReceipt` for those cases, its words and rule. Queued is in
/// amber with nothing to do (#2336); unconfirmed asks the person to check
/// the terminal, then send again or say it arrived
/// ([SwarmConversation.resolveDelivery]). A message that arrived carries
/// none, as in Slack.
///
/// Said only from a read of the message while it is on screen
/// ([SwarmConversation.receiptCurrent]): a row kept from before proves
/// nothing about where its delivery is now.
class SwarmMessageReceipt extends StatefulWidget {
  const SwarmMessageReceipt({
    super.key,
    required this.conversation,
    required this.message,
  });

  final SwarmConversation conversation;
  final SuperTabMessage message;

  @override
  State<SwarmMessageReceipt> createState() => _SwarmMessageReceiptState();
}

class _SwarmMessageReceiptState extends State<SwarmMessageReceipt>
    with WidgetsBindingObserver {
  Timer? _timer;
  DateTime? _wakeAt;
  bool _enabled = true;
  late Listenable _source;

  Listenable _sourceOf(SwarmConversation c) =>
      Listenable.merge([c, c.reader, c.reader.reads]);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _source = _sourceOf(widget.conversation)..addListener(_changed);
  }

  @override
  void didUpdateWidget(SwarmMessageReceipt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.conversation, widget.conversation)) {
      _source.removeListener(_changed);
      _source = _sourceOf(widget.conversation)..addListener(_changed);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled =
        TickerMode.valuesOf(context).enabled &&
        ModalRoute.isCurrentOf(context) != false;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // No frame comes in the background to let the wake-up go.
    if (state != AppLifecycleState.resumed) _wakeUpAt(null, clock.now());
    _changed();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// One wake-up at the next threshold, kept while it stays the next: no
  /// snapshot arrives to draw the line when it is crossed.
  void _wakeUpAt(DateTime? at, DateTime now) {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final next =
        !_enabled ||
            (lifecycle != null && lifecycle != AppLifecycleState.resumed)
        ? null
        : at;
    if (next == _wakeAt && (next == null || _timer?.isActive == true)) return;
    _timer?.cancel();
    _wakeAt = next;
    if (next != null) _timer = Timer(next.difference(now), _changed);
  }

  @override
  void dispose() {
    _timer?.cancel();
    _source.removeListener(_changed);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.conversation, message = widget.message;
    final reader = c.reader, snapshot = reader.snapshot, group = c.conversation;
    final delivery = message.receiptDelivery;
    final agent = delivery == null ? null : snapshot?.agent(delivery.agentId);
    final now = clock.now();
    // Desktop's "Not sent · this chat has no Lead": sent to nobody, where no
    // Lead runs. A Buddy chat has none: its Buddy takes the message.
    if (snapshot != null &&
        group != null &&
        delivery == null &&
        group.leadId == null &&
        !group.isBuddyChat &&
        reader.error == null) {
      _wakeUpAt(null, now);
      return _noLead(context, c, snapshot.isProjectLead(group.id));
    }
    // Said only of a recipient of this chat, from what was just read: a row
    // kept from before, or the Swarm out of reach, says nothing of where it is.
    if (snapshot == null ||
        !const {'queued', 'uncertain'}.contains(delivery?.status) ||
        agent == null ||
        group == null ||
        !(group.agentIds.contains(agent.id) || group.leadId == agent.id) ||
        reader.error != null ||
        !c.receiptCurrent(message)) {
      _wakeUpAt(null, now);
      return const SizedBox.shrink();
    }
    final name = snapshot.agentName(agent.id, fallback: 'Lead');
    if (delivery!.status == 'uncertain') {
      _wakeUpAt(null, now);
      return _unconfirmed(context, c, message, delivery, agent, name);
    }
    final machine = snapshot.pool(agent.machineId);
    final observation = machine?['observation'];
    final receivedAt = observation is Map ? observation['receivedAt'] : null;
    final readingAt = receivedAt is num
        ? DateTime.fromMillisecondsSinceEpoch(receivedAt.toInt())
        : null;
    final offline =
        machine != null &&
        (readingAt == null ||
            now.difference(readingAt) >= _machineOfflineAfter);
    final failingSince = delivery.claimFailingSince;
    final failingAt = failingSince?.add(swarmClaimFailingNotice);
    final queuedAt = message.createdAt?.add(swarmQueuedNotice);
    final waiting = !offline && agent.downSince == null;
    final stuck =
        waiting &&
        ((failingAt != null && !failingAt.isAfter(now)) ||
            (queuedAt != null && !queuedAt.isAfter(now)));
    // The earlier of the two is the next to cross.
    final upcoming = [
      failingAt,
      queuedAt,
    ].whereType<DateTime>().where((t) => t.isAfter(now));
    _wakeUpAt(
      waiting && !stuck && upcoming.isNotEmpty
          ? upcoming.reduce((a, b) => a.isBefore(b) ? a : b)
          : null,
      now,
    );
    if (!offline && !stuck) return const SizedBox.shrink();
    final host = machine?['name'] as String? ?? "$name's computer";
    final String title, note;
    if (offline) {
      title = "$name's computer is offline";
      note = readingAt == null
          ? "$host is offline. Your message goes in when it's back online."
          : "$host was last seen ${swarmAgo(now.difference(readingAt))}. "
                "Your message goes in when it's back online.";
    } else {
      title = 'Not delivered yet';
      note = failingSince != null
          ? "$host is online but couldn't take this message yet. "
                'Harness keeps trying, and it goes in as soon as it can.'
          : "$host is online but hasn't picked this message up yet. "
                'Harness keeps trying, and it goes in as soon as it can.';
    }
    return _line(
      icon: offline ? LucideIcons.cloudOff : LucideIcons.clock,
      color: AppPalette.warn,
      title: title,
      note: note,
    );
  }

  /// A Lead being started from this line, and what refused it.
  bool _startingLead = false;
  String? _leadError;

  /// One receipt per machine chosen, kept while its answer may have been lost,
  /// so trying again is the same start.
  final _leadStarts = <String, String>{};

  /// Desktop's no-Lead line. Add a Lead only where the phone can start one: a
  /// project chat, through `lead.start` as a new project does. A task chat's
  /// Lead comes from Desktop's New Harness box, which the phone has not.
  Widget _noLead(BuildContext context, SwarmConversation c, bool projectChat) {
    final free = c.canPost && !_startingLead;
    return _line(
      icon: LucideIcons.triangleAlert,
      color: Theme.of(context).colorScheme.error,
      title: 'Not sent · this chat has no Lead',
      note: _leadError,
      actions: [
        if (projectChat)
          _ReceiptLink(
            key: const ValueKey('swarm-receipt-add-lead'),
            label: 'Add a Lead',
            busy: _startingLead,
            dimmed: !free && !_startingLead,
            onPressed: free ? () => unawaited(_pickLeadMachine(c)) : null,
          ),
      ],
    );
  }

  /// The Swarm's machines that could run the project's Lead, as New project
  /// lists them; one that cannot now is listed with why, and not picked.
  Future<void> _pickLeadMachine(SwarmConversation c) async {
    final snapshot = c.reader.snapshot;
    if (snapshot == null) return;
    final machines = swarmLeadMachines(
      snapshot,
      c.reader.accountId,
      now: clock.now(),
    );
    if (machines.isEmpty) {
      setState(
        () => _leadError =
            'No machine in this Swarm can run a Lead. Add one on Desktop.',
      );
      return;
    }
    await showPhoneSheet(
      context,
      title: 'Machine',
      sections: [
        PhoneSheetSection(
          actions: [
            for (final m in machines)
              PhoneSheetAction(
                icon: LucideIcons.laptop,
                label: m.name,
                value: m.startable ? null : m.detail,
                enabled: m.startable,
                onTap: () => unawaited(_startLead(c, m)),
              ),
          ],
        ),
      ],
    );
  }

  Future<void> _startLead(SwarmConversation c, SwarmLeadMachine machine) async {
    final reader = c.reader;
    final group = c.conversation;
    final project = group == null
        ? null
        : reader.snapshot?.projectFor(group.id);
    if (project == null || _startingLead || !machine.startable) return;
    final url = project.repository?['repositoryUrl'];
    final operationId = _leadStarts[machine.id] ??= superTabOperationId();
    setState(() {
      _startingLead = true;
      _leadError = null;
    });
    try {
      await reader.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
        body: {
          'operationId': operationId,
          'command': {
            'type': 'lead.start',
            'projectId': project.id,
            'machineId': machine.id,
            'engine': machine.engine,
            if (url is String && url.isNotEmpty) 'repositoryUrl': url,
          },
        },
      );
      _leadStarts.remove(machine.id);
      unawaited(reader.refresh());
    } on SuperTabFailure catch (failure) {
      // Refused, it made no start: the next try is a new one.
      final status = failure.statusCode;
      if (status >= 400 && status < 500 && status != 408 && status != 429) {
        _leadStarts.remove(machine.id);
      }
      if (mounted) setState(() => _leadError = failure.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => _leadError = 'Couldn’t start the Lead. Try again to check it.',
        );
      }
    } finally {
      if (mounted) setState(() => _startingLead = false);
    }
  }

  /// The desktop's "Couldn't confirm delivery": its computer may have typed
  /// it without confirming, so the person checks before it goes again. Open
  /// terminal only where this phone can open that computer's terminals.
  Widget _unconfirmed(
    BuildContext context,
    SwarmConversation c,
    SuperTabMessage message,
    SuperTabDelivery delivery,
    SuperTabAgent agent,
    String name,
  ) {
    final shell = PhoneShellScope.maybeOf(context);
    final reachable =
        shell != null &&
        agent.harnessId.isNotEmpty &&
        shell.canOpenMachine?.call(agent.machineId) == true;
    final resolving = c.resolving;
    final free = c.canPost && resolving == null && delivery.id != null;
    Widget action(String label, String resolution, VoidCallback onPressed) {
      final busy = resolving == (delivery.id, resolution);
      return _ReceiptLink(
        key: ValueKey('swarm-receipt-$resolution'),
        label: label,
        busy: busy,
        dimmed: !free && !busy,
        onPressed: free ? onPressed : null,
      );
    }

    void resolve(String resolution) =>
        unawaited(c.resolveDelivery(message, delivery, resolution));
    return _line(
      icon: LucideIcons.triangleAlert,
      // As the desktop draws it: the theme's error ink, which reads on
      // either surface.
      color: Theme.of(context).colorScheme.error,
      title: "Couldn't confirm delivery",
      note:
          "$name's computer may have typed this into the terminal without "
          'confirming. Check the terminal before sending again, or it could '
          'run twice.',
      actions: [
        if (reachable)
          action('Open terminal', 'open', () {
            // Checked again at the tap: the phone may have lost it since.
            if (shell.canOpenMachine?.call(agent.machineId) == true) {
              shell.onOpenAgent(agent.machineId, agent.harnessId);
            }
          }),
        action('Send again', 'resend', () => resolve('resend')),
        action('It arrived', 'received', () => resolve('received')),
      ],
    );
  }

  Widget _line({
    required IconData icon,
    required Color color,
    required String title,
    String? note,
    List<Widget> actions = const [],
  }) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            liveRegion: true,
            child: Row(
              children: [
                Icon(icon, size: 16, color: color),
                const SizedBox(width: AppSpace.xs),
                Flexible(
                  child: Text(title, style: swarmChatText(14, color: color)),
                ),
              ],
            ),
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.xs),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: color.withValues(alpha: .09),
                  borderRadius: BorderRadius.circular(AppCard.insetRadius),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(AppSpace.s),
                  child: SizedBox(
                    width: double.infinity,
                    child: Text(
                      note,
                      style: AppType.caption(
                        color: AppPalette.textSecondary,
                        height: 1.45,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          // Each link's own padding sets it in from the note's edge: the
          // first is pulled back to line up with it.
          if (actions.isNotEmpty)
            Transform.translate(
              offset: const Offset(-AppSpace.s, 0),
              child: Wrap(children: actions),
            ),
        ],
      ),
    );
  }
}

/// One answer on the line: words in the accent, 44 points tall to tap, with
/// little room to the side so the three share one line at 390 points.
class _ReceiptLink extends StatelessWidget {
  const _ReceiptLink({
    super.key,
    required this.label,
    required this.busy,
    required this.dimmed,
    required this.onPressed,
  });

  final String label;
  final bool busy, dimmed;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final ink = AppPalette.swarmAccent;
    return Semantics(
      button: true,
      enabled: onPressed != null,
      label: label,
      excludeSemantics: true,
      child: Opacity(
        opacity: dimmed ? .45 : 1,
        child: InkWell(
          borderRadius: BorderRadius.circular(AppControl.radius),
          onTap: onPressed,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (busy) ...[
                    SizedBox.square(
                      dimension: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: ink,
                      ),
                    ),
                    const SizedBox(width: AppSpace.xs),
                  ],
                  Text(
                    label,
                    style: swarmChatText(
                      15,
                      color: ink,
                      weight: FontWeight.w500,
                      height: 1.25,
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
