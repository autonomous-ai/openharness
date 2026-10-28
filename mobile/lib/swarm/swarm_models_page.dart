import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
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
            ),
            Expanded(
              child: session == null
                  ? const SizedBox.shrink()
                  : ListenWhileInSight(
                      listenable: session.inbox,
                      builder: (context) => ListView(
                        padding: EdgeInsets.fromLTRB(
                          12,
                          0,
                          12,
                          MediaQuery.paddingOf(context).bottom + 28,
                        ),
                        children: _body(session.inbox),
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
        const SwarmCaption('Models this Swarm can use now', first: true),
        if (inbox.loaded)
          const _Words('swarm-models-no-swarm', 'You are not in a Swarm yet.')
        else
          SwarmSkeletonRows(id: 'swarm-models-loading', rows: 3),
      ];
    }
    final several = swarms.length > 1;
    return [
      for (final (i, swarm) in swarms.indexed)
        ..._swarm(
          swarm.id,
          several ? swarm.name : 'Models this Swarm can use now',
          inbox.reader(swarm.id),
          first: i == 0,
          named: several,
        ),
    ];
  }

  List<Widget> _swarm(
    String id,
    String caption,
    SwarmReader? reader, {
    required bool first,
    required bool named,
  }) {
    final snapshot = reader?.snapshot;
    final heading = named
        ? _SwarmName(caption, first: first)
        : SwarmCaption(caption, first: first);
    if (snapshot == null) {
      return [
        heading,
        if (reader?.error != null)
          _Words(
            'swarm-models-error-$id',
            'This Swarm could not be read right now.',
          )
        else
          SwarmSkeletonRows(id: 'swarm-models-loading-$id', rows: 3),
      ];
    }
    final list = swarmModelList(snapshot, now: now());
    if (list == null) {
      return [
        heading,
        _Words(
          'swarm-models-off-$id',
          "Models aren't set up for this Swarm yet. "
              'Its owner sets them up on a computer.',
        ),
      ];
    }
    if (list.isEmpty) {
      return [
        heading,
        _Words(
          'swarm-models-none-$id',
          'No models are running for this Swarm right now.',
        ),
      ];
    }
    List<Widget> section(String title, List<SwarmModelRow> rows, String kind) =>
        rows.isEmpty
        ? const []
        : [
            SwarmCaption(title),
            SwarmGroup(
              key: ValueKey('swarm-models-$kind-$id'),
              children: [
                for (final row in rows)
                  _ModelRow(
                    row,
                    where: switch (kind) {
                      'api' => 'Shared by ${row.machine}',
                      'local' => 'Runs on ${row.machine}',
                      _ => '${row.machine} only',
                    },
                  ),
              ],
            ),
          ];
    return [
      heading,
      ...section('API models', list.apis, 'api'),
      ...section('Local models', list.local, 'local'),
      ...section('On one computer only', list.oneComputer, 'one'),
    ];
  }
}

/// A Swarm's name over its models, where the account has several.
class _SwarmName extends StatelessWidget {
  const _SwarmName(this.name, {required this.first});

  final String name;
  final bool first;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(4, first ? 8 : 32, 4, 0),
    child: Text(
      name,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        color: AppPalette.textPrimary,
        fontSize: 17,
        fontWeight: FontWeight.w600,
      ),
    ),
  );
}

/// One model: its name, an API's provider at its right, and where it runs
/// under it.
class _ModelRow extends StatelessWidget {
  const _ModelRow(this.row, {required this.where});

  final SwarmModelRow row;
  final String where;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      container: true,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Expanded(
                    child: Text(
                      row.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.w500,
                        height: 1.3,
                      ),
                    ),
                  ),
                  if (row.provider case final provider?) ...[
                    const SizedBox(width: 12),
                    Text(
                      provider,
                      style: TextStyle(
                        color: AppPalette.textSecondary,
                        fontSize: 13.5,
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 3),
              Text(
                where,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: AppPalette.textSecondary,
                  fontSize: 13.5,
                  height: 1.35,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// What a page says where it has nothing to list, in a card.
class _Words extends StatelessWidget {
  const _Words(this.id, this.text);

  final String id, text;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SwarmGroup(
      key: ValueKey(id),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
          child: Text(
            text,
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 15,
              height: 1.4,
            ),
          ),
        ),
      ],
    );
  }
}
