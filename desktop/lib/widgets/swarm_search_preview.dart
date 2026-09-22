import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent;
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/models.dart';
import '../shared/theme/prompt_style.dart';
import '../state/app_state.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import 'box_chrome.dart';
import 'engine_identity.dart';

typedef _PreviewAgent = ({MachineState machine, Agent agent});

List<_PreviewAgent> _agents(AppNotifier app, SwarmDestination row) {
  final result = <_PreviewAgent>[];
  for (final machine in app.machineStates.values) {
    for (final agent in machine.agents) {
      if (row.agentId == agent.id &&
              row.machineId == machine.machine.machineId ||
          row.agentId == null &&
              row.members.contains(
                agentDestinationId(machine.machine.machineId, agent.id),
              )) {
        result.add((machine: machine, agent: agent));
      }
    }
  }
  int priority(_PreviewAgent item) => item.machine.nodeOnline == false
      ? 3
      : item.machine.blockedAgents.containsKey(item.agent.id)
      ? 0
      : item.machine.processingAgentIds.contains(item.agent.id)
      ? 1
      : 2;
  // Waiting members come first; retain catalog order within each state.
  return [
    for (var p = 0; p < 4; p++) ...result.where((item) => priority(item) == p),
  ];
}

/// One content surface shared by Cmd-O and the start page. Arrow keys only swap
/// cached records. A short dwell warms cold records without delaying selection.
class SwarmSearchPreview extends StatefulWidget {
  const SwarmSearchPreview({
    super.key,
    required this.search,
    this.compactHeader = false,
    this.terminal = false,
  });
  final SwarmSearchController search;
  final bool compactHeader;
  final bool terminal;

  @override
  State<SwarmSearchPreview> createState() => _SwarmSearchPreviewState();
}

class _SwarmSearchPreviewState extends State<SwarmSearchPreview> {
  Timer? _warm;
  String? _selectedId;
  final _scroll = ScrollController();
  int _lastPage = 0;
  int _pendingPages = 0;
  String? _renderedId;
  bool _pageScheduled = false;
  AppNotifier get app => widget.search.app;

  @override
  void initState() {
    super.initState();
    widget.search.addListener(_changed);
    _lastPage = widget.search.previewPage.value;
    widget.search.previewPage.addListener(_pageChanged);
    _changed();
  }

  @override
  void didUpdateWidget(SwarmSearchPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != widget.search) {
      oldWidget.search.removeListener(_changed);
      oldWidget.search.previewPage.removeListener(_pageChanged);
      widget.search.addListener(_changed);
      _lastPage = widget.search.previewPage.value;
      widget.search.previewPage.addListener(_pageChanged);
      _selectedId = null;
      _changed();
    }
  }

  void _changed() {
    final row = widget.search.selected;
    if (_selectedId == row?.id) return;
    _selectedId = row?.id;
    _pendingPages = 0;
    if (_scroll.hasClients) _scroll.jumpTo(0);
    setState(() {});
    _warm?.cancel();
    _warm = Timer(const Duration(milliseconds: 140), () {
      if (!mounted || row == null) return;
      final selected = _agents(app, row);
      final neighbors = widget.search.rows
          .skip(widget.search.cursor + 1)
          .take(2);
      app.sessionPreviews.warm([
        for (final item in selected)
          app.previewKey(item.machine.machine.machineId, item.agent),
        for (final neighbor in neighbors)
          for (final item in _agents(app, neighbor).take(2))
            app.previewKey(item.machine.machine.machineId, item.agent),
      ], prioritize: true);
    });
  }

  void _pageChanged() {
    final page = widget.search.previewPage.value;
    _pendingPages += page - _lastPage;
    _lastPage = page;
    if (_renderedId == _selectedId &&
        _scroll.hasClients &&
        _scroll.position.hasContentDimensions) {
      _applyPage();
    } else if (!_pageScheduled) {
      // A new result can be selected and paged before its first layout. Apply
      // against its own dimensions; a later selection clears the pending move.
      _pageScheduled = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _pageScheduled = false;
        _applyPage();
      });
    }
  }

  void _applyPage() {
    if (_pendingPages == 0 || !_scroll.hasClients) return;
    final position = _scroll.position;
    if (!position.hasContentDimensions) return;
    final pages = _pendingPages;
    _pendingPages = 0;
    // Keep a little overlap for reading, and respond directly to held keys.
    _scroll.jumpTo(
      (position.pixels + pages * position.viewportDimension * .8).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
  }

  @override
  void dispose() {
    _warm?.cancel();
    widget.search.removeListener(_changed);
    widget.search.previewPage.removeListener(_pageChanged);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return AnimatedBuilder(
      animation: Listenable.merge([app, app.sessionPreviews]),
      builder: (context, _) {
        final row = widget.search.selected;
        if (row == null) return const SizedBox.shrink();
        _renderedId = row.id;
        final agents = _agents(app, row);
        return Semantics(
          container: true,
          label: 'Agent preview',
          child: Scrollbar(
            controller: _scroll,
            child: agents.length != 1
                ? ListView.builder(
                    key: ValueKey('preview-content:${row.id}'),
                    controller: _scroll,
                    padding: EdgeInsets.all(
                      widget.terminal
                          ? 12
                          : widget.compactHeader
                          ? 16
                          : 24,
                    ),
                    scrollCacheExtent: const ScrollCacheExtent.pixels(120),
                    itemCount: agents.length + 1,
                    itemBuilder: (context, index) => index == 0
                        ? Padding(
                            padding: const EdgeInsets.only(bottom: 24),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  row.title,
                                  // The list leads the eye; this confirms it.
                                  style: terminalTextStyle(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const SizedBox(height: 6),
                                Text(row.detail, style: _muted),
                                // Nothing exists yet behind the create row, so
                                // there is no session to be missing text from.
                                if (agents.isEmpty && !row.isCreate)
                                  Padding(
                                    padding: EdgeInsets.only(top: 24),
                                    child: Text(
                                      'No recent session text available.',
                                      style: _muted,
                                    ),
                                  ),
                              ],
                            ),
                          )
                        : Padding(
                            padding: EdgeInsets.only(top: index > 1 ? 20 : 0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                _AgentPreview(
                                  app: app,
                                  item: agents[index - 1],
                                  compact: true,
                                  terminal: widget.terminal,
                                ),
                                if (index < agents.length)
                                  const SizedBox(height: 20),
                              ],
                            ),
                          ),
                  )
                : SingleChildScrollView(
                    key: ValueKey('preview-content:${row.id}'),
                    controller: _scroll,
                    padding: EdgeInsets.all(
                      widget.terminal
                          ? 12
                          : widget.compactHeader
                          ? 16
                          : 24,
                    ),
                    child: _AgentPreview(
                      app: app,
                      item: agents.single,
                      dense: widget.compactHeader,
                      terminal: widget.terminal,
                    ),
                  ),
          ),
        );
      },
    );
  }
}

TextStyle get _muted => terminalTextStyle(height: 1.5, color: Colors.white54);
TextStyle get _body => terminalTextStyle(height: 1.6, color: Color(0xffe1e1e4));

class _AgentPreview extends StatelessWidget {
  const _AgentPreview({
    required this.app,
    required this.item,
    this.compact = false,
    this.dense = false,
    this.terminal = false,
  });
  final AppNotifier app;
  final _PreviewAgent item;
  final bool compact;
  final bool dense;
  final bool terminal;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    final muted = terminal ? boxMonoStyle(color: kBoxFaint) : _muted;
    final body = terminal
        ? boxMonoStyle(color: const Color(0xffe1e1e4))
        : _body;
    Widget section(String label, String text, {int? maxLines}) =>
        _Section(label, text, maxLines: maxLines, terminal: terminal);
    final (:machine, :agent) = item;
    final record = app.sessionPreviews.read(
      app.previewKey(machine.machine.machineId, agent),
    );
    final offline =
        machine.nodeOnline == false ||
        machine.needsLink ||
        machine.connectionStatus != ConnectionStatus.connected;
    final waiting = offline ? null : machine.blockedAgents[agent.id];
    final working = !offline && machine.processingAgentIds.contains(agent.id);
    final state = offline
        ? 'Offline'
        : waiting != null
        ? 'Needs you'
        : working
        ? 'Working'
        : 'Idle';
    final color = offline
        ? Colors.white54
        : waiting != null
        ? const Color(0xffe9bf79)
        : working
        ? const Color(0xffadc5eb)
        : const Color(0xff9abea5);
    final project = machine.projectOf(agent);
    final request =
        working && record?.turnOpen == true && record?.currentRequest != null
        ? record!.currentRequest
        : record?.latestRequest;
    final requestLabel =
        working && record?.turnOpen == true && record?.currentRequest != null
        ? 'Current request'
        : 'Recent request';
    final activity = working ? record?.liveText : null;
    final response = record?.response ?? (!working ? record?.liveText : null);
    final excerpt =
        waiting?.prompt ??
        (working
            ? request ?? activity ?? response
            : record?.contextResponse ?? response ?? request);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (terminal) ...[
          Text(agent.displayName, style: boxMonoStyle(weight: FontWeight.w600)),
          const SizedBox(height: 4),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '$state  ',
                  style: TextStyle(color: color),
                ),
                TextSpan(
                  text:
                      '$kHarnessPromptMarker ${agentIdentity(agent).label} · ${machine.machine.name}',
                ),
              ],
            ),
            style: muted,
          ),
        ] else
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: EngineMark(
                  engine: agent.identityEngine,
                  displayName: agent.identityDisplayName,
                  size: compact ? 18 : 22,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  agent.displayName,
                  style: terminalTextStyle(
                    // The list leads the eye; the preview confirms it.
                    fontWeight: FontWeight.w600,
                    height: 1.25,
                  ),
                ),
              ),
              if (dense) ...[
                const SizedBox(width: 10),
                Text(state, style: terminalTextStyle(color: color)),
              ],
            ],
          ),
        if (!dense && !terminal) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: .08),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      waiting != null
                          ? LucideIcons.hand300
                          : LucideIcons.circle300,
                      size: 10,
                      color: color,
                    ),
                    const SizedBox(width: 5),
                    Text(state, style: terminalTextStyle(color: color)),
                  ],
                ),
              ),
              Text(
                [
                  // Its harness when it has one, the way every other mark
                  // draws it — a Circuit agent is Circuit here too.
                  agentIdentity(agent).label,
                  machine.machine.name,
                ].join(' · '),
                style: muted,
              ),
            ],
          ),
        ],
        if (compact) ...[
          const SizedBox(height: 10),
          Text(
            _displayText(excerpt ?? 'No recent session text available.'),
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: excerpt == null ? muted : body,
          ),
          if (project?.name != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                [project!.name, project.branch].whereType<String>().join(' · '),
                style: muted,
              ),
            ),
        ] else ...[
          SizedBox(
            height: terminal
                ? 8
                : dense
                ? 16
                : 26,
          ),
          if (waiting != null) ...[
            Container(
              width: double.infinity,
              padding: EdgeInsets.all(terminal ? 8 : 16),
              decoration: BoxDecoration(
                color: color.withValues(alpha: .06),
                border: Border.all(color: color.withValues(alpha: .24)),
                borderRadius: BorderRadius.circular(terminal ? 0 : 12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Needs your input',
                    style: terminalTextStyle(
                      fontWeight: FontWeight.w600,
                      color: color,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(_displayText(waiting.prompt), style: body),
                  if (waiting.options.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Text(waiting.options.take(6).join('  ·  '), style: muted),
                  ],
                ],
              ),
            ),
            SizedBox(height: terminal ? 14 : 24),
          ],
          if (working) ...[
            if (request != null) section(requestLabel, request),
            if (record?.earlierRequest case final earlier?)
              section('Earlier request', earlier),
            if (activity != null) section('Latest activity', activity),
            if (record?.activity case final tool?) section('Using tool', tool),
            if (activity == null && response != null)
              section('Previous response', response),
          ] else ...[
            if (response != null)
              section(
                record?.interrupted == true
                    ? 'Last response · interrupted'
                    : 'Latest response',
                record?.responseExcerpt ?? response,
                maxLines: record?.earlierResponses.isNotEmpty == true
                    ? 6
                    : null,
              ),
            if (record?.earlierResponses.isNotEmpty == true)
              Padding(
                padding: const EdgeInsets.only(bottom: 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Earlier in this session',
                      style: muted.copyWith(fontWeight: FontWeight.w500),
                    ),
                    for (final text in record!.earlierResponses)
                      Padding(
                        padding: EdgeInsets.only(top: terminal ? 6 : 10),
                        child: Text(
                          _displayText(text),
                          maxLines: 4,
                          overflow: TextOverflow.ellipsis,
                          style: body,
                        ),
                      ),
                  ],
                ),
              ),
            if (request != null) section('Recent request', request),
            if (record?.earlierRequest case final earlier?)
              section('Earlier request', earlier),
          ],
          if (record?.hasContent != true && waiting == null)
            Padding(
              padding: const EdgeInsets.only(bottom: 24),
              child: Text('No recent session text available.', style: muted),
            ),
          const SizedBox(height: 8),
          if (project?.cwd case final cwd?) Text(cwd, style: muted),
          if (project?.branch case final branch?)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Row(
                children: [
                  const Icon(
                    LucideIcons.gitBranch300,
                    size: 12,
                    color: Colors.white54,
                  ),
                  const SizedBox(width: 6),
                  Expanded(child: Text(branch, style: muted)),
                ],
              ),
            ),
          if (record?.receivedAt case final at?)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '${offline || record?.unavailable == true ? 'Saved text · ' : ''}Received ${TimeOfDay.fromDateTime(at).format(context)}',
                style: muted,
              ),
            ),
        ],
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section(this.label, this.text, {this.maxLines, this.terminal = false});
  final String label, text;
  final int? maxLines;
  final bool terminal;
  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return Padding(
      padding: EdgeInsets.only(bottom: terminal ? 8 : 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: terminal
                ? boxMonoStyle(color: kBoxFaint)
                : _muted.copyWith(fontWeight: FontWeight.w500),
          ),
          SizedBox(height: terminal ? 4 : 7),
          Text(
            _displayText(text),
            style: terminal ? boxMonoStyle() : _body,
            maxLines: maxLines,
            overflow: maxLines == null ? null : TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}

// Plain readable excerpts, not a second transcript renderer. Preserve the words
// and line breaks; remove only common markdown presentation delimiters.
String _displayText(String text) => text
    .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^\n)]+\)'), (m) => m[1]!)
    .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
    .replaceAll('**', '')
    .replaceAll('`', '');
