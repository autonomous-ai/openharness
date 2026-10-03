import 'package:flutter/material.dart';

import '../state/harness_sessions.dart';
import '../state/session_tail.dart';

/// Use the same under-a-minute wording as the search result's activity label.
String sessionPreviewAge(DateTime at, DateTime now) =>
    now.difference(at).inMinutes < 1
    ? 'now'
    : '${harnessActivityAge(at, now)} ago';

/// A session's latest turns as Cmd-P previews them: bottom-anchored like the
/// agent's own terminal, newest at the bottom, scrolled up for older ones.
/// Scrolling near the top pages in the rows above. The latest ask stays in
/// view: pinned above the turns whenever its own row is not.
class SessionTailView extends StatefulWidget {
  const SessionTailView({
    super.key,
    required this.tail,
    required this.tails,
    required this.tailKey,
    required this.controller,
    required this.words,
    required this.body,
    required this.muted,
    required this.gap,
    required this.padding,
    this.footer,
    this.now,
  });

  final SessionTail tail;
  final SessionTails tails;
  final SessionTailKey tailKey;
  final ScrollController controller;

  /// The searched words, shown in bold where the text holds them.
  final List<String> words;
  final TextStyle body, muted;

  /// The space between turns: a terminal cell's height, or points.
  final double gap;
  final EdgeInsets padding;

  /// What sits below the latest turn: a question waiting for an answer, or
  /// what the agent is doing right now.
  final Widget? footer;
  final DateTime? now;

  @override
  State<SessionTailView> createState() => _SessionTailViewState();
}

class _SessionTailViewState extends State<SessionTailView> {
  final _list = GlobalKey();
  final _ask = GlobalKey();
  bool _pinned = false;
  bool _checkScheduled = false;

  @override
  void didUpdateWidget(SessionTailView oldWidget) {
    super.didUpdateWidget(oldWidget);
    _scheduleCheck();
  }

  @override
  void initState() {
    super.initState();
    _scheduleCheck();
  }

  void _scheduleCheck() {
    if (_checkScheduled) return;
    _checkScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkScheduled = false;
      if (mounted) _check();
    });
  }

  /// Pinned while the latest ask's own line is above the list's top, or not
  /// built at all: scrolled far off, or on a page not loaded. The list is
  /// anchored at its bottom, so the pinned line taking room above it never
  /// brings the ask back into view — no flicker between the two.
  void _check() {
    final lastAsk = widget.tail.lastAsk;
    var pinned = false;
    if (lastAsk != null) {
      final list = _list.currentContext?.findRenderObject() as RenderBox?;
      final ask = _ask.currentContext?.findRenderObject() as RenderBox?;
      if (ask == null || !ask.attached || list == null || !list.attached) {
        pinned = true;
      } else {
        final top = ask.localToGlobal(Offset.zero).dy;
        pinned = top < list.localToGlobal(Offset.zero).dy - 0.5;
      }
    }
    if (pinned != _pinned) setState(() => _pinned = pinned);
  }

  @override
  Widget build(BuildContext context) {
    final tail = widget.tail;
    final tails = widget.tails;
    final tailKey = widget.tailKey;
    final gap = widget.gap;
    final muted = widget.muted;
    final rows = tail.rows;
    final footer = widget.footer;
    final extra = footer == null ? 0 : 1;
    final when = widget.now ?? DateTime.now();
    final lastAsk = tail.lastAsk;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_pinned && lastAsk != null)
          Padding(
            padding: EdgeInsets.fromLTRB(
              widget.padding.left,
              0,
              widget.padding.right,
              gap,
            ),
            child: Column(
              key: const ValueKey('preview-last-ask'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  [
                    'Asked',
                    if (lastAsk.at case final at?) sessionPreviewAge(at, when),
                  ].join(' · '),
                  style: muted,
                ),
                Text(
                  '› ${tailText(lastAsk.ask)}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: widget.body.copyWith(fontWeight: FontWeight.w600),
                ),
              ],
            ),
          ),
        Expanded(
          child: KeyedSubtree(
            key: _list,
            child: NotificationListener<ScrollNotification>(
              onNotification: (notification) {
                _scheduleCheck();
                // Reversed: what lies after the viewport is older.
                if (tail.hasMore && notification.metrics.extentAfter < 600) {
                  tails.older(tailKey);
                }
                return false;
              },
              child: ListView.builder(
                key: ValueKey(
                  'session-tail:${tailKey.machineId}:${tailKey.sessionId}',
                ),
                controller: widget.controller,
                reverse: true,
                padding: widget.padding,
                itemCount: rows.length + extra + 1,
                itemBuilder: (context, index) {
                  if (footer != null && index == 0) {
                    return Padding(
                      padding: EdgeInsets.only(top: gap),
                      child: footer,
                    );
                  }
                  final at = index - extra;
                  if (at == rows.length) {
                    return Padding(
                      padding: EdgeInsets.only(bottom: gap),
                      child: Text(
                        tails.loadingOlder(tailKey)
                            ? 'Loading earlier turns…'
                            : tail.hasMore
                            ? 'Earlier turns above'
                            : 'Start of conversation',
                        style: muted,
                      ),
                    );
                  }
                  final row = rows[rows.length - 1 - at];
                  return _TailRowView(
                    row: row,
                    askKey: row.turn == lastAsk?.turn ? _ask : null,
                    first: at == rows.length - 1,
                    words: widget.words,
                    body: widget.body,
                    muted: muted,
                    gap: gap,
                    now: when,
                  );
                },
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _TailRowView extends StatelessWidget {
  const _TailRowView({
    required this.row,
    this.askKey,
    required this.first,
    required this.words,
    required this.body,
    required this.muted,
    required this.gap,
    required this.now,
  });

  final SessionTailRow row;

  /// On the latest ask's line, so the view can tell whether it is in sight.
  final GlobalKey? askKey;
  final bool first;
  final List<String> words;
  final TextStyle body, muted;
  final double gap;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final opens = row.ask.isNotEmpty;
    final tools = row.tools;
    return Padding(
      padding: EdgeInsets.only(top: first ? 0 : (opens ? gap * 1.5 : gap * .5)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (opens) ...[
            if (row.at case final at?)
              Text(sessionPreviewAge(at, now), style: muted),
            Text.rich(
              key: askKey,
              TextSpan(
                children: [
                  const TextSpan(text: '› '),
                  ...highlightWords(tailText(row.ask), words),
                ],
              ),
              maxLines: 8,
              overflow: TextOverflow.ellipsis,
              style: body.copyWith(fontWeight: FontWeight.w600),
            ),
          ],
          if (row.answer.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(top: opens ? gap * .5 : 0),
              child: Text.rich(
                TextSpan(children: highlightWords(tailText(row.answer), words)),
                style: body,
              ),
            ),
          if (tools.isNotEmpty)
            Padding(
              padding: EdgeInsets.only(top: gap * .5),
              child: Text(
                [
                  // A call is its command whole, often a line on its own.
                  for (final tool in tools.take(6).map(_shortTool))
                    tool.length > 60 ? '${tool.substring(0, 59)}…' : tool,
                  if (tools.length > 6) '+${tools.length - 6} more',
                ].join('  ·  '),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: muted,
              ),
            ),
        ],
      ),
    );
  }
}

/// A tool call as the tools line shows it: a command's leading `cd <folder>`
/// is where it ran, not what it did.
String _shortTool(String tool) => tool.replaceFirstMapped(
  RegExp(r'^(\S+) cd \S+ (?:&&|;) '),
  (match) => '${match[1]} ',
);

/// Stored text as a reader wants it: the words and line breaks, without the
/// markdown delimiters around them.
String tailText(String text) => text
    .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^\n)]+\)'), (m) => m[1]!)
    .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
    .replaceAll('**', '')
    .replaceAll('`', '');

/// [text] as spans, each word that starts with one of [words] in bold — the
/// way the index matched it: by word start, whatever the case.
List<InlineSpan> highlightWords(String text, List<String> words) {
  final terms = [
    for (final word in words)
      if (word.trim().isNotEmpty) RegExp.escape(word.trim().toLowerCase()),
  ];
  if (terms.isEmpty) return [TextSpan(text: text)];
  final pattern = RegExp(
    '(?<![\\p{L}\\p{N}])(?:${terms.join('|')})[\\p{L}\\p{N}]*',
    caseSensitive: false,
    unicode: true,
  );
  final spans = <InlineSpan>[];
  var cursor = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, match.start)));
    }
    spans.add(
      TextSpan(
        text: match[0],
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
    );
    cursor = match.end;
  }
  if (cursor < text.length) spans.add(TextSpan(text: text.substring(cursor)));
  return spans;
}
