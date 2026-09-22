/// Where one agent runs, chosen from the phone: its engine's own login, or a
/// model on a grid the machine it runs on is signed into.
///
/// ⚠️ **A sheet, not a menu.** The desktop hangs this off the pane header, a
/// control a mouse can reach without leaving the terminal. A phone header has
/// room for the agent's name and `⋯`, so this comes up from the bottom edge
/// like every other list a thumb reaches into here — and it is opened from the
/// `⋯` sheet, which is where this app puts everything the desktop reaches by
/// right-clicking a pane.
///
/// ⚠️ **Picking re-execs the agent's process.** That is why it is a tap in a
/// sheet rather than anything a swipe could do by accident, and why picking
/// what is already picked does nothing at all.
///
/// ⚠️ **No "Open Grid" button, unlike the desktop's picker.** That button opens
/// the Grid harness as a new agent, which needs the Store — `probeDsh`,
/// `openStore`, and a `createAgent` that can name a harness. The phone has none
/// of the three. The sentence under an empty Local section says where to go
/// instead (see [modelSheetEmptySentence]); a button that cannot open anything
/// would be worse than the sentence.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'agent_model_controller.dart';
import 'agent_model_rows.dart';
import 'agent_model_sections.dart';

/// Open the sheet for one agent. Nothing moves until something is tapped; the
/// list is asked for as the sheet opens.
Future<void> showAgentModelSheet(
  BuildContext context,
  AppNotifier notifier, {
  required String machineId,
  required String agentId,
}) {
  // Taken before the sheet opens, because a refusal lands after it has closed
  // and the sheet's own context is gone by then.
  final messenger = ScaffoldMessenger.maybeOf(context);
  return showModalBottomSheet<void>(
    context: context,
    useRootNavigator: true,
    showDragHandle: true,
    backgroundColor: AppPalette.panelBg,
    // A grid serving a dozen models outgrows Flutter's 9/16 default, which is
    // not a height anything here asked for. The ceiling is [showPhoneSheet]'s,
    // so the sheet this one opens from and this one stand the same way.
    isScrollControlled: true,
    constraints: BoxConstraints(
      maxHeight: MediaQuery.sizeOf(context).height * 0.85,
    ),
    builder: (sheetContext) => _AgentModelSheet(
      notifier: notifier,
      machineId: machineId,
      agentId: agentId,
      // Close first, then act: the snackbar a refusal lands in must not arrive
      // underneath a sheet that is still animating out — the same order every
      // row in [showPhoneSheet] takes.
      onPick: (model) {
        Navigator.of(sheetContext).pop();
        unawaited(
          applyModelChoice(
            notifier,
            machineId: machineId,
            agentId: agentId,
            model: model,
            messenger: messenger,
          ),
        );
      },
    ),
  );
}

/// Move the agent, unless it is already there.
///
/// ⚠️ **Picking what is already picked is a no-op, and that is a rule rather
/// than a nicety.** A retarget re-execs the pane's process; a tap on the row
/// already wearing the tick would throw away the agent's live process to put it
/// back exactly where it was.
///
/// ⚠️ **A free function, not a method on [AgentModelController].** The sheet is
/// closed before this is called, so the controller is disposed by the time the
/// daemon answers.
///
/// A refusal is a sentence, not a code — the daemon decides these before it
/// touches the pane, so the terminal never says why. The phone has no error
/// rail, so it lands in the one surface a pushed page always has.
Future<void> applyModelChoice(
  AppNotifier notifier, {
  required String machineId,
  required String agentId,
  required GridModel? model,
  ScaffoldMessengerState? messenger,
}) async {
  if (model?.id == agentOnScreen(notifier, machineId, agentId)?.gridModel) {
    return;
  }
  final error = model == null
      ? await notifier.clearAgentGrid(machineId, agentId)
      : await notifier.retargetAgentToGridModel(
          machineId,
          agentId,
          model.id,
          gridName: model.grid,
        );
  if (error != null) messenger?.showSnackBar(SnackBar(content: Text(error)));
}

class _AgentModelSheet extends StatefulWidget {
  const _AgentModelSheet({
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.onPick,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// The chosen grid model, or null for the engine's own login.
  final ValueChanged<GridModel?> onPick;

  @override
  State<_AgentModelSheet> createState() => _AgentModelSheetState();
}

class _AgentModelSheetState extends State<_AgentModelSheet> {
  late final AgentModelController _models = AgentModelController(
    notifier: widget.notifier,
    machineId: widget.machineId,
    agentId: widget.agentId,
  );

  @override
  void dispose() {
    _models.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SafeArea(
      child: ListenableBuilder(
        listenable: _models,
        builder: (context, _) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ModelSheetTitle(agentName: _models.agent?.name),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 8),
                children: [
                  const ModelSectionHeading(
                    caption: 'Subscription',
                    first: true,
                  ),
                  _subscriptionRow(),
                  ..._gridRows(),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// The engine's own login, offered FIRST and always.
  ///
  /// A sheet that can only move an agent ONTO a grid is a one-way door, and the
  /// way back must not be something you have to know a command for.
  Widget _subscriptionRow() {
    final agent = _models.agent;
    final reading = _models.subscription;
    return ModelRow(
      title:
          (reading?['title'] as String?) ??
          engineIdentity(
            agent?.engine,
            displayName: agent?.engineDisplayName,
          ).label,
      engine: agent?.engine,
      selected: agent?.gridModel == null,
      status: reading?['status'] as String?,
      detail: _nonEmpty(reading?['account'] as String?),
      onTap: () => widget.onPick(null),
    );
  }

  /// Every grid section, or the one line that stands in for all of them.
  List<Widget> _gridRows() {
    final answer = _models.answer;
    if (answer == null) return const [ModelSheetWaiting()];
    final agent = _models.agent;
    // An engine with no way onto a Local model (Cursor talks only to its own
    // API; the daemon refuses the move) is told so once, instead of being
    // offered rows whose tap would do nothing. The daemon names the capable
    // engines beside the list; an older one names none, and then every row is
    // offered as before.
    if (!answer.canRunLocally(agent?.engine)) {
      return [
        const ModelSectionHeading(caption: 'Local models on your machines'),
        ModelSectionNote(
          '${engineIdentity(agent?.engine).label} can only run on its '
          'own login.',
        ),
      ];
    }
    return [
      for (final section in modelSheetSections(answer))
        ..._section(answer, section, agent),
    ];
  }

  /// One grid: its heading, then its models — or the sentence that says why it
  /// has none.
  List<Widget> _section(GridModels answer, GridSection section, Agent? agent) {
    final heading = modelSheetHeading(section);
    final empty = section.models.isEmpty
        ? modelSheetEmptySentence(answer, section)
        : null;
    return [
      ModelSectionHeading(caption: heading.caption, detail: heading.detail),
      if (empty != null) ModelSectionNote(empty),
      for (final model in section.models)
        ModelRow(
          title: model.id,
          selected: agent?.gridModel == model.id,
          // Which machine answers it — on the own grid, one of the user's own
          // computers, which is the useful part of the answer.
          status: _nonEmpty(model.node),
          // The web-search status is about THIS agent's launch; the other rows
          // are places it could go, about which nothing is known.
          warning: agent?.gridModel == model.id
              ? agent?.gridWebSearch?.sentence
              : null,
          onTap: () => widget.onPick(model),
        ),
    ];
  }
}

String? _nonEmpty(String? value) =>
    value == null || value.isEmpty ? null : value;
