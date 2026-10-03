import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'agent_model_controller.dart';
import 'agent_model_sections.dart';
import 'agent_model_sheet.dart' show applyModelChoice;
import 'find_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Find's `:` — the desktop ⌘P's models mode: what the agent on screen can run on, as fzf rows.
///
/// Its engine's own subscription first (nearest the prompt), then every model the machine's grids
/// serve — your own machines' local models, then each shared grid's. The one it runs on wears `*`.
/// A tap moves it there, which re-execs the agent's process on the new model.
///
/// Only the engines whose switching is driven end to end are offered it ([kModelSheetEngines]);
/// the rest are told so in one line rather than shown rows a tap could not act on.
class FindModels extends StatefulWidget {
  const FindModels({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    required this.query,
    required this.onPicked,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// What was typed after the `:`.
  final String query;

  /// Called as a model is picked, before the move is asked for — Find closes on it.
  final VoidCallback onPicked;

  @override
  State<FindModels> createState() => _FindModelsState();
}

class _FindModelsState extends State<FindModels> {
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

  void _pick(GridModel? model) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    widget.onPicked();
    unawaited(
      applyModelChoice(
        widget.notifier,
        machineId: widget.machineId,
        agentId: widget.agentId,
        model: model,
        messenger: messenger,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _models,
    builder: (context, _) {
      final tty = Tty.of(context);
      final agent = _models.agent;
      final engine = agent?.engine?.trim().toLowerCase();
      final needle = widget.query.trim().toLowerCase();
      bool matches(String text) =>
          needle.isEmpty || text.toLowerCase().contains(needle);
      final rows = <Widget>[];
      Widget note(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(Tty.origin, 12, Tty.origin, 8),
        child: Text(
          text,
          style: tty.style(color: tty.faint, size: TtySize.meta),
        ),
      );
      if (!kModelSheetEngines.contains(engine)) {
        rows.add(
          note(
            '${engineIdentity(agent?.engine, displayName: agent?.engineDisplayName).label} '
            'keeps its own model — `:` switches claude, codex and opencode',
          ),
        );
      } else {
        final reading = _models.subscription;
        final ownTitle =
            (reading?['title'] as String?) ??
            engineIdentity(
              agent?.engine,
              displayName: agent?.engineDisplayName,
            ).label;
        if (matches(ownTitle)) {
          rows.add(const FindHeader('subscription'));
          rows.add(
            FindRow(
              title: ownTitle,
              detail: reading?['account'] as String?,
              terms: needle.isEmpty ? const [] : [needle],
              state: agent?.gridModel == null ? '✓' : null,
              stateColor: tty.green,
              onTap: () => _pick(null),
            ),
          );
        }
        final answer = _models.answer;
        if (answer == null) {
          rows.add(note('asking the machine for its models…'));
        } else if (!answer.canRunLocally(agent?.engine)) {
          rows.add(note('this engine runs only on its own models'));
        } else {
          for (final section in modelSheetSections(answer)) {
            final where = section.own ? 'local' : section.name;
            final shown = [
              for (final model in section.models)
                if (matches(model.id) || matches(where)) model,
            ];
            if (section.models.isEmpty && needle.isEmpty) {
              final empty = modelSheetEmptySentence(answer, section);
              if (empty != null) {
                rows.add(note('$where: ${empty.toLowerCase()}'));
              }
            }
            if (shown.isNotEmpty) rows.add(FindHeader(where));
            for (final model in shown) {
              rows.add(
                FindRow(
                  title: model.id,
                  detail: model.node.isEmpty ? where : '$where · ${model.node}',
                  terms: needle.isEmpty ? const [] : [needle],
                  state: agent?.gridModel == model.id ? '✓' : null,
                  stateColor: tty.green,
                  onTap: () => _pick(model),
                ),
              );
            }
          }
        }
      }
      // Find's list: down from the field at the top, the same rows as every other mode.
      return ListView(
        padding: EdgeInsets.zero,
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        children: rows,
      );
    },
  );
}
