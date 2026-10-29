import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// One model on Your models: its name, who serves an API ([provider]), and
/// the computer that offers it.
typedef SwarmModelRow = ({String name, String? provider, String machine});

/// The models a Swarm can use now, by what each is — the words of Desktop's
/// machine details: [apis] a member shares, [local] models of members' own
/// running on the Swarm's grid, and models shared with one machine's owner,
/// usable on that machine alone ([oneComputer]).
class SwarmModelList {
  const SwarmModelList(this.apis, this.local, this.oneComputer);

  final List<SwarmModelRow> apis, local, oneComputer;

  bool get isEmpty => apis.isEmpty && local.isEmpty && oneComputer.isEmpty;
}

/// What [snapshot]'s machines' fresh readings say the Swarm can use now
/// ([superTabLocalModelRows]), or null while its owner has not turned its
/// models on.
SwarmModelList? swarmModelList(
  SuperTabSnapshot snapshot, {
  required DateTime now,
}) {
  final models = snapshot.localModels;
  if (models == null || !models.enabled) return null;
  final apis = <SwarmModelRow>[], local = <SwarmModelRow>[];
  final oneComputer = <SwarmModelRow>[];
  for (final row in superTabLocalModelRows(snapshot, now: now)) {
    switch (row.kind) {
      case 'api':
        // As Desktop names an API model: its own name without the
        // provider's path; who serves it is in its label after the dot.
        final dot = row.name.lastIndexOf(' · ');
        apis.add((
          name: row.model.substring(row.model.lastIndexOf('/') + 1),
          provider: dot < 0 ? null : row.name.substring(dot + 3),
          machine: row.machine,
        ));
      case 'shared':
        oneComputer.add((name: row.name, provider: null, machine: row.machine));
      default:
        local.add((name: row.name, provider: null, machine: row.machine));
    }
  }
  return SwarmModelList(apis, local, oneComputer);
}

/// Your models, from the drawer: for each of the account's Swarms, the models
/// it can use now. Read only — running and sharing models is on a computer.
class SwarmModelsPage extends StatelessWidget {
  const SwarmModelsPage({super.key, this.now = DateTime.now});

  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = SwarmScope.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Your models',
              subtitle: 'What the Swarm can use now',
            ),
            Expanded(
              child: session == null
                  ? const SizedBox.shrink()
                  : ListenWhileInSight(
                      listenable: session.inbox,
                      builder: (context) => RefreshIndicator(
                        onRefresh: session.inbox.refresh,
                        child: ListView(
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: EdgeInsets.fromLTRB(
                            AppSpace.m,
                            0,
                            AppSpace.m,
                            MediaQuery.paddingOf(context).bottom + 28,
                          ),
                          children: _body(session.inbox),
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _body(SwarmInbox inbox) {
    final swarms = inbox.swarms;
    if (swarms.isEmpty) {
      return [
        const SizedBox(height: 6),
        if (inbox.loaded)
          _line(
            'swarm-models-no-swarm',
            'No Swarm yet. Start one on your computer.',
          )
        else
          SwarmSkeletonRows(id: 'swarm-models-loading', rows: 3),
      ];
    }
    // With several Swarms, each one's captions start with its name, as
    // Home's do.
    final several = swarms.length > 1;
    return [
      for (final (i, swarm) in swarms.indexed)
        ..._swarm(
          swarm.id,
          inbox.reader(swarm.id),
          name: several ? swarm.name : null,
          first: i == 0,
        ),
    ];
  }

  List<Widget> _swarm(
    String id,
    SwarmReader? reader, {
    required String? name,
    required bool first,
  }) {
    String caption(String text) => name == null ? text : '$name · $text';
    // The Swarm's own caption, over what stands for its models; with one
    // Swarm, the page's caption is it.
    List<Widget> alone(Widget child) => [
      if (name != null)
        SwarmCaption(name, first: first)
      else if (first)
        const SizedBox(height: 6),
      child,
    ];
    final snapshot = reader?.snapshot;
    if (snapshot == null) {
      return alone(switch (reader?.error) {
        final error? => SwarmGroup(
          key: ValueKey('swarm-models-error-$id'),
          children: [
            SwarmRow(
              title: error,
              detail: SwarmRow.line('Pull down to try again.'),
              onTap: null,
            ),
          ],
        ),
        null => SwarmSkeletonRows(id: 'swarm-models-loading-$id', rows: 3),
      });
    }
    final list = swarmModelList(snapshot, now: now());
    if (list == null) {
      return alone(
        _line(
          'swarm-models-off-$id',
          "Models aren't set up for this Swarm yet. "
              'Its owner sets them up on a computer.',
        ),
      );
    }
    if (list.isEmpty) {
      return alone(
        _line(
          'swarm-models-none-$id',
          'No models are running for this Swarm right now.',
        ),
      );
    }
    var top = first;
    List<Widget> section(String title, List<SwarmModelRow> rows, String kind) {
      if (rows.isEmpty) return const [];
      final heading = SwarmCaption(caption(title), first: top);
      top = false;
      return [
        heading,
        SwarmGroup(
          key: ValueKey('swarm-models-$kind-$id'),
          children: [
            for (final row in rows)
              SwarmRow(
                title: row.name,
                detail: SwarmRow.line(switch (kind) {
                  'api' => 'Shared by ${row.machine}',
                  'local' => 'Runs on ${row.machine}',
                  _ => '${row.machine} only',
                }),
                trailing: row.provider == null
                    ? null
                    : SwarmRow.line(row.provider!),
                onTap: null,
              ),
          ],
        ),
      ];
    }

    return [
      ...section('API models', list.apis, 'api'),
      ...section('Local models', list.local, 'local'),
      ...section('On one computer only', list.oneComputer, 'one'),
    ];
  }
}

/// What a page says where it has nothing to list: a line under its caption,
/// as Home's empty states are.
Widget _line(String id, String text) => Padding(
  key: ValueKey(id),
  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
  child: SwarmRow.line(text, lines: 2),
);
