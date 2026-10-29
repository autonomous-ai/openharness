import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'swarm_conversation_page.dart';
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens everything that needs the person over [context]'s page, [focus]
/// open — a need's key — else the first; only Swarm [swarmId]'s when Home
/// shows that Swarm alone.
void openSwarmNeeds(BuildContext context, {String? focus, String? swarmId}) =>
    unawaited(
      Navigator.of(context).push(
        phoneRoute(
          (_) => SwarmNeedsPage(focus: focus, swarmId: swarmId),
          listensForItself: true,
        ),
      ),
    );

/// The needs Home shows: every Swarm's, or [swarmId]'s alone.
List<SwarmNeed> swarmNeedsOf(SwarmInbox inbox, String? swarmId) => [
  for (final need in inbox.needs)
    if (swarmId == null || need.swarmId == swarmId) need,
];

/// Everything that needs the person, from Home's "See all" or one of its
/// rows: one thing open at a time with what can be done with it
/// ([SwarmNeedRow]) — the one tapped, while it waits, else the first;
/// answered or done, the next one opens — and the others a line each that
/// opens it in its place.
class SwarmNeedsPage extends StatefulWidget {
  const SwarmNeedsPage({super.key, this.focus, this.swarmId});

  /// The need open first, by its key.
  final String? focus;

  /// Only this Swarm's needs; null for every Swarm's.
  final String? swarmId;

  @override
  State<SwarmNeedsPage> createState() => _SwarmNeedsPageState();
}

class _SwarmNeedsPageState extends State<SwarmNeedsPage> {
  SwarmSession? _session;
  late String? _focus = widget.focus;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _session?.leave();
    _session = session?..enter();
  }

  @override
  void dispose() {
    _session?.leave();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Needs you',
            ),
            Expanded(
              child: session == null
                  ? const SizedBox.shrink()
                  : ListenableBuilder(
                      listenable: Listenable.merge([session, session.inbox]),
                      builder: (context, _) => ListView(
                        padding: EdgeInsets.fromLTRB(
                          AppSpace.m,
                          AppSpace.s,
                          AppSpace.m,
                          MediaQuery.paddingOf(context).bottom + AppSpace.xl,
                        ),
                        children: _needs(context, session),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _needs(BuildContext context, SwarmSession session) {
    final needs = swarmNeedsOf(session.inbox, widget.swarmId);
    if (needs.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
          child: SwarmRow.line(
            'Nothing needs you.',
            key: const ValueKey('swarm-needs-none'),
          ),
        ),
      ];
    }
    final open = needs.firstWhere(
      (need) => need.key == _focus,
      orElse: () => needs.first,
    );
    return [
      SwarmGroup(
        children: [
          for (final need in needs)
            if (need == open)
              SwarmNeedRow(
                session: session,
                need: need,
                onOpen: (swarmId, conversationId) =>
                    openSwarmConversation(context, swarmId, conversationId),
              )
            else
              SwarmNeedLine(
                key: ValueKey('swarm-need-row-${need.key}'),
                session: session,
                need: need,
                onTap: () => setState(() => _focus = need.key),
              ),
        ],
      ),
    ];
  }
}
