import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';

import 'swarm_page.dart' show swarmHomeListed;
import 'swarm_project_page.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Opens Jump to over Home. A new message starts from Home's + instead
/// (`swarm_new_message_sheet.dart`).
void openSwarmJump(BuildContext context) => unawaited(
  Navigator.of(context)
      .push(phoneRoute((_) => const SwarmJumpPage(), listensForItself: true)),
);

/// Jump to…, from Swarm Home (Tony's prototype C1, 2026-10-30): every
/// project of the account's Swarms that can be read, by name, narrowed as
/// the person types; one picked opens on its chat, in place of this page.
/// A Swarm the account loses, or whose read is taken away, leaves the list
/// as it goes, and a tap on one of its projects opens nothing. A Swarm that
/// could not be read says so, never that there is no project.
class SwarmJumpPage extends StatefulWidget {
  const SwarmJumpPage({super.key});

  @override
  State<SwarmJumpPage> createState() => _SwarmJumpPageState();
}

class _SwarmJumpPageState extends State<SwarmJumpPage> {
  final _query = TextEditingController();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  void _open(SwarmSession session, String swarmId, String projectId) {
    if (!swarmHomeListed(session.inbox, swarmId, projectId)) return;
    openSwarmProject(
      context,
      swarmId: swarmId,
      projectId: projectId,
      replace: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = SwarmScope.of(context);
    return Scaffold(
      backgroundColor: Tty.of(context).ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpace.m,
                AppSpace.xs,
                AppSpace.xs,
                AppSpace.s,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const ValueKey('swarm-jump-query'),
                      controller: _query,
                      autofocus: true,
                      textInputAction: TextInputAction.search,
                      onChanged: (_) => setState(() {}),
                      style: AppType.body(color: AppPalette.textPrimary),
                      decoration: InputDecoration(
                        hintText: 'Jump to…',
                        hintStyle: AppType.body(color: AppPalette.textFaint),
                        filled: true,
                        fillColor: AppPalette.swarmSearchSurface,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: AppSpace.m,
                          vertical: AppSpace.m,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(AppCard.radius),
                          borderSide: BorderSide.none,
                        ),
                      ),
                    ),
                  ),
                  ConstrainedBox(
                    constraints: const BoxConstraints(
                      minWidth: minTouchTarget,
                      minHeight: minTouchTarget,
                    ),
                    child: TextButton(
                      key: const ValueKey('swarm-jump-cancel'),
                      onPressed: () => Navigator.of(context).maybePop(),
                      child: Text(
                        'Cancel',
                        style: AppType.body(color: AppPalette.textSecondary),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: session == null
                  ? const SizedBox.shrink()
                  : ListenWhileInSight(
                      listenable: Listenable.merge([session, session.inbox]),
                      builder: (context) => ListView(
                        keyboardDismissBehavior:
                            ScrollViewKeyboardDismissBehavior.onDrag,
                        padding: EdgeInsets.fromLTRB(
                          AppSpace.m,
                          0,
                          AppSpace.m,
                          MediaQuery.paddingOf(context).bottom + AppSpace.xl,
                        ),
                        children: _rows(session),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _rows(SwarmSession session) {
    final inbox = session.inbox;
    final swarms = inbox.swarms;
    final several = swarms.length > 1;
    final query = _query.text.trim().toLowerCase();
    final found = <({String swarmId, String swarm, String id, String name})>[];
    // The list, or a Swarm on it, that could not be read: not "no project".
    var failed = !inbox.loaded && (inbox.error != null || inbox.noComputer);
    var reading = !inbox.loaded && !failed;
    for (final swarm in swarms) {
      final reader = inbox.reader(swarm.id);
      if (reader == null || reader.accessRevoked) continue;
      if (reader.loading) reading = true;
      if (reader.snapshot == null && reader.error != null) failed = true;
      for (final project in reader.snapshot?.projects ?? const []) {
        if (query.isNotEmpty && !project.name.toLowerCase().contains(query)) {
          continue;
        }
        found.add((
          swarmId: swarm.id,
          swarm: swarm.name,
          id: project.id,
          name: project.name,
        ));
      }
    }
    found.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    Widget line(String text, String key) => Padding(
      padding: const EdgeInsets.all(AppSpace.xs),
      child: SwarmRow.line(text, key: ValueKey(key), lines: 2),
    );
    const unread =
        'Some projects could not be loaded. Pull down on Home to '
        'try again.';
    if (found.isEmpty) {
      if (reading) return [SwarmSkeletonRows(id: 'swarm-jump-loading')];
      if (failed) return [line(unread, 'swarm-jump-unread')];
      return [
        line(
          query.isEmpty ? 'No project yet.' : 'No project matches.',
          'swarm-jump-none',
        ),
      ];
    }
    return [
      SwarmGroup(
        children: [
          for (final p in found)
            SwarmRow(
              key: ValueKey('swarm-jump-${p.swarmId}-${p.id}'),
              leading: SwarmProjectTile(p.name),
              title: p.name,
              detail: several ? SwarmRow.line(p.swarm) : null,
              onTap: () => _open(session, p.swarmId, p.id),
            ),
        ],
      ),
      if (failed) line(unread, 'swarm-jump-unread'),
    ];
  }
}
