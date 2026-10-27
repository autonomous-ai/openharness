import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/phone/settings_row.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_session.dart';

/// Opens [conversationId] of Swarm [swarmId] over the current page.
void openSwarmConversation(
  BuildContext context,
  String swarmId,
  String conversationId,
) => unawaited(
  Navigator.of(context).push(
    phoneRoute(
      (_) => SwarmConversationPage(
        swarmId: swarmId,
        conversationId: conversationId,
      ),
    ),
  ),
);

/// The host the backend serves message files from: a link anywhere else is
/// not opened (the desktop's `attachmentLink`).
const swarmAttachmentHost = String.fromEnvironment(
  'SUPER_TAB_ATTACHMENTS_HOST',
  defaultValue: 'cdn.harness.autonomous.ai',
);

/// [url] as a link to open, or null unless it is https on
/// [swarmAttachmentHost]: a message's url is whatever its sender's row says.
Uri? swarmAttachmentLink(String url) {
  final link = Uri.tryParse(url);
  return link != null &&
          link.scheme == 'https' &&
          link.host == swarmAttachmentHost
      ? link
      : null;
}

/// One conversation: its messages, newest at the foot, older ones on demand;
/// the decisions asked of the person in it; and, for a writer, a composer
/// that posts text with @mentions of the conversation's agents. Files are
/// opened, not sent ([swarmSendsFiles]).
class SwarmConversationPage extends StatefulWidget {
  const SwarmConversationPage({
    super.key,
    required this.swarmId,
    required this.conversationId,
  });

  final String swarmId, conversationId;

  @override
  State<SwarmConversationPage> createState() => _SwarmConversationPageState();
}

class _SwarmConversationPageState extends State<SwarmConversationPage> {
  SwarmSession? _session;
  SwarmConversation? _conversation;
  final _text = TextEditingController();

  @override
  void initState() {
    super.initState();
    _text.addListener(_typed);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    if (session == _session) return;
    _close();
    _session = session?..enter();
    session?.inbox.addListener(_attach);
    _attach(rebuild: false);
  }

  /// Opens the conversation once its Swarm has been read: at once, or when
  /// the account's Swarms are first read — a notice tapped at launch opens
  /// this page before then.
  void _attach({bool rebuild = true}) {
    final session = _session;
    final reader = session?.inbox.reader(widget.swarmId);
    if (session == null || reader == null || _conversation != null) return;
    session.inbox.removeListener(_attach);
    session.watch(widget.swarmId);
    _conversation = SwarmConversation(reader, widget.conversationId)
      ..addListener(_drafted);
    unawaited(_conversation!.load());
    if (rebuild && mounted) setState(() {});
  }

  void _close() {
    final session = _session;
    session?.inbox.removeListener(_attach);
    if (_conversation case final c?) {
      c
        ..removeListener(_drafted)
        ..dispose();
      session?.unwatch(widget.swarmId);
    }
    _conversation = null;
    session?.leave();
    _session = null;
  }

  @override
  void dispose() {
    _close();
    _text.dispose();
    super.dispose();
  }

  /// What the person typed, into the draft.
  void _typed() {
    final c = _conversation;
    if (c != null && c.draft != _text.text) c.draft = _text.text;
  }

  /// The draft changed under the field — a mention added, a post sent.
  void _drafted() {
    final draft = _conversation?.draft;
    if (draft == null || draft == _text.text) return;
    _text.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  void _mention() {
    final c = _conversation;
    if (c == null) return;
    unawaited(
      showPhoneSheet(
        context,
        title: 'Mention',
        actions: [
          for (final agent in c.mentionable)
            PhoneSheetAction(
              icon: LucideIcons.atSign300,
              label: c.reader.snapshot?.agentName(agent.id) ?? agent.name,
              onTap: () => c.mention(agent.id),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final session = _session;
    final c = _conversation;
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: session == null || c == null
            ? Align(
                alignment: Alignment.topLeft,
                child: TtyBackButton(
                  onPressed: () => Navigator.of(context).maybePop(),
                ),
              )
            : ListenableBuilder(
                listenable: Listenable.merge([c, session, session.inbox]),
                builder: (context, _) => _page(context, session, c, tty),
              ),
      ),
    );
  }

  Widget _page(
    BuildContext context,
    SwarmSession session,
    SwarmConversation c,
    Tty tty,
  ) {
    final group = c.conversation;
    final snapshot = c.reader.snapshot;
    final project = snapshot?.projects
        .where((p) => p.id == group?.projectId)
        .firstOrNull;
    final decisions = [
      for (final need in session.inbox.needs)
        if (need is SwarmDecisionNeed &&
            need.swarmId == widget.swarmId &&
            need.conversationId == widget.conversationId)
          need,
    ];
    final messages = c.messages.reversed.toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TtyText(
                    group?.label ?? 'Chat',
                    size: TtySize.row,
                    weight: FontWeight.w600,
                  ),
                  if (project != null)
                    TtyText(project.name, color: tty.dim, size: TtySize.meta),
                ],
              ),
            ),
          ],
        ),
        Expanded(
          child: group == null && c.messages.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(Tty.origin),
                  child: Text(
                    c.error ?? 'This chat is not open to you.',
                    style: tty.style(color: tty.dim),
                  ),
                )
              : ListView.builder(
                  key: const ValueKey('swarm-messages'),
                  reverse: true,
                  padding: const EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    8,
                  ),
                  itemCount: messages.length + (c.hasOlder ? 1 : 0),
                  itemBuilder: (context, index) => index < messages.length
                      ? _Message(message: messages[index])
                      : Align(
                          alignment: Alignment.centerLeft,
                          child: TtyTextButton(
                            key: const ValueKey('swarm-older-messages'),
                            label: 'Earlier messages',
                            size: TtySize.meta,
                            onPressed: () => unawaited(c.loadOlder()),
                          ),
                        ),
                ),
        ),
        if (decisions.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Tty.origin),
            child: SettingsGroup(
              children: [
                for (final need in decisions)
                  SwarmDecisionCard(session: session, need: need),
              ],
            ),
          ),
        // Unless the body says it already: no conversation and nothing read.
        if (c.error case final error?
            when group != null || c.messages.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 6, Tty.origin, 0),
            child: Text(
              error,
              key: const ValueKey('swarm-post-error'),
              style: tty.style(color: tty.red, size: TtySize.meta),
            ),
          ),
        if (c.canPost)
          Padding(
            padding: const EdgeInsets.fromLTRB(Tty.origin, 6, Tty.origin, 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                if (c.mentionable.isNotEmpty)
                  TtyTextButton(
                    key: const ValueKey('swarm-mention'),
                    label: '@',
                    size: TtySize.title,
                    onPressed: _mention,
                  ),
                Expanded(
                  child: TtyField(
                    controller: _text,
                    hint: 'Message',
                    lines: 4,
                    action: TextInputAction.newline,
                  ),
                ),
                const SizedBox(width: 8),
                TtyTextButton(
                  key: const ValueKey('swarm-send'),
                  label: c.sending
                      ? 'Sending…'
                      : c.unconfirmed
                      ? 'Send again'
                      : 'Send',
                  onPressed:
                      c.sending || c.draft.trim().isEmpty && !c.unconfirmed
                      ? null
                      : () => unawaited(c.send()),
                ),
              ],
            ),
          )
        else if (group != null)
          Padding(
            padding: const EdgeInsets.all(Tty.origin),
            child: Text(
              group.archived
                  ? 'This chat is archived.'
                  : 'You can read this chat, not post in it.',
              key: const ValueKey('swarm-read-only'),
              style: tty.style(color: tty.dim, size: TtySize.meta),
            ),
          ),
      ],
    );
  }
}

/// One message: who wrote it and when, its text, and its files to open.
class _Message extends StatelessWidget {
  const _Message({required this.message});

  final SuperTabMessage message;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final at = message.createdAt?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return Padding(
      key: ValueKey('swarm-message-${message.id}'),
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: message.authorName,
                  style: tty.style(
                    color: message.fromAgent ? tty.cyan : tty.green,
                    weight: FontWeight.w600,
                    size: TtySize.meta,
                  ),
                ),
                if (at != null)
                  TextSpan(
                    text: '  ${two(at.hour)}:${two(at.minute)}',
                    style: tty.style(color: tty.dim, size: TtySize.meta),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 2),
          if (message.text.isNotEmpty)
            SelectableText(message.text, style: tty.style(size: TtySize.row)),
          for (final file in message.attachments)
            _File(file: file, link: swarmAttachmentLink(file.url)),
        ],
      ),
    );
  }
}

/// A message's file: opened in the browser when its link is the backend's.
class _File extends StatelessWidget {
  const _File({required this.file, required this.link});

  final SuperTabAttachment file;
  final Uri? link;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final kb = (file.size / 1024).ceil();
    final label =
        'File: ${file.name} · ${kb < 1024 ? '$kb KB' : '${(kb / 1024).toStringAsFixed(1)} MB'}';
    final url = link;
    return TtyTap(
      minHeight: 32,
      semanticsLabel: label,
      onTap: url == null
          ? null
          : () => unawaited(launchUrl(url, mode: LaunchMode.inAppBrowserView)),
      child: Text(
        label,
        style: tty.style(
          color: url == null ? tty.dim : tty.blue,
          size: TtySize.meta,
        ),
      ),
    );
  }
}
