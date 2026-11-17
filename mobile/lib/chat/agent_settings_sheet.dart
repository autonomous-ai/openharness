import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/agent_model_choice.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/permission_modes.dart';
import 'package:harness_mobile/core/runtime_model_name.dart';
import 'package:harness_mobile/phone/agent_model_rows.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_look.dart';

/// What the chip in Chat UI's composer opens: the agent's model, from the engine's own list with the line under each;
/// its effort; and the permissions it runs with.
///
/// A pick goes to the machine as the agent's runtime profile (`agent_update`), which types the engine's own `/model`
/// and `/effort` into it: nothing restarts, and the conversation goes on. A permission mode goes by [onPermission]:
/// Claude Code's own Shift+Tab, in place; any other engine starts again in it, asked first.
Future<void> showAgentSettingsSheet(
  BuildContext context,
  AppNotifier notifier, {
  required String machineId,
  required String agentId,
  String? Function()? livePermission,
  ({String name, String? effort})? Function()? liveModel,
  Future<String?> Function(String mode)? onPermission,
  Future<bool> Function()? onClearPrompt,
}) => showModalBottomSheet<void>(
  // The app's sheet even over a terminal's page — see [TerminalLook.outside].
  context: TerminalLook.outside(context),
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  isScrollControlled: true,
  constraints: BoxConstraints(
    maxHeight: MediaQuery.sizeOf(context).height * 0.85,
  ),
  builder: (_) => AgentSettingsSheet(
    notifier: notifier,
    machineId: machineId,
    agentId: agentId,
    livePermission: livePermission,
    liveModel: liveModel,
    onPermission: onPermission,
    onClearPrompt: onClearPrompt,
  ),
);

class AgentSettingsSheet extends StatefulWidget {
  const AgentSettingsSheet({
    super.key,
    required this.notifier,
    required this.machineId,
    required this.agentId,
    this.livePermission,
    this.liveModel,
    this.onPermission,
    this.onClearPrompt,
  });

  final AppNotifier notifier;
  final String machineId;
  final String agentId;

  /// The mode the agent's own screen shows, where it shows one; null leaves the mode it started with.
  final String? Function()? livePermission;

  /// The model and effort the agent's own screen names, by the name its list gives it, where the machine names none:
  /// an OpenCode agent nobody has written to has no session, and so no model the machine reads.
  final ({String name, String? effort})? Function()? liveModel;

  /// Moves the agent to a permission mode; null once it is there, else the sentence to show. Null leaves the
  /// Permissions section out.
  final Future<String?> Function(String mode)? onPermission;

  /// Empties the agent's prompt; false when its terminal could not be reached. Null leaves Clear prompt out.
  final Future<bool> Function()? onClearPrompt;

  @override
  State<AgentSettingsSheet> createState() => _AgentSettingsSheetState();
}

class _AgentSettingsSheetState extends State<AgentSettingsSheet> {
  List<AgentModelChoice>? _choices;
  bool _loaded = false;

  /// The pick on its way to the machine, as `model@effort`: shown at once.
  String? _applying;

  /// The last pick the machine took, as `model@effort`, marked for as long as the sheet is open.
  ///
  /// ⚠️ **Not the agent's own reading, which comes later and in other words.** The machine answers once the engine
  /// shows the change, and the agent's row reaches the phone after that — named by the engine's alias (`fable` for
  /// `claude-fable-5-1`). Marked from the row alone, the sheet went back to the old model in between, and an effort
  /// picked then went to the old model.
  String? _picked;
  String? _error;

  @override
  void initState() {
    super.initState();
    // The list the chat asked for as it opened, drawn at once; asked again behind it, for a model released since.
    _choices = widget.notifier.cachedAgentModelChoices(
      widget.machineId,
      widget.agentId,
    );
    _loaded = _choices != null;
    unawaited(_load());
  }

  Future<void> _load() async {
    final choices = await widget.notifier.agentModelChoices(
      widget.machineId,
      widget.agentId,
    );
    if (!mounted) return;
    setState(() {
      // A refresh that failed keeps the list already shown.
      _choices = choices ?? _choices;
      _loaded = true;
    });
  }

  Agent? get _agent => widget.notifier
      .stateOf(widget.machineId)
      ?.agents
      .where((a) => a.id == widget.agentId)
      .firstOrNull;

  bool get _working =>
      widget.notifier
          .stateOf(widget.machineId)
          ?.processingAgentIds
          .contains(widget.agentId) ??
      false;

  Future<void> _pick(String model, String effort) async {
    final engine = _agent?.engine;
    if (engine == null || _applying != null) return;
    setState(() {
      _applying = '$model@$effort';
      _error = null;
    });
    final error = await widget.notifier.setAgentModel(
      widget.machineId,
      widget.agentId,
      engine: engine,
      model: model,
      effort: effort,
    );
    if (!mounted) return;
    setState(() {
      if (error == null) _picked = _applying;
      _refused = error == AppNotifier.agentModelBusy ? (model, effort) : null;
      _applying = null;
      _error = error;
    });
  }

  /// The pick the machine refused because the agent's prompt was not empty: what Clear prompt picks again.
  (String, String)? _refused;

  /// Clear prompt: the agent's prompt emptied, then the refused pick sent again.
  Future<void> _clearAndRetry() async {
    final refused = _refused, clear = widget.onClearPrompt;
    if (refused == null || clear == null) return;
    setState(() => _error = null);
    if (!await clear()) {
      if (mounted) {
        setState(() => _error = "Couldn't reach the agent's terminal.");
      }
      return;
    }
    if (mounted) await _pick(refused.$1, refused.$2);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SafeArea(
      child: ListenableBuilder(
        listenable: widget.notifier,
        builder: (context, _) {
          final agent = _agent;
          final running = runtimeModelDetails(
            agent?.selectedModel,
            agentId: widget.agentId,
            engine: agent?.engine,
          );
          final choices = _choices;
          // What the agent's screen names, matched to a row by its name: OpenCode cuts a long one short with `…`.
          final live = running == null ? widget.liveModel?.call() : null;
          final shown = live == null
              ? null
              : choices
                    ?.where(
                      (c) => live.name.endsWith('…')
                          ? c.name.startsWith(
                              live.name.substring(0, live.name.length - 1),
                            )
                          : c.name == live.name,
                    )
                    .firstOrNull;
          // What the sheet marks: the pick on its way, else the last one taken, else what the agent was seen running.
          final marked = (_applying ?? _picked)?.split('@');
          final currentModel = marked?.first ?? running?.id ?? shown?.model;
          final currentEffort =
              marked?.last ??
              running?.effort ??
              (shown == null ? null : live?.effort ?? 'auto');
          final current = choices
              ?.where((c) => c.model == currentModel)
              .firstOrNull;
          final locked = _working || _applying != null;
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ModelSheetTitle(onDone: () => Navigator.of(context).pop()),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.only(bottom: 16),
                  children: [
                    if (_working)
                      const ModelSectionNote(
                        'Model settings unlock when this turn finishes.',
                      ),
                    if (_error case final error?)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(
                          kModelRowInset,
                          4,
                          kModelRowInset,
                          4,
                        ),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                error,
                                style: TextStyle(
                                  color: AppPalette.dangerFill,
                                  fontSize: 13.5,
                                ),
                              ),
                            ),
                            // Words left in the prompt are the usual reason: a way past it, on the person's say.
                            if (_refused != null &&
                                widget.onClearPrompt != null)
                              TextButton(
                                onPressed: () => unawaited(_clearAndRetry()),
                                child: const Text('Clear prompt'),
                              ),
                          ],
                        ),
                      ),
                    const ModelSectionHeading(caption: 'Model', first: true),
                    if (!_loaded)
                      const ModelSectionNote('Asking the agent…')
                    else if (choices == null || choices.isEmpty)
                      const ModelSectionNote(
                        "This computer can't list this agent's models yet.",
                      )
                    else
                      ModelCard(
                        children: [
                          for (final choice in choices)
                            Opacity(
                              opacity: locked ? 0.5 : 1,
                              child: ModelRow(
                                title: choice.name,
                                detail: choice.description,
                                selected: choice.model == currentModel,
                                onTap: locked
                                    ? () {}
                                    : () => unawaited(
                                        _pick(
                                          choice.model,
                                          choice.effortFor(currentEffort),
                                        ),
                                      ),
                              ),
                            ),
                        ],
                      ),
                    if (current != null && current.levels.isNotEmpty) ...[
                      const ModelSectionHeading(caption: 'Effort'),
                      _EffortSegments(
                        // OpenCode's `auto` is a variant of its own, Default, which a person picks back.
                        levels: agent?.engine == 'opencode'
                            ? current.efforts
                            : current.levels,
                        autoLabel: 'Default',
                        selected: currentEffort,
                        onPick: locked
                            ? null
                            : (effort) =>
                                  unawaited(_pick(current.model, effort)),
                      ),
                    ],
                    if (_modes(agent) case final modes
                        when modes.isNotEmpty) ...[
                      const ModelSectionHeading(caption: 'Permissions'),
                      ModelCard(
                        children: [
                          for (final mode in modes)
                            Opacity(
                              opacity: _changingPermission ? 0.5 : 1,
                              child: ModelRow(
                                title: mode.label,
                                detail: mode.detail,
                                selected:
                                    mode.id ==
                                    (_permissionApplying ??
                                        _permissionNow(agent)),
                                onTap: _changingPermission
                                    ? () {}
                                    : () => unawaited(
                                        _changePermission(agent, mode),
                                      ),
                              ),
                            ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  /// The mode on its way, marked at once.
  String? _permissionApplying;
  bool get _changingPermission => _permissionApplying != null;

  /// The engines that change mode in place, through their own keys (`terminal/claude_permission.dart`,
  /// `terminal/codex_permission.dart`); any other starts again in it.
  static const _inPlace = {'claude', 'codex'};

  /// The modes a person can move [agent] between: New Harness ▸ Approvals' list for its engine.
  List<PermissionMode> _modes(Agent? agent) {
    final engine = agent?.engine;
    if (engine == null || widget.onPermission == null) return const [];
    return permissionModesOf(engine);
  }

  /// The mode [agent] is in: what its screen says where it says one (Claude Code's footer), else the mode it started
  /// with.
  String _permissionNow(Agent? agent) =>
      widget.livePermission?.call() ??
      agent?.permissionMode ??
      (agent?.bypassPermission == true ? 'full' : kDefaultPermissionMode);

  Future<void> _changePermission(Agent? agent, PermissionMode mode) async {
    final change = widget.onPermission;
    if (agent == null || change == null) return;
    if (mode.id == _permissionNow(agent)) return;
    // Claude Code and Codex change their mode in place; any other engine starts again in it, which is asked first.
    if (!_inPlace.contains(agent.engine) &&
        !await confirmPhoneAction(
          context,
          title: 'Restart in ${mode.label}?',
          message: 'The harness stops and starts again in this mode. The conversation continues.',
          confirmLabel: 'Restart',
          icon: LucideIcons.rotateCcw300,
        )) {
      return;
    }
    if (!mounted) return;
    setState(() {
      _permissionApplying = mode.id;
      _error = null;
    });
    final error = await change(mode.id);
    if (!mounted) return;
    setState(() {
      _permissionApplying = null;
      _error = error;
    });
  }
}

/// The current model's efforts side by side, the one in force filled — a segmented control.
class _EffortSegments extends StatelessWidget {
  const _EffortSegments({
    required this.levels,
    required this.selected,
    required this.onPick,
    this.autoLabel = 'Auto',
  });

  final List<String> levels;
  final String? selected;
  final ValueChanged<String>? onPick;

  /// What `auto` reads as: OpenCode calls it Default.
  final String autoLabel;

  String _label(String level) =>
      level == 'auto' ? autoLabel : effortShortLabel(level);

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: kModelCardInset),
      child: Container(
        height: 44,
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: AppPalette.cardBg,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            for (final level in levels)
              Expanded(
                child: Semantics(
                  button: true,
                  selected: level == selected,
                  label: 'Effort ${_label(level)}',
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: onPick == null || level == selected
                        ? null
                        : () => onPick!(level),
                    child: Container(
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: level == selected
                            ? AppSurface.recessHover
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          child: Text(
                            _label(level),
                            style: TextStyle(
                              color: onPick == null
                                  ? AppPalette.textFaint
                                  : level == selected
                                  ? AppPalette.textPrimary
                                  : AppPalette.textSecondary,
                              fontSize: 15,
                              fontWeight: level == selected
                                  ? FontWeight.w600
                                  : FontWeight.w500,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
