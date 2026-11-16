import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/terminal/question_pane.dart';

import 'chat_transcript.dart';

/// An agent's conversation as chat: what was asked on the right, the agent's answers in Markdown,
/// one line per tool it ran, and the dialog it is waiting on as buttons.
///
/// It covers the terminal rather than replacing it (`phone/terminal_page.dart`): the pane stays
/// attached underneath, because an open question is read off its screen and an answer is keyed
/// into it.
class ChatTranscriptView extends StatefulWidget {
  const ChatTranscriptView({
    super.key,
    required this.conversation,
    this.topInset = 0,
    this.question,
    this.onAnswer,
    this.onAnswerInTerminal,
  });

  final ChatConversation conversation;

  /// Room left at the top for chrome floating over the view: the oldest row can scroll clear of it.
  final double topInset;

  /// The dialog open on the agent's screen; null when there is none.
  final QuestionPaneView? question;

  /// Presses [QuestionPaneRow.number] of [question].
  final void Function(QuestionPaneView view, String number)? onAnswer;

  /// A dialog a tap cannot answer (several answers at once, a form's field): the terminal.
  final VoidCallback? onAnswerInTerminal;

  @override
  State<ChatTranscriptView> createState() => _ChatTranscriptViewState();
}

class _ChatTranscriptViewState extends State<ChatTranscriptView> {
  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return ColoredBox(
      color: AppPalette.windowBg,
      child: ListenableBuilder(
        listenable: widget.conversation,
        builder: (context, _) => _body(context),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final conversation = widget.conversation;
    switch (conversation.load) {
      case ChatLoad.idle:
      case ChatLoad.loading:
        return const Center(child: CircularProgressIndicator.adaptive());
      case ChatLoad.failed:
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                "Couldn't load the chat.",
                style: AppType.body(color: AppPalette.textSecondary),
              ),
              const SizedBox(height: AppSpace.s),
              TextButton(
                onPressed: () => unawaited(conversation.open()),
                child: const Text('Retry'),
              ),
            ],
          ),
        );
      case ChatLoad.loaded:
        break;
    }
    final items = conversation.items;
    final question = widget.question;
    // Newest at the bottom, and the list starts there: a reversed list, read from its end.
    // The foot — the dialog, then the turn's status — is index 0.
    final foot = <Widget>[
      if (question != null && question.answerable)
        _QuestionCard(
          view: question,
          onAnswer: widget.onAnswer,
          onAnswerInTerminal: widget.onAnswerInTerminal,
        ),
      _TurnStatus(conversation: conversation),
    ];
    final top = conversation.hasMore || conversation.loadingOlder ? 1 : 0;
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        // Near the top of what is held: the page before it.
        if (notification.metrics.extentAfter < 600) {
          unawaited(conversation.loadOlder());
        }
        return false;
      },
      child: ListView.builder(
        reverse: true,
        padding: EdgeInsets.fromLTRB(
          AppSpace.l,
          widget.topInset + AppSpace.s,
          AppSpace.l,
          AppSpace.l,
        ),
        itemCount: foot.length + items.length + top,
        itemBuilder: (context, index) {
          if (index < foot.length) return foot[foot.length - 1 - index];
          final at = index - foot.length;
          if (at >= items.length) {
            return const Padding(
              padding: EdgeInsets.all(AppSpace.l),
              child: Center(child: CircularProgressIndicator.adaptive()),
            );
          }
          final item = items[items.length - 1 - at];
          return switch (item.role) {
            ChatRole.user => _UserBubble(text: item.text),
            ChatRole.assistant => _AssistantText(item: item),
            ChatRole.tool => _ToolLine(item: item),
          };
        },
      ),
    );
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(
      top: AppSpace.l,
      bottom: AppSpace.s,
      left: 48,
    ),
    child: Align(
      alignment: Alignment.centerRight,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: AppSurface.recess,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpace.m + 2,
            vertical: AppSpace.s + 2,
          ),
          child: SelectableText(
            text.trim(),
            style: AppType.body(color: AppPalette.textPrimary, height: 1.4),
          ),
        ),
      ),
    ),
  );
}

class _AssistantText extends StatelessWidget {
  const _AssistantText({required this.item});

  final ChatItem item;

  @override
  Widget build(BuildContext context) {
    final body = AppType.body(
      color: item.commentary
          ? AppPalette.textSecondary
          : AppPalette.textPrimary,
      height: 1.45,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpace.xs + 2),
      child: MarkdownBody(
        data: item.text,
        selectable: true,
        softLineBreak: true,
        extensionSet: md.ExtensionSet.gitHubFlavored,
        styleSheet: _markdownStyle(context, body),
        imageBuilder: (uri, title, alt) => Text(
          alt?.isNotEmpty == true ? 'Image: $alt' : 'Image',
          style: AppType.caption(color: AppPalette.textSecondary),
        ),
        onTapLink: (_, href, _) {
          final uri = href == null ? null : Uri.tryParse(href);
          if (uri != null && (uri.scheme == 'https' || uri.scheme == 'http')) {
            unawaited(launchUrl(uri, mode: LaunchMode.inAppBrowserView));
          }
        },
      ),
    );
  }
}

MarkdownStyleSheet _markdownStyle(BuildContext context, TextStyle body) {
  final heading = body.copyWith(fontWeight: FontWeight.w600);
  final mono = AppType.mono(color: AppPalette.textPrimary);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
    p: body,
    a: TextStyle(
      color: AppPalette.accentOnSurface,
      decoration: TextDecoration.underline,
    ),
    h1: AppType.title(),
    h2: AppType.heading(),
    h3: heading,
    h4: heading,
    h5: heading,
    h6: heading,
    strong: const TextStyle(fontWeight: FontWeight.w600),
    code: mono.copyWith(backgroundColor: AppSurface.wellFill),
    codeblockDecoration: BoxDecoration(
      color: AppSurface.wellFill,
      borderRadius: BorderRadius.circular(8),
    ),
    codeblockPadding: const EdgeInsets.all(AppSpace.m),
    blockSpacing: 8,
    listIndent: 20,
    listBullet: body,
    blockquote: body.copyWith(color: AppPalette.textSecondary),
    tableBody: body,
    tableHead: heading,
  );
}

/// One tool the agent ran: its name and what it was given, on one line.
class _ToolLine extends StatelessWidget {
  const _ToolLine({required this.item});

  final ChatItem item;

  @override
  Widget build(BuildContext context) {
    final color = item.toolError
        ? AppPalette.dangerFill
        : AppPalette.textSecondary;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 14,
            child: item.toolDone
                ? Icon(
                    item.toolError ? LucideIcons.x : LucideIcons.check,
                    size: 14,
                    color: color,
                  )
                : CircularProgressIndicator(
                    strokeWidth: 1.6,
                    color: AppPalette.textSecondary,
                  ),
          ),
          const SizedBox(width: AppSpace.s),
          Text(
            item.tool ?? 'Tool',
            style: AppType.label(
              color: AppPalette.textPrimary,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (item.text.isNotEmpty) ...[
            const SizedBox(width: AppSpace.s),
            Expanded(
              child: Text(
                item.text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.monoMeta(color: color),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "Working… 12s" while a turn runs; "Worked for 12s" once it ends.
class _TurnStatus extends StatefulWidget {
  const _TurnStatus({required this.conversation});

  final ChatConversation conversation;

  @override
  State<_TurnStatus> createState() => _TurnStatusState();
}

class _TurnStatusState extends State<_TurnStatus> {
  Timer? _tick;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final conversation = widget.conversation;
    final since = conversation.workingSince;
    String? line;
    if (conversation.working) {
      _tick ??= Timer.periodic(
        const Duration(seconds: 1),
        (_) => mounted ? setState(() {}) : null,
      );
      line = since == null
          ? 'Working…'
          : 'Working… ${_duration(DateTime.now().difference(since))}';
    } else {
      _tick?.cancel();
      _tick = null;
      final last = conversation.lastTurn;
      if (last != null) {
        line = conversation.lastTurnStopped
            ? 'Stopped after ${_duration(last)}'
            : 'Worked for ${_duration(last)}';
      }
    }
    if (line == null) return const SizedBox(height: AppSpace.s);
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.m),
      child: Text(line, style: AppType.caption(color: AppPalette.textFaint)),
    );
  }
}

String _duration(Duration d) {
  if (d.inMinutes < 1) return '${d.inSeconds}s';
  if (d.inHours < 1) return '${d.inMinutes}m ${d.inSeconds % 60}s';
  return '${d.inHours}h ${d.inMinutes % 60}m';
}

/// The dialog the agent is waiting on, with one button per answer.
class _QuestionCard extends StatelessWidget {
  const _QuestionCard({
    required this.view,
    this.onAnswer,
    this.onAnswerInTerminal,
  });

  final QuestionPaneView view;
  final void Function(QuestionPaneView view, String number)? onAnswer;
  final VoidCallback? onAnswerInTerminal;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: AppSpace.m),
    child: DecoratedBox(
      decoration: BoxDecoration(
        color: AppPalette.cardBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppPalette.divider),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpace.m),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              view.question,
              style: AppType.body(
                color: AppPalette.textPrimary,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: AppSpace.s),
            if (view.tappable)
              for (final row in view.rows)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpace.xs),
                  child: OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      alignment: Alignment.centerLeft,
                      foregroundColor: AppPalette.textPrimary,
                      side: BorderSide(color: AppPalette.divider),
                    ),
                    onPressed: onAnswer == null
                        ? null
                        : () => onAnswer!(view, row.number),
                    child: Text('${row.number}. ${row.label}'),
                  ),
                )
            else
              TextButton(
                onPressed: onAnswerInTerminal,
                child: const Text('Answer in terminal'),
              ),
          ],
        ),
      ),
    ),
  );
}
