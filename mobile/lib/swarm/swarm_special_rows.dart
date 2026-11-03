import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/core/relative_time.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_message_row.dart' show SwarmMessageFrame, swarmChatText;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_session.dart';

// The notes in a chat that are not chat from their author, drawn as Desktop
// draws them: a routing note (route_row.dart), a note about a terminal
// (terminal_row.dart), and a Buddy's proposal as one line that opens its
// thread (task_line.dart). Each has no author heading, reply or receipt.

/// The reader of the Swarm whose chat [conversationId] is; null until one is
/// read (as the ship card finds its people).
SwarmReader? swarmReaderOf(BuildContext context, String conversationId) {
  final inbox = SwarmScope.of(context)?.inbox;
  if (inbox == null) return null;
  for (final swarm in inbox.swarms) {
    final reader = inbox.reader(swarm.id);
    if (reader?.snapshot?.conversation(conversationId) != null) return reader;
  }
  return null;
}

TextStyle _quiet() => swarmChatText(14, color: AppPalette.textSecondary);

/// A note's place: under a message's text, past the avatar's column.
const EdgeInsets _inset = EdgeInsets.fromLTRB(
  AppSpace.s + SwarmMessageFrame.column,
  AppSpace.xs,
  AppSpace.s,
  AppSpace.xs,
);

/// A quiet action beside a note, a finger's size.
class _NoteAction extends StatelessWidget {
  const _NoteAction({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.s),
          child: Center(
            widthFactor: 1,
            child: Text(
              label,
              style: swarmChatText(14, color: AppPalette.accentOnSurface),
            ),
          ),
        ),
      ),
    ),
  );
}

/// "Routed to …" with Details, read only (Desktop's `SuperTabRouteRow`).
class SwarmRouteRow extends StatefulWidget {
  const SwarmRouteRow({super.key, required this.message, required this.route});
  final SuperTabMessage message;
  final SuperTabRoute route;

  @override
  State<SwarmRouteRow> createState() => _SwarmRouteRowState();
}

class _SwarmRouteRowState extends State<SwarmRouteRow> {
  Map<String, dynamic>? _details;
  bool _expanded = false, _loading = false, _failed = false;

  /// The CLI's titleOf writes "name · engine model effort · machine"; a name
  /// with separators, or a title in another form, is kept whole.
  String get _target {
    final title = widget.route.pick.title;
    final parts = RegExp(r'^(.*) · ((?:Claude|Codex) .*) · (.*)$')
        .firstMatch(title);
    if (parts == null) return title;
    final name = parts.group(1)!;
    return name == 'New agent'
        ? 'new ${parts.group(2)!.split(' ').first} agent'
        : name;
  }

  String get _how => switch (widget.route.via) {
    'jev' => 'Jev ${((widget.route.p ?? 0) * 100).round()}%',
    'only' => 'Only available candidate',
    _ => 'Ranked by strength, price and quota',
  };

  Future<void> _load() async {
    if (_loading || _details != null) return;
    final reader = swarmReaderOf(context, widget.message.conversationId);
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      if (reader == null) throw StateError('No Swarm read yet');
      final answer = superTabMap(
        await reader.request(
          'GET',
          '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/route-decisions/'
              '${Uri.encodeComponent(widget.route.decisionId)}',
        ),
      );
      if (mounted) setState(() => _details = answer);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toggle() {
    setState(() => _expanded = !_expanded);
    if (_expanded) unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final style = _quiet();
    return Padding(
      padding: _inset,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(child: Text('Routed to $_target', style: style)),
              Semantics(
                expanded: _expanded,
                child: _NoteAction(
                  label: _expanded ? 'Hide details' : 'Details',
                  onTap: _toggle,
                ),
              ),
            ],
          ),
          if (_expanded) DefaultTextStyle(style: style, child: _detailsView()),
        ],
      ),
    );
  }

  Widget _detailsView() {
    final r = widget.route;
    final record = superTabMap(_details?['record'] ?? const {});
    final candidates = (record['candidates'] as List? ?? const []).map(
      superTabMap,
    );
    final excluded = (record['excluded'] as List? ?? const []).map(superTabMap);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: AppSpace.xs,
      children: [
        Text(r.pick.title),
        if (r.why.isNotEmpty) Text(r.why),
        Text('Selection: $_how'),
        if (_loading) const Text('Loading details…'),
        if (_failed)
          Row(
            children: [
              const Flexible(child: Text('Could not load this decision.')),
              _NoteAction(label: 'Retry', onTap: () => unawaited(_load())),
            ],
          ),
        if (record['instructionsRevision'] case final num revision)
          Text(
            revision == 0
                ? 'Relied on the built-in instructions'
                : 'Relied on instructions revision ${revision.toInt()}',
          ),
        if (candidates.isNotEmpty) ...[
          const Text('Considered'),
          for (final c in candidates)
            if (c['title'] case final String title)
              Text(
                [
                  title,
                  if (c['label'] case final String label) label,
                ].join(' — '),
              ),
        ],
        for (final e in excluded)
          Text('Unavailable: ${e['title']} — ${e['reason']}'),
      ],
    );
  }
}

/// A Lead's typing into a worker's terminal, or a machine's alert about one
/// (Desktop's `SuperTabTerminalRow`). Desktop's Switch PM… on a PM's limit
/// note waits for the phone's Switch PM screen.
class SwarmTerminalRow extends StatelessWidget {
  const SwarmTerminalRow({super.key, required this.message});
  final SuperTabMessage message;

  /// The backend wraps what was typed in one pair of backticks, and the text
  /// inside is as typed, backticks included: the first and the last are the
  /// wrapper, and what lies between is shown whole, in the terminal's face.
  static TextSpan typed(String text, TextStyle style) {
    final open = text.indexOf('`'), close = text.lastIndexOf('`');
    if (open < 0 || close == open) return TextSpan(text: text);
    return TextSpan(
      children: [
        TextSpan(text: text.substring(0, open)),
        TextSpan(
          text: text.substring(open + 1, close),
          style: style.copyWith(fontFamily: AppFont.mono),
        ),
        TextSpan(text: text.substring(close + 1)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final alert = message.source['kind'] != 'terminal-input';
    final style = _quiet();
    final until = message.source['alert'] == 'limit'
        ? DateTime.tryParse(message.source['limitedUntil'] as String? ?? '')
        : null;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpace.s,
        _inset.top,
        _inset.right,
        _inset.bottom,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: SwarmMessageFrame.column,
            child: Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.only(right: AppSpace.s, top: 2),
                child: Icon(
                  alert
                      ? LucideIcons.triangleAlert300
                      : LucideIcons.keyboard300,
                  size: 15,
                  color: alert ? AppPalette.warn : style.color,
                ),
              ),
            ),
          ),
          Expanded(
            child: Text.rich(
              TextSpan(
                children: [
                  typed(message.text, style),
                  if (until != null) TextSpan(text: ' until ${_time(until)}'),
                ],
              ),
              style: style,
            ),
          ),
        ],
      ),
    );
  }
}

/// The time when [at] is today, else the date and time, in local time.
String _time(DateTime at) {
  final local = at.toLocal(), today = DateTime.now();
  if (local.year == today.year &&
      local.month == today.month &&
      local.day == today.day) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.hour)}:${two(local.minute)}';
  }
  return fullDateTime(at);
}

/// The person a proposal speaks for, by username; "its owner" for one no
/// longer in the Swarm (Desktop's `buddyPersonName`).
String swarmProposalOwner(BuildContext context, SuperTabMessage message) {
  final id = message.proposalOwnerId!;
  return swarmReaderOf(
        context,
        message.conversationId,
      )?.snapshot?.people.where((p) => p.id == id).firstOrNull?.username ??
      'its owner';
}

/// A proposal's name: its Goal line, else its first line (Desktop's
/// `_proposalName`).
String swarmProposalName(String text) {
  final lines = text.split('\n').map((line) => line.trim());
  for (final line in lines) {
    if (line.startsWith('Goal: ')) return line.substring(6).trim();
  }
  return lines.first;
}

/// "Proposal from dee: …", one line that opens its thread, where it reads
/// whole (Desktop's `SuperTabProposalLine`, Quiet Swarm).
class SwarmProposalLine extends StatelessWidget {
  const SwarmProposalLine({
    super.key,
    required this.message,
    required this.onOpen,
  });
  final SuperTabMessage message;
  final VoidCallback onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final text =
        'Proposal from ${swarmProposalOwner(context, message)}: '
        '${swarmProposalName(message.text)}';
    return Semantics(
      button: true,
      label: text,
      excludeSemantics: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onOpen,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpace.l,
                vertical: AppSpace.s,
              ),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.chevronRight300,
                    size: 16,
                    color: AppPalette.textSecondary,
                  ),
                  const SizedBox(width: AppSpace.s),
                  Expanded(
                    child: Text(
                      text,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: swarmChatText(16),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Above a proposal read whole: whom it speaks for (Desktop's label).
class SwarmProposalLabel extends StatelessWidget {
  const SwarmProposalLabel({super.key, required this.owner});
  final String owner;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
    child: Container(
      key: const ValueKey('swarm-proposal-label'),
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.s, vertical: 2),
      decoration: BoxDecoration(
        border: Border.all(color: AppPalette.textFaint),
        borderRadius: BorderRadius.circular(AppSpace.s),
      ),
      child: Text("Proposal · on $owner's behalf", style: _quiet()),
    ),
  );
}

/// The quiet line a terminal's answer starts with, and the one under a
/// response that was cut short (Desktop's view.dart).
Widget? swarmTerminalNote(SuperTabMessage message) =>
    switch (message.terminalNote) {
      final note? => Padding(
        padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
        child: Text(note, style: _quiet()),
      ),
      null => null,
    };

Widget? swarmCutShort(SuperTabMessage message) {
  final words = message.source['truncated'] == true
      ? 'Excerpt · open the terminal for the full response'
      : message.source['interrupted'] == true
      ? 'Response interrupted'
      : null;
  return words == null
      ? null
      : Padding(
          padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
          child: Text(words, style: _quiet()),
        );
}
