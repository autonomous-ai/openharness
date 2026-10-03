import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/test_run.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/usage/models_menu_controller.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'find_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

String modelSubscriptionLabel(String engine) => switch (engine) {
  'codex' => 'OpenAI',
  'claude' => 'Anthropic',
  _ => engineIdentity(engine).label,
};

/// A null model selects the subscription; a null sheet result means Cancel.
class NewAgentModelChoice {
  const NewAgentModelChoice(this.model);
  final GridModel? model;
}

/// Chooses a model for creation. It never retargets an existing harness.
Future<NewAgentModelChoice?> showNewAgentModelSheet(
  BuildContext context, {
  required AppNotifier notifier,
  required String machineId,
  required String engine,
  GridModel? selected,
  String? profileLabel,
}) => showModalBottomSheet<NewAgentModelChoice>(
  context: context,
  useRootNavigator: true,
  useSafeArea: true,
  isScrollControlled: true,
  showDragHandle: true,
  backgroundColor: Tty.of(context).ground,
  constraints: BoxConstraints(
    maxHeight: MediaQuery.sizeOf(context).height * .85,
  ),
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: _ModelChooser(
      notifier: notifier,
      machineId: machineId,
      engine: engine,
      selected: selected,
      profileLabel: profileLabel,
    ),
  ),
);

class _ModelChooser extends StatefulWidget {
  const _ModelChooser({
    required this.notifier,
    required this.machineId,
    required this.engine,
    this.selected,
    this.profileLabel,
  });

  final AppNotifier notifier;
  final String machineId, engine;
  final GridModel? selected;
  final String? profileLabel;

  @override
  State<_ModelChooser> createState() => _ModelChooserState();
}

class _ModelChooserState extends State<_ModelChooser> {
  final _search = TextEditingController();
  final _focus = FocusNode();
  GridModels? _catalog;
  bool _loading = false;
  String _query = '';
  late final _usage = ModelsMenuController(
    // An engine can use a different subscription on each computer. Only this
    // computer's default account belongs beside the subscription choice.
    remote: () => widget.notifier.readRemoteUsage(machineId: widget.machineId),
  );

  @override
  void initState() {
    super.initState();
    _usage.addListener(_changed);
    if (!kUnderTest && widget.profileLabel == null) unawaited(_usage.refresh());
    unawaited(_load());
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() => _loading = true);
    final catalog = await widget.notifier.gridModels(widget.machineId);
    if (!mounted) return;
    setState(() {
      _catalog = catalog;
      _loading = false;
    });
  }

  void _choose(GridModel? model) {
    FocusManager.instance.primaryFocus?.unfocus();
    Navigator.of(context).pop(NewAgentModelChoice(model));
  }

  @override
  void dispose() {
    _usage.removeListener(_changed);
    _usage.dispose();
    _search.dispose();
    _focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final machine =
        widget.notifier.stateOf(widget.machineId)?.machine.displayName ??
        'this computer';
    final title = modelSubscriptionLabel(widget.engine);
    final usage = widget.profileLabel == null
        ? _usage.rows.where((row) => row['engine'] == widget.engine).firstOrNull
        : null;
    final detail = [
      '${widget.profileLabel ?? 'Default account'} on $machine',
      if (usage?['status'] case final String status) status,
    ].join(' · ');
    final catalog = _catalog;
    final notice = _loading
        ? 'Loading models…'
        : catalog?.reachable != true
        ? 'Could not load models from $machine. Refresh to retry.'
        : !catalog!.supportsModelLaunch
        ? 'Update Harness CLI on $machine to choose a model before starting.'
        : !catalog.canRunLocally(widget.engine)
        ? '${engineIdentity(widget.engine).label} uses its own login.'
        : catalog.sections.every((section) => section.models.isEmpty)
        ? 'No models are running. Open Manage Models on your computer to start one.'
        : null;
    bool matches(String text) =>
        text.toLowerCase().contains(_query.trim().toLowerCase());
    final subscriptionMatches = matches('Subscription $title $detail');
    final sections = [
      if (catalog?.reachable == true &&
          catalog!.supportsModelLaunch &&
          catalog.canRunLocally(widget.engine))
        for (final section in catalog.sections)
          (
            name: section.name,
            heading: section.own
                ? 'On your machines'
                : 'Shared · ${section.name}',
            models: [
              for (final model in section.models)
                if (matches(
                  '${model.id} ${model.node} ${section.own ? 'On your machines' : 'Shared'} ${section.name}',
                ))
                  model,
            ],
          ),
    ];
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(Tty.origin, 8, Tty.origin, 12),
          child: TtyText('Model', size: TtySize.title, weight: FontWeight.w600),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
          child: TtyField(
            controller: _search,
            focus: _focus,
            autofocus: true,
            hint: 'Search subscriptions and models',
            action: TextInputAction.search,
            onChanged: (value) => setState(() => _query = value),
          ),
        ),
        Flexible(
          child: ListView(
            shrinkWrap: true,
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            padding: EdgeInsets.only(
              bottom: MediaQuery.paddingOf(context).bottom + 16,
            ),
            children: [
              if (subscriptionMatches) ...[
                const FindHeader('Subscription'),
                FindRow(
                  title: title,
                  detail: detail,
                  state: widget.selected == null ? '✓' : null,
                  stateColor: tty.green,
                  onTap: () => _choose(null),
                ),
              ],
              for (final section in sections)
                if (section.models.isNotEmpty) ...[
                  FindHeader(section.heading),
                  for (final model in section.models)
                    FindRow(
                      title: model.id,
                      detail: model.node,
                      state:
                          widget.selected?.id == model.id &&
                              widget.selected?.grid == section.name
                          ? '✓'
                          : null,
                      stateColor: tty.green,
                      onTap: () => _choose(
                        GridModel(
                          id: model.id,
                          node: model.node,
                          grid: section.name,
                        ),
                      ),
                    ),
                ],
              if (notice != null ||
                  (!subscriptionMatches &&
                      sections.every((s) => s.models.isEmpty)))
                Padding(
                  padding: const EdgeInsets.all(Tty.origin),
                  child: TtyText(notice ?? 'No match.', color: tty.faint),
                ),
              FindRow(
                title: 'Refresh models',
                enabled: !_loading,
                onTap: () => unawaited(_load()),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
