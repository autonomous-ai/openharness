import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../core/home_dir.dart';
import '../core/relative_time.dart';
import '../measurement/product_measurement.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/empty_state.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart' show externalEngineName;
import '../widgets/desktop_chrome.dart';
import '../widgets/engine_identity.dart';
import '../widgets/laid_out_list.dart';
import '../widgets/update_notice.dart' show formatDownloadSize;
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'import_agent.dart';
import 'model.dart';
import 'team_account_setup.dart';

/// Whether Add agent offers Import: Harness on a Mac, where its daemon and a
/// Harness Team account are; never the web, Linux or Windows.
bool get superTabImportOffered =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

/// Import an agent into [group]'s project: the agents of this Mac to choose
/// from, the handoff of the one chosen as its project's members will read it,
/// and Import (docs/plans/2026-11-03-import-agent-design.md).
Future<void> showImportAgent(
  BuildContext context,
  AppNotifier app,
  SuperTabController c,
  SuperTabConversation group,
) {
  final project = c.snapshot?.projectFor(group.id);
  if (project == null) return Future.value();
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: _ImportAgentDialog(app: app, controller: c, project: project),
    ),
  );
}

class _ImportAgentDialog extends StatefulWidget {
  const _ImportAgentDialog({
    required this.app,
    required this.controller,
    required this.project,
  });
  final AppNotifier app;
  final SuperTabController controller;
  final SuperTabProject project;

  @override
  State<_ImportAgentDialog> createState() => _ImportAgentDialogState();
}

class _ImportAgentDialogState extends State<_ImportAgentDialog> {
  AppNotifier get app => widget.app;
  SuperTabController get c => widget.controller;

  /// The agent being previewed, and its handoff once read.
  ImportableAgent? _agent;
  ImportHandoff? _handoff;
  bool _busy = false;

  /// What went wrong last, at which step.
  ImportFailure? _failure;

  /// The import once Import was pressed: what it has done so far.
  AgentImport? _import;

  /// The files shown whole.
  final _open = <ImportFile>{};

  /// The import counted while its preview shows (ENGINEERING.md 8): ended ok
  /// by Import, failed when left after a failed step, cancelled otherwise.
  void Function(ProductOutcome)? _counted;

  void _end(ProductOutcome outcome) {
    _counted?.call(outcome);
    _counted = null;
  }

  @override
  void dispose() {
    _end(
      _failure != null && _import != null
          ? ProductOutcome.failed
          : ProductOutcome.cancelled,
    );
    super.dispose();
  }

  Future<void> _choose(ImportableAgent agent) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _agent = agent;
      _failure = null;
    });
    try {
      final handoff = await prepareImportHandoff(app, agent);
      if (!mounted) return;
      _counted = app.productMeasurement.begin(ProductFlow.agentImport);
      setState(() => _handoff = handoff);
    } on ImportFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _back() => setState(() {
    _end(ProductOutcome.cancelled);
    _agent = null;
    _handoff = null;
    _failure = null;
    _open.clear();
  });

  Future<void> _run() async {
    if (_busy) return;
    final import = _import ??= AgentImport();
    setState(() {
      _busy = true;
      _failure = null;
    });
    try {
      await importAgent(
        app,
        c,
        widget.project.id,
        _agent!,
        _handoff!,
        progress: import,
      );
      _end(ProductOutcome.ok);
      if (mounted) Navigator.pop(context);
    } on ImportFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app, c]),
    builder: (context, _) {
      final title = 'Import an agent into ${widget.project.name}';
      final why = _import == null ? importUnavailable(app, c) : null;
      final cancel = TextButton(
        onPressed: _busy && _import != null
            ? null
            : () => Navigator.pop(context),
        child: const Text('Cancel'),
      );
      if (why != null) {
        return SuperTabDetailDialog(
          title: title,
          body: Text(why, style: DesktopChrome.control()),
          actions: [
            cancel,
            if (why == kImportNeedsTeamAccount && app.canSetUpTeamAccount)
              FilledButton(
                onPressed: () => showTeamAccountSetup(context, app),
                child: const Text('Set up Harness Team'),
              ),
          ],
        );
      }
      final handoff = _handoff;
      return PopScope(
        canPop: !(_busy && _import != null),
        child: SuperTabDetailDialog(
          title: title,
          onClose: _busy && _import != null ? () {} : null,
          body: handoff == null ? _picker() : _preview(handoff),
          footer: handoff == null ? _failureLine() : null,
          leadingActions: [
            if (handoff != null && _import == null)
              TextButton(
                style: superTabQuietAction,
                onPressed: _busy ? null : _back,
                child: const Text('Back'),
              ),
          ],
          actions: [
            cancel,
            if (handoff != null)
              FilledButton(
                onPressed: _busy ? null : () => unawaited(_run()),
                child: Text(switch (_failure?.step) {
                  _ when _busy => 'Importing…',
                  ImportStep.start => 'Start again',
                  null => 'Import',
                  _ => 'Try again',
                }),
              ),
          ],
        ),
      );
    },
  );

  Widget? _failureLine() => switch (_failure) {
    final failure? => Text(
      '${failure.step.label}: ${failure.message}',
      style: DesktopChrome.metadata(color: grid.AppPalette.warn),
    ),
    null => null,
  };

  Widget _picker() {
    final agents = importableAgents(app, c);
    final note = Text(
      'Not offered: agents already in a Swarm, Buddies and Swarm-started '
      'agents.',
      style: DesktopChrome.metadata(),
    );
    if (agents.isEmpty) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const EmptyState(
            compact: true,
            icon: AppIcons.bot,
            title: 'No agent on this Mac to import',
            message: 'Claude Code and Codex agents of yours show here.',
          ),
          note,
        ],
      );
    }
    final now = DateTime.now();
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final agent in agents) _agentRow(agent, now),
        const SizedBox(height: DesktopChrome.controlGap),
        note,
      ],
    );
  }

  Widget _agentRow(ImportableAgent row, DateTime now) {
    final agent = row.agent;
    final folder = agent.project?.cwd;
    final home = maybeHomeDir();
    final shown = folder != null && home != null && folder.startsWith('$home/')
        ? '~${folder.substring(home.length)}'
        : folder;
    final at = agent.lastActivityAt;
    final preparing = _busy && _agent == row;
    return InkWell(
      key: ValueKey('import-agent-${agent.id}'),
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      onTap: _busy ? null : () => unawaited(_choose(row)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: DesktopChrome.controlGap),
        child: Row(
          children: [
            EngineMark.forAgent(agent),
            const SizedBox(width: DesktopChrome.controlGap),
            Expanded(
              child: Text(
                [
                  externalEngineName(agent.engine!),
                  agent.displayName,
                  ?shown,
                ].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(),
              ),
            ),
            const SizedBox(width: DesktopChrome.controlGap),
            if (preparing)
              const SizedBox.square(
                dimension: grid.AppControl.iconSize,
                child: CircularProgressIndicator(strokeWidth: 1.5),
              )
            else if (at != null)
              Text(relativeAgo(at, now), style: DesktopChrome.metadata()),
          ],
        ),
      ),
    );
  }

  Widget _preview(ImportHandoff handoff) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Text(
        "What ${widget.project.name}'s members will read",
        style: DesktopChrome.control(medium: true),
      ),
      const SizedBox(height: DesktopChrome.controlGap),
      DecoratedBox(
        decoration: BoxDecoration(
          border: Border.all(color: DesktopChrome.rim),
          borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _file('Handoff (redacted)', handoff.record),
            Divider(height: 1, thickness: 1, color: DesktopChrome.rim),
            _file('Conversation and tool calls', handoff.transcript),
          ],
        ),
      ),
      const SizedBox(height: DesktopChrome.controlGap),
      Text(
        'Secrets (keys, tokens, passwords in URLs) are removed. Tool output is '
        'never included.',
        style: DesktopChrome.metadata(),
      ),
      Text(
        'The agent on this Mac keeps running; nothing about it changes.',
        style: DesktopChrome.metadata(),
      ),
      if (_import != null) ...[
        const SizedBox(height: DesktopChrome.groupGap),
        for (final step in ImportStep.values.skip(1)) _step(step),
      ],
    ],
  );

  Widget _file(String label, ImportFile file) {
    final open = _open.contains(file);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: DesktopChrome.controlGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(label, style: DesktopChrome.control())),
              Text(
                formatDownloadSize(file.size),
                style: DesktopChrome.metadata(),
              ),
              const SizedBox(width: DesktopChrome.controlGap),
              TextButton(
                onPressed: () =>
                    setState(() => open ? _open.remove(file) : _open.add(file)),
                child: Text(open ? 'Hide text' : 'Full text'),
              ),
            ],
          ),
          if (open) _FileText(file),
        ],
      ),
    );
  }

  /// One step of the import: done, under way, failed with why, or still to
  /// come.
  Widget _step(ImportStep step) {
    final done = _stepDone(step);
    final failed = !done && _failure?.step == step;
    final current =
        !done &&
        ImportStep.values.skip(1).firstWhere((s) => !_stepDone(s)) == step;
    final mark = done
        ? Icon(
            AppIcons.circleCheck,
            size: grid.AppControl.iconSize,
            semanticLabel: 'Done',
          )
        : failed
        ? Icon(
            AppIcons.circleAlert,
            size: grid.AppControl.iconSize,
            color: grid.AppPalette.warn,
            semanticLabel: 'Failed',
          )
        : current && _busy
        ? const SizedBox.square(
            dimension: grid.AppControl.iconSize,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          )
        : Icon(
            AppIcons.circle,
            size: grid.AppControl.iconSize,
            color: DesktopChrome.muted,
          );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: grid.AppDesktop.listRowGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              mark,
              const SizedBox(width: DesktopChrome.controlGap),
              Expanded(
                child: Text(
                  step.label,
                  style: DesktopChrome.control(
                    color: done || failed || current
                        ? null
                        : DesktopChrome.muted,
                  ),
                ),
              ),
            ],
          ),
          if (failed)
            Padding(
              padding: const EdgeInsetsDirectional.only(
                start: grid.AppControl.iconSize + DesktopChrome.controlGap,
              ),
              child: Text(
                _failure!.message,
                style: DesktopChrome.metadata(color: grid.AppPalette.warn),
              ),
            ),
        ],
      ),
    );
  }

  bool _stepDone(ImportStep step) => switch (step) {
    ImportStep.conversation => _import!.conversationId != null,
    ImportStep.upload => _import!.attachmentIds.length == 2,
    ImportStep.start => _import!.agentId != null,
    _ => false,
  };
}

/// A file's whole text, line by line, built only as it scrolls into view: a
/// transcript runs to 2 MB.
class _FileText extends StatelessWidget {
  const _FileText(this.file);
  final ImportFile file;

  @override
  Widget build(BuildContext context) {
    final lines = file.text.split('\n');
    final style = grid.AppType.monoMeta(color: DesktopChrome.foreground);
    return Padding(
      padding: const EdgeInsets.only(bottom: DesktopChrome.controlGap),
      child: SizedBox(
        height: 220,
        child: SelectionArea(
          child: LaidOutListView.builder(
            itemCount: lines.length,
            itemBuilder: (context, i) => Text(lines[i], style: style),
          ),
        ),
      ),
    );
  }
}
