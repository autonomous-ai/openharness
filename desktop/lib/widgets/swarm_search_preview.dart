import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent;
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:xterm/xterm.dart' show TerminalTheme;

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/app_type.dart';
import '../shared/theme/status_line_style.dart';
import '../state/app_state.dart';
import '../state/harness_sessions.dart';
import '../state/session_content_search.dart';
import '../state/session_tail.dart';
import '../state/swarm_navigation.dart';
import '../state/swarm_search.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'box_chrome.dart';
import 'engine_identity.dart';
import 'search_result_text.dart' show SessionSnippetText;
import 'session_tail_view.dart';
import 'swarm_preview_scroll.dart';

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

/// One content surface shared by Cmd-P and the start page. Arrow keys only swap
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

/// The conversation an external row previews: its own, on its machine.
SessionTailKey? _externalKey(SwarmDestination row) =>
    switch ((row.external, row.machineId)) {
      (final external?, final machineId?) => (
        machineId: machineId,
        sessionId: external.sessionId,
      ),
      _ => null,
    };

/// The session a single-agent row previews the end of: the agent's current
/// one, which is what opening the row shows.
SessionTailKey? _tailKey(_PreviewAgent item) => switch (item.agent.sessionId) {
  final sessionId? => (
    machineId: item.machine.machine.machineId,
    sessionId: sessionId,
  ),
  null => null,
};

class _SwarmSearchPreviewState extends State<SwarmSearchPreview> {
  Timer? _warm;
  Timer? _tail;
  String? _selectedId;
  SessionContentHit? _found;
  late SwarmPreviewScrollController _scroll;
  AppNotifier get app => widget.search.app;

  @override
  void initState() {
    super.initState();
    _scroll = _scrollController();
    // Each opening shows the sessions as they are now.
    app.sessionTails.opened();
    widget.search.addListener(_changed);
    _changed();
  }

  SwarmPreviewScrollController _scrollController() =>
      SwarmPreviewScrollController(
        search: widget.search,
        lineHeight: () => terminalCellSizeOf(context).height,
      );

  @override
  void didUpdateWidget(SwarmSearchPreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != widget.search) {
      oldWidget.search.removeListener(_changed);
      _scroll.dispose();
      _scroll = _scrollController();
      widget.search.addListener(_changed);
      _selectedId = null;
      _changed();
    }
  }

  void _changed() {
    final row = widget.search.selected;
    // A machine's answer can land after the selection: show where it found it.
    final found = row == null ? null : widget.search.contentHitFor(row.id);
    if (!identical(found, _found)) setState(() => _found = found);
    if (_selectedId == row?.id) return;
    _selectedId = row?.id;
    setState(() {});
    _warm?.cancel();
    _tail?.cancel();
    if (row?.isCommand == true || row?.pickerQuery != null) return;
    // A row passed over while arrowing is not asked for; one that stays
    // selected is, once per Cmd-P opening. Nothing refreshes it after that.
    _tail = Timer(const Duration(milliseconds: 60), () {
      if (mounted && row != null) _wantTail(row);
    });
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
      // The next rows' latest turns, so arrowing down finds them ready.
      for (final neighbor in neighbors) {
        if (_externalKey(neighbor) case final key?) {
          app.sessionTails.want(key);
          continue;
        }
        final items = _agents(app, neighbor);
        if (neighbor.isGroup || items.length != 1) continue;
        if (_tailKey(items.single) case final key?) app.sessionTails.want(key);
      }
    });
  }

  void _wantTail(SwarmDestination row) {
    if (_externalKey(row) case final key?) {
      app.sessionTails.want(key);
      return;
    }
    final items = _agents(app, row);
    if (row.isGroup || items.length != 1) return;
    final item = items.single;
    if (_tailKey(item) case final key?) app.sessionTails.want(key);
  }

  /// A conversation Harness did not start: what it is and where it ran, then
  /// its latest turns from the bottom up, as any session's.
  Widget _external(
    SwarmDestination row,
    ExternalSessionRef external,
    EdgeInsets padding,
    Size cell,
    TerminalTheme theme,
  ) {
    final terminal = widget.terminal;
    final muted = terminal
        ? terminalContentStyle(color: theme.foreground.withValues(alpha: .54))
        : _muted;
    final body = terminal
        ? terminalContentStyle(color: theme.foreground)
        : _body;
    final warning = terminal ? theme.yellow : const Color(0xffe9bf79);
    final gap = terminal ? cell.height : 12.0;
    final key = _externalKey(row)!;
    final tail = app.sessionTails.read(key);
    final open = tail?.openElsewhere ?? external.open;
    final header = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          row.title,
          style: terminal
              ? body
              : AppType.monoLabel(fontWeight: FontWeight.w600, height: 1.25),
        ),
        Text(row.detail, style: muted),
        Text(
          [
            external.cwd,
            if (row.machineLabel.isNotEmpty) row.machineLabel,
          ].join(' · '),
          style: muted,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        if (open)
          Padding(
            padding: EdgeInsets.only(top: gap * .5),
            child: Text(switch (widget.search.sessionUnavailable(row)) {
              null => 'Open in a terminal. Opening it here moves it.',
              final where => '$where. Close it there to open it here.',
            }, style: muted.copyWith(color: warning)),
          ),
      ],
    );
    if (tail == null || tail.rows.isEmpty) {
      _scroll.reversed = false;
      final found = widget.search.contentHitFor(row.id);
      return SingleChildScrollView(
        key: ValueKey('preview-content:${row.id}'),
        controller: _scroll,
        padding: padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            header,
            if (found != null) ...[
              SizedBox(height: gap),
              SessionSnippetText(found, style: body, maxLines: null),
            ],
          ],
        ),
      );
    }
    _scroll.reversed = true;
    return Column(
      key: ValueKey('preview-content:${row.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: padding.copyWith(bottom: gap),
          child: header,
        ),
        Expanded(
          child: SessionTailView(
            tail: tail,
            tails: app.sessionTails,
            tailKey: key,
            controller: _scroll,
            words: [
              for (final word in widget.search.wordsQuery.split(RegExp(r'\s+')))
                if (word.length > 1) word,
            ],
            body: body,
            muted: muted,
            gap: gap,
            padding: padding.copyWith(top: 0),
          ),
        ),
      ],
    );
  }

  /// One agent's preview: its session's latest turns from the bottom up when
  /// its machine can say them, else the excerpts the live agent keeps.
  Widget _single(
    SwarmDestination row,
    _PreviewAgent item,
    EdgeInsets padding,
    Size cell,
    TerminalTheme theme,
  ) {
    final found = widget.search.contentHitFor(row.id);
    final key = _tailKey(item);
    final tail = key == null ? null : app.sessionTails.read(key);
    if (key == null || tail == null || tail.rows.isEmpty) {
      _scroll.reversed = false;
      return SingleChildScrollView(
        key: ValueKey('preview-content:${row.id}'),
        controller: _scroll,
        padding: padding,
        child: _AgentPreview(
          app: app,
          item: item,
          dense: widget.compactHeader,
          terminal: widget.terminal,
          found: found,
        ),
      );
    }
    _scroll.reversed = true;
    final terminal = widget.terminal;
    final muted = terminal
        ? terminalContentStyle(color: theme.foreground.withValues(alpha: .54))
        : _muted;
    final body = terminal
        ? terminalContentStyle(color: theme.foreground)
        : _body;
    final gap = terminal ? cell.height : 12.0;
    final (:machine, :agent) = item;
    final live =
        harnessSessionUnavailable(machine, agent) == null &&
        (machine.blockedAgents.containsKey(agent.id) ||
            machine.processingAgentIds.contains(agent.id));
    // A match older than the turns shown says where it was, above them.
    final earlier =
        found != null &&
            found.field != 'name' &&
            (found.sessionId != key.sessionId ||
                found.turn < tail.rows.first.turn)
        ? found
        : null;
    return Column(
      key: ValueKey('preview-content:${row.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: padding.copyWith(bottom: gap),
          child: _AgentPreview(
            app: app,
            item: item,
            dense: widget.compactHeader,
            terminal: terminal,
            part: _Part.header,
          ),
        ),
        if (earlier != null)
          Padding(
            padding: EdgeInsets.fromLTRB(padding.left, 0, padding.right, gap),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  [
                    'Matched earlier',
                    if (earlier.at case final at?)
                      '${harnessActivityAge(at, DateTime.now())} ago',
                  ].join(' · '),
                  style: muted,
                ),
                SessionSnippetText(
                  earlier,
                  key: ValueKey('preview-found:${earlier.destinationId}'),
                  style: body,
                  maxLines: 2,
                ),
              ],
            ),
          ),
        Expanded(
          child: SessionTailView(
            tail: tail,
            tails: app.sessionTails,
            tailKey: key,
            controller: _scroll,
            words: [
              for (final word in widget.search.wordsQuery.split(RegExp(r'\s+')))
                if (word.length > 1) word,
            ],
            body: body,
            muted: muted,
            gap: gap,
            padding: padding.copyWith(top: 0),
            footer: live
                ? _AgentPreview(
                    app: app,
                    item: item,
                    terminal: terminal,
                    part: _Part.footer,
                  )
                : null,
          ),
        ),
      ],
    );
  }

  @override
  void dispose() {
    _warm?.cancel();
    _tail?.cancel();
    widget.search.removeListener(_changed);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final cell = widget.terminal ? terminalCellSizeOf(context) : Size.zero;
    final padding = widget.terminal
        ? EdgeInsets.symmetric(
            horizontal: cell.width * 2,
            vertical: cell.height,
          )
        : EdgeInsets.all(widget.compactHeader ? 16 : 24);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return AnimatedBuilder(
      animation: Listenable.merge([app, app.sessionPreviews, app.sessionTails]),
      builder: (context, _) {
        final row = widget.search.selected;
        if (row == null) return const SizedBox.shrink();
        if (row.isCommand || row.pickerQuery != null) {
          return Semantics(
            container: true,
            label: 'Command preview',
            child: ListView(
              key: ValueKey('preview-content:${row.id}'),
              controller: _scroll,
              padding: padding,
              children: [
                Text(
                  row.title,
                  style: terminalContentStyle(color: theme.foreground),
                ),
                if (row.detail.isNotEmpty)
                  Text(
                    row.detail,
                    style: terminalContentStyle(
                      color: theme.foreground.withValues(alpha: .54),
                    ),
                  ),
                if (row.shortcut case final shortcut?) ...[
                  SizedBox(height: cell.height),
                  Text(
                    shortcut,
                    style: terminalContentStyle(
                      color: theme.foreground.withValues(alpha: .54),
                    ),
                  ),
                ],
              ],
            ),
          );
        }
        if (row.external case final external?) {
          final content = _external(row, external, padding, cell, theme);
          return Semantics(
            container: true,
            label: 'Conversation preview',
            child: _scroll.reversed
                ? content
                : Scrollbar(controller: _scroll, child: content),
          );
        }
        final agents = _agents(app, row);
        if (row.isGroup || agents.length != 1) _scroll.reversed = false;
        final content = row.isGroup || agents.length != 1
            ? ListView.builder(
                key: ValueKey('preview-content:${row.id}'),
                controller: _scroll,
                padding: padding,
                scrollCacheExtent: const ScrollCacheExtent.pixels(120),
                itemCount: agents.length + 1,
                itemBuilder: (context, index) => index == 0
                    ? Padding(
                        padding: EdgeInsets.only(
                          bottom: widget.terminal ? cell.height : 24,
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              row.title,
                              // The list leads the eye; this confirms it.
                              style: widget.terminal
                                  ? terminalContentStyle(
                                      color: theme.foreground,
                                    )
                                  : AppType.monoLabel(
                                      fontWeight: FontWeight.w600,
                                    ),
                            ),
                            if (!widget.terminal) const SizedBox(height: 6),
                            Text(
                              row.detail,
                              style: widget.terminal
                                  ? terminalContentStyle(
                                      color: theme.foreground.withValues(
                                        alpha: .54,
                                      ),
                                    )
                                  : _muted,
                            ),
                            // Nothing exists yet behind the create row, so
                            // there is no session to be missing text from.
                            if (agents.isEmpty && !row.isCreate)
                              Padding(
                                padding: EdgeInsets.only(
                                  top: widget.terminal ? cell.height : 24,
                                ),
                                child: Text(
                                  'No recent session text available.',
                                  style: widget.terminal
                                      ? terminalContentStyle(
                                          color: theme.foreground.withValues(
                                            alpha: .54,
                                          ),
                                        )
                                      : _muted,
                                ),
                              ),
                          ],
                        ),
                      )
                    : Padding(
                        padding: EdgeInsets.only(
                          top: index > 1
                              ? widget.terminal
                                    ? cell.height
                                    : 20
                              : 0,
                        ),
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
                              SizedBox(
                                height: widget.terminal ? cell.height : 20,
                              ),
                          ],
                        ),
                      ),
              )
            : _single(row, agents.single, padding, cell, theme);
        return Semantics(
          container: true,
          label: 'Agent preview',
          // A session's latest turns carry their list's own scrollbar, on the
          // turns alone: one around the whole preview, header included, drew
          // a second thumb beside it.
          child: _scroll.reversed
              ? content
              : Scrollbar(controller: _scroll, child: content),
        );
      },
    );
  }
}

TextStyle get _muted => AppType.monoMeta(height: 1.5, color: Colors.white54);
TextStyle get _body => AppType.monoLabel(
  fontWeight: FontWeight.w400,
  height: 1.6,
  color: Color(0xffe1e1e4),
);

/// Which part of an agent's preview to draw: all of it, or the header and the
/// footer that frame a session's latest turns ([SessionTailView]).
enum _Part { all, header, footer }

class _AgentPreview extends StatelessWidget {
  const _AgentPreview({
    required this.app,
    required this.item,
    this.compact = false,
    this.dense = false,
    this.terminal = false,
    this.found,
    this.part = _Part.all,
  });
  final AppNotifier app;
  final _PreviewAgent item;
  final bool compact;
  final bool dense;
  final bool terminal;
  final _Part part;

  /// Where the machine's session index found the searched words in this
  /// conversation, when that is how it matched.
  final SessionContentHit? found;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final cell = terminal ? terminalCellSizeOf(context) : Size.zero;
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    final muted = terminal
        ? terminalContentStyle(color: theme.foreground.withValues(alpha: .54))
        : _muted;
    final body = terminal
        ? terminalContentStyle(color: theme.foreground)
        : _body;
    Widget section(String label, String text, {int? maxLines}) =>
        _Section(label, text, maxLines: maxLines, terminal: terminal);
    final (:machine, :agent) = item;
    final record = app.sessionPreviews.read(
      app.previewKey(machine.machine.machineId, agent),
    );
    final unavailable = harnessSessionUnavailable(machine, agent);
    final offline = unavailable != null;
    final waiting = offline ? null : machine.blockedAgents[agent.id];
    final working = !offline && machine.processingAgentIds.contains(agent.id);
    final state =
        unavailable ??
        (waiting != null
            ? 'Needs you'
            : working
            ? 'Working'
            : 'Idle');
    final color = offline
        ? muted.color!
        : waiting != null
        ? terminal
              ? theme.yellow
              : const Color(0xffe9bf79)
        : working
        ? terminal
              ? theme.blue
              : const Color(0xffadc5eb)
        : terminal
        ? theme.green
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

    final waitingBox = waiting == null
        ? null
        : Container(
            width: double.infinity,
            padding: terminal ? EdgeInsets.zero : const EdgeInsets.all(16),
            decoration: terminal
                ? null
                : BoxDecoration(
                    color: color.withValues(alpha: .06),
                    border: Border.all(color: color.withValues(alpha: .24)),
                    borderRadius: BorderRadius.circular(12),
                  ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Needs your input',
                  style: terminal
                      ? terminalContentStyle(color: color)
                      : AppType.monoLabel(
                          fontWeight: FontWeight.w600,
                          color: color,
                        ),
                ),
                if (!terminal) const SizedBox(height: 8),
                Text(_displayText(waiting.prompt), style: body),
                if (waiting.options.isNotEmpty) ...[
                  SizedBox(height: terminal ? cell.height : 12),
                  Text(waiting.options.take(6).join('  ·  '), style: muted),
                ],
              ],
            ),
          );
    if (part == _Part.footer) {
      // Below the latest turn: the question waiting on the person, or that
      // the agent is still at work on this turn.
      if (waitingBox != null) return waitingBox;
      if (!working) return const SizedBox.shrink();
      return Text('Working', style: muted.copyWith(color: color));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (terminal) ...[
          Text(agent.displayName, style: body),
          Text(
            statusLineParts(
              provider: '',
              machine: machine.machine.displayName,
              project: project?.label ?? '',
              branch: project?.shownBranch,
            ).text,
            style: muted,
          ),
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: '$state  ',
                  style: TextStyle(color: color),
                ),
                TextSpan(text: agentIdentity(agent).label),
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
                  style: AppType.monoLabel(
                    // The list leads the eye; the preview confirms it.
                    fontWeight: FontWeight.w600,
                    height: 1.25,
                  ),
                ),
              ),
              if (dense) ...[
                const SizedBox(width: 10),
                Text(state, style: boxMonoStyle(color: color)),
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
                    Text(state, style: boxMonoStyle(color: color)),
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
        if (part == _Part.header) ...[
          if (!terminal &&
              (project?.label.isNotEmpty == true || project?.branch != null))
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                [
                  if (project?.label case final label? when label.isNotEmpty)
                    label,
                  ?project?.branch,
                ].join(' · '),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: muted,
              ),
            ),
        ] else if (compact) ...[
          SizedBox(height: terminal ? cell.height : 10),
          Text(
            _displayText(excerpt ?? 'No recent session text available.'),
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: excerpt == null ? muted : body,
          ),
          if (project != null && !terminal)
            Padding(
              padding: EdgeInsets.only(top: terminal ? cell.height : 8),
              child: Text(
                [project.label, project.branch].whereType<String>().join(' · '),
                style: muted,
              ),
            ),
        ] else ...[
          SizedBox(
            height: terminal
                ? cell.height
                : dense
                ? 16
                : 26,
          ),
          if (found case final found? when found.field != 'name') ...[
            Text(
              [
                switch (found.field) {
                  'answer' => 'Found in an answer',
                  'tools' => 'Found in a command or file',
                  _ => 'Found in what you asked',
                },
                if (found.at case final at?)
                  '${harnessActivityAge(at, DateTime.now())} ago',
              ].join(' · '),
              style: terminal
                  ? muted
                  : muted.copyWith(fontWeight: FontWeight.w500),
            ),
            if (!terminal) const SizedBox(height: 7),
            SessionSnippetText(
              found,
              key: ValueKey('preview-found:${found.destinationId}'),
              style: body,
              maxLines: null,
            ),
            SizedBox(height: terminal ? cell.height : 24),
          ],
          if (waitingBox != null) ...[
            waitingBox,
            SizedBox(height: terminal ? cell.height : 24),
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
                padding: EdgeInsets.only(bottom: terminal ? cell.height : 24),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Earlier in this session',
                      style: terminal
                          ? muted
                          : muted.copyWith(fontWeight: FontWeight.w500),
                    ),
                    for (final text in record!.earlierResponses)
                      Padding(
                        padding: EdgeInsets.only(
                          top: terminal ? cell.height : 10,
                        ),
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
              padding: EdgeInsets.only(bottom: terminal ? cell.height : 24),
              child: Text('No recent session text available.', style: muted),
            ),
          if (!terminal) const SizedBox(height: 8),
          if (project?.cwd case final cwd?) Text(cwd, style: muted),
          if (!terminal)
            if (project?.branch case final branch?)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  children: [
                    Icon(
                      LucideIcons.gitBranch300,
                      size: 12,
                      color: muted.color,
                    ),
                    const SizedBox(width: 6),
                    Expanded(child: Text(branch, style: muted)),
                  ],
                ),
              ),
          if (record?.receivedAt case final at?)
            Padding(
              padding: EdgeInsets.only(top: terminal ? cell.height : 8),
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
    grid.AppTheme.watch(context);
    final theme = terminalThemeFor(
      grid.AppTheme.palette.value,
      terminalThemeStore.value,
    );
    return Padding(
      padding: EdgeInsets.only(
        bottom: terminal ? terminalCellSizeOf(context).height : 24,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: terminal
                ? terminalContentStyle(
                    color: theme.foreground.withValues(alpha: .54),
                  )
                : _muted.copyWith(fontWeight: FontWeight.w500),
          ),
          if (!terminal) const SizedBox(height: 7),
          Text(
            _displayText(text),
            style: terminal
                ? terminalContentStyle(color: theme.foreground)
                : _body,
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
