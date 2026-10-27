import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/phone/composing_keyboard.dart';
import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_inbox.dart';
import 'swarm_need_rows.dart';
import 'swarm_session.dart';
import 'team_glance.dart';

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

/// One conversation: its messages, newest at the foot, older ones on demand —
/// each with who wrote it, their role and when, follow-ups grouped, a reply's
/// quote leading to its original; the decisions asked of the person in it;
/// and, for a writer, a composer that posts text, as a reply or with
/// @mentions of the conversation's agents picked as they are typed. A post
/// shows at once and says when it is not confirmed. Files are opened, not
/// sent ([swarmSendsFiles]): there is no attach button.
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
  final _focus = FocusNode(debugLabel: 'Swarm composer');
  final _scroll = ScrollController();

  /// The message whose actions are open (Reply, Copy), by a tap on it.
  String? _acting;

  /// A quote followed to its original: the original being brought into view,
  /// the one lit for a moment on arrival, the search through earlier pages,
  /// and what to say when it cannot be found.
  String? _target, _lit;
  final _targetKey = GlobalKey();
  Timer? _litTimer;
  bool _finding = false;
  String? _note;

  /// Earlier messages are read on their own as the person nears the top;
  /// "Earlier messages" is offered only once that read failed.
  bool _loadingOlder = false, _olderFailed = false;

  /// No other screen covers this one.
  bool _visible = true;
  bool _watching = false;

  /// What the chat draws of its Swarm's read, told to the page only when
  /// something drawn changed ([_ChatView]).
  final _view = ValueNotifier<_ChatView?>(null);

  @override
  void initState() {
    super.initState();
    _text.addListener(_typed);
    _scroll.addListener(_nearTop);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Off while a screen pushed over this one covers it.
    _visible = TickerMode.valuesOf(context).enabled;
    final session = SwarmScope.of(context);
    if (session == _session) {
      _watch();
      return;
    }
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
    final c = _conversation = SwarmConversation(reader, widget.conversationId);
    c.composer.addListener(_drafted);
    reader.addListener(_see);
    session.inbox.addListener(_see);
    _see();
    _watch();
    unawaited(_conversation!.load());
    if (rebuild && mounted) setState(() {});
  }

  /// Its Swarm is watched while the chat is open and visible, so it is read
  /// every few seconds only then ([SwarmSession.watch]).
  void _watch() {
    final watch = _conversation != null && _visible;
    if (watch == _watching) return;
    _watching = watch;
    if (watch) {
      _session?.watch(widget.swarmId);
    } else {
      _session?.unwatch(widget.swarmId);
    }
  }

  /// The chat's [_ChatView] made again from what its Swarm's read and asks
  /// say now.
  void _see() {
    final session = _session, c = _conversation;
    if (session == null || c == null) return;
    _view.value = _ChatView.of(session, c, _view.value);
  }

  void _close() {
    final session = _session;
    session?.inbox
      ?..removeListener(_attach)
      ..removeListener(_see);
    if (_conversation case final c?) {
      c.composer.removeListener(_drafted);
      c.reader.removeListener(_see);
      c.dispose();
    }
    if (_watching) session?.unwatch(widget.swarmId);
    _watching = false;
    _conversation = null;
    session?.leave();
    _session = null;
  }

  @override
  void dispose() {
    _close();
    _view.dispose();
    _litTimer?.cancel();
    _text.dispose();
    _focus.dispose();
    _scroll.dispose();
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

  /// An @ to type a name after: the picker opens over the composer.
  void _mention(SwarmConversation c) {
    final draft = c.draft;
    final spaced = draft.isEmpty || RegExp(r'\s$').hasMatch(draft);
    c.draft = '$draft${spaced ? '' : ' '}@';
    _focus.requestFocus();
  }

  /// How close to the oldest message shown the earlier ones start to be
  /// read: a screen's height ahead, so they are there before the person is.
  void _nearTop() {
    final c = _conversation;
    if (c == null ||
        !c.hasOlder ||
        _loadingOlder ||
        _olderFailed ||
        _finding ||
        !_scroll.hasClients) {
      return;
    }
    final position = _scroll.position;
    // The list runs from the foot: what is after the view is above it.
    if (position.extentAfter < position.viewportDimension) {
      unawaited(_loadOlder(c));
    }
  }

  /// Reads the page before the oldest message shown. The list is drawn from
  /// its foot, so what arrives above leaves what the person reads in place.
  Future<void> _loadOlder(SwarmConversation c) async {
    if (_loadingOlder || !c.hasOlder) return;
    setState(() {
      _loadingOlder = true;
      _olderFailed = false;
    });
    final shown = c.messages.length;
    await c.loadOlder();
    if (!mounted || _conversation != c) return;
    setState(() {
      _loadingOlder = false;
      // A read that failed, or brought nothing new while more is said to be
      // there, is not tried again on its own: it would be read over and over.
      _olderFailed =
          c.hasOlder && (c.error != null || c.messages.length == shown);
    });
  }

  /// Sends the draft, back at the foot of the chat where the post shows.
  void _send(SwarmConversation c) {
    _target = null;
    if (_scroll.hasClients && _scroll.offset > 0) {
      unawaited(
        _scroll.animateTo(
          0,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        ),
      );
    }
    unawaited(c.send());
  }

  void _reply(SwarmConversation c, SuperTabMessage message) {
    c.replyingTo = message;
    setState(() => _acting = null);
    _focus.requestFocus();
  }

  /// How many earlier pages a quote's original is looked for in: as many as
  /// a tag opens through on the desktop.
  static const _findPages = 50;

  /// Brings [messageId] into view and lights it — read in from earlier pages
  /// when it is further back — or says why it cannot.
  Future<void> _jumpTo(SwarmConversation c, String messageId) async {
    if (_finding) return;
    setState(() {
      _finding = true;
      _note = null;
    });
    bool has() => c.messages.any((m) => m.id == messageId);
    var pages = 0;
    var failed = false;
    while (!has() && c.hasOlder && pages < _findPages) {
      await c.loadOlder();
      pages++;
      if (!mounted || _conversation != c) return;
      if (c.error != null) {
        failed = true;
        break;
      }
    }
    if (!mounted) return;
    final found = has();
    setState(() {
      _finding = false;
      _note = found
          ? null
          : failed
          ? "Couldn't read the original message. Try again."
          : c.hasOlder
          ? 'The original message is too far back.'
          : 'The original message is no longer in this chat.';
      if (found) _target = messageId;
    });
    if (!found) return;
    _reveal(c, messageId, 0);
    _litTimer?.cancel();
    setState(() => _lit = messageId);
    _litTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _lit = null);
    });
  }

  /// The list builds only the rows near what is shown: it jumps near the
  /// target by its place in the list until its row is built, then brings it
  /// to the middle (the desktop's `_revealTarget`).
  void _reveal(SwarmConversation c, String messageId, int attempt) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _target != messageId) return;
      if (_targetKey.currentContext case final row?) {
        unawaited(
          Scrollable.ensureVisible(
            row,
            alignment: 0.5,
            duration: const Duration(milliseconds: 250),
          ),
        );
        return;
      }
      final shown = _shown;
      final index = shown.indexWhere(
        (entry) => entry is _MessageEntry && entry.message.id == messageId,
      );
      if (!_scroll.hasClients || index < 0 || attempt > 20) return;
      final position = _scroll.position;
      position.jumpTo(
        (position.maxScrollExtent * (index + 1) / shown.length).clamp(
          0,
          position.maxScrollExtent,
        ),
      );
      _reveal(c, messageId, attempt + 1);
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// What the list draws, newest first: kept for [_reveal] to find a row's
  /// place by.
  List<_Entry> _shown = const [];

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
            : ValueListenableBuilder(
                valueListenable: _view,
                builder: (context, view, _) =>
                    _page(context, session, c, view!, tty),
              ),
      ),
    );
  }

  /// The header and the composer follow [view]; the messages, and what is
  /// said under them, follow [c]; the composer follows what is typed.
  Widget _page(
    BuildContext context,
    SwarmSession session,
    SwarmConversation c,
    _ChatView view,
    Tty tty,
  ) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(0, 2, 8, 2),
        child: Row(
          children: [
            TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    view.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: tty.style(
                      size: TtySize.title,
                      weight: FontWeight.w600,
                    ),
                  ),
                  if (view.project case final project?)
                    Text(
                      project,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: _sans(13, color: AppPalette.textSecondary),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      Expanded(
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) => _messages(context, session, c, view, tty),
        ),
      ),
      ListenableBuilder(
        listenable: c,
        builder: (context, _) {
          final note = _finding ? 'Finding the original message…' : _note;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (note != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                  child: Text(
                    note,
                    key: const ValueKey('swarm-find-note'),
                    style: _sans(13.5, color: AppPalette.textSecondary),
                  ),
                ),
              // Unless the body says it already: no conversation and nothing
              // read.
              if (c.error case final error?
                  when view.known || c.messages.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                  child: Text(
                    error,
                    key: const ValueKey('swarm-post-error'),
                    style: _sans(13.5, color: tty.red),
                  ),
                ),
            ],
          );
        },
      ),
      if (view.canPost)
        ListenableBuilder(
          listenable: c.composer,
          builder: (context, _) => _composer(c, tty),
        )
      else if (view.known)
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            view.archived
                ? 'This chat is archived.'
                : 'You can read this chat, not post in it.',
            key: const ValueKey('swarm-read-only'),
            style: _sans(13.5, color: AppPalette.textSecondary),
          ),
        ),
    ],
  );

  /// [m]'s author as a quote names them: the person's own messages are
  /// "You".
  String _quoted(SwarmConversation c, SuperTabMessage m) =>
      !m.fromAgent && m.authorId == c.reader.accountId ? 'You' : _nameOf(c, m);

  String _nameOf(SwarmConversation c, SuperTabMessage m) =>
      c.reader.snapshot?.authorName(m) ?? m.authorName;

  /// The messages, newest at the foot, with the decisions asked among them.
  Widget _messages(
    BuildContext context,
    SwarmSession session,
    SwarmConversation c,
    _ChatView view,
    Tty tty,
  ) {
    final snapshot = c.reader.snapshot;
    final byId = {for (final m in c.messages) m.id: m};
    final pending = c.pending;
    final entries = _timeline(
      c.messages,
      view.decisions,
      hasOlder: c.hasOlder,
    ).reversed.toList();
    _shown = entries;
    // A page shorter than the screen never scrolls: look once it is drawn.
    if (c.hasOlder && !_loadingOlder && !_olderFailed) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _nearTop();
      });
    }
    final lead = pending == null ? 0 : 1;

    Widget message(_MessageEntry entry) {
      final m = entry.message;
      final reply = m.replyTo == null ? null : byId[m.replyTo];
      return _Message(
        key: m.id == _target ? _targetKey : null,
        message: m,
        name: _nameOf(c, m),
        role: m.fromAgent ? view.roles[m.authorId] : null,
        names: view.names,
        grouped: entry.grouped,
        lit: _lit == m.id,
        quote: m.replyTo == null
            ? null
            : _Quote(
                key: ValueKey('swarm-quote-${m.id}'),
                author: reply == null ? null : _quoted(c, reply),
                text: reply?.text,
                onTap: () => unawaited(_jumpTo(c, m.replyTo!)),
              ),
        actions: _acting == m.id,
        onTap: () => setState(() => _acting = _acting == m.id ? null : m.id),
        onReply: view.canPost ? () => _reply(c, m) : null,
      );
    }

    Widget entry(_Entry entry) => switch (entry) {
      _DayEntry(:final day) => Padding(
        padding: const EdgeInsets.fromLTRB(0, 14, 0, 8),
        child: Text(
          swarmDayLabel(day, DateTime.now()),
          textAlign: TextAlign.center,
          style: tty.style(color: AppPalette.textFaint, size: 12.5),
        ),
      ),
      final _MessageEntry m => message(m),
      _AskEntry(:final need, :final grouped) => _Ask(
        session: session,
        snapshot: snapshot,
        need: need,
        grouped: grouped,
      ),
    };

    if (!view.known && c.messages.isEmpty) {
      return Padding(
        padding: const EdgeInsets.all(Tty.origin),
        child: Text(
          c.error ?? 'This chat is not open to you.',
          style: _sans(15, color: AppPalette.textSecondary),
        ),
      );
    }
    return ListView.builder(
      key: const ValueKey('swarm-messages'),
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      itemCount: lead + entries.length + (c.hasOlder ? 1 : 0),
      itemBuilder: (context, index) {
        if (index < lead) {
          final reply = pending!.replyTo == null ? null : byId[pending.replyTo];
          final mine = c.messages.reversed
              .where((m) => !m.fromAgent && m.authorId == c.reader.accountId)
              .firstOrNull;
          return _Pending(
            name: mine == null ? 'You' : _nameOf(c, mine),
            text: pending.text,
            names: view.names,
            sending: c.sending,
            quote: pending.replyTo == null
                ? null
                : _Quote(
                    author: reply == null ? null : _quoted(c, reply),
                    text: reply?.text,
                  ),
            onSendAgain: () => unawaited(c.send()),
          );
        }
        if (index - lead < entries.length) {
          return entry(entries[index - lead]);
        }
        // Read on their own near the top; the link only once that read
        // failed.
        return Center(
          child: _olderFailed
              ? _Link(
                  key: const ValueKey('swarm-older-messages'),
                  label: 'Earlier messages',
                  onTap: () => unawaited(_loadOlder(c)),
                )
              : SizedBox(
                  key: const ValueKey('swarm-older-loading'),
                  height: 44,
                  child: Center(
                    child: Text(
                      'Loading earlier messages…',
                      style: _sans(13.5, color: AppPalette.textFaint),
                    ),
                  ),
                ),
        );
      },
    );
  }

  /// The @ picker while a name is typed, the reply bar while the draft
  /// answers a message, then @, a field that grows with what is typed and a
  /// round Send — no attach button.
  Widget _composer(SwarmConversation c, Tty tty) {
    final snapshot = c.reader.snapshot;
    final query = c.mentionQuery;
    final replying = c.replyingTo;
    // One post at a time: one not confirmed is sent again from where it shows.
    final canSend = c.pending == null && c.draft.trim().isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: Color.alphaBlend(tty.text.withValues(alpha: 0.02), tty.ground),
        border: Border(top: BorderSide(color: _hair(tty))),
      ),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (query != null && snapshot != null)
            _MentionPicker(
              agents: c.mentionable,
              snapshot: snapshot,
              query: query,
              onPick: (agent) {
                c.completeMention(agent.id);
                _focus.requestFocus();
              },
            ),
          if (replying != null)
            Padding(
              key: const ValueKey('swarm-reply-bar'),
              padding: const EdgeInsets.fromLTRB(2, 0, 0, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.only(left: 8),
                      decoration: BoxDecoration(
                        border: Border(
                          left: BorderSide(
                            color: AppPalette.textFaint,
                            width: 3,
                          ),
                        ),
                      ),
                      child: Text.rich(
                        TextSpan(
                          children: [
                            const TextSpan(text: 'Reply to '),
                            TextSpan(
                              text: _quoted(c, replying) == 'You'
                                  ? 'you'
                                  : _quoted(c, replying),
                              style: TextStyle(color: AppPalette.textPrimary),
                            ),
                            TextSpan(
                              text:
                                  ': ${replying.text.replaceAll(RegExp(r'\s+'), ' ')}',
                            ),
                          ],
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: _sans(13.5, color: AppPalette.textSecondary),
                      ),
                    ),
                  ),
                  _Round(
                    key: const ValueKey('swarm-reply-cancel'),
                    label: 'Cancel reply',
                    onTap: () => c.replyingTo = null,
                    child: Icon(
                      LucideIcons.x,
                      size: 18,
                      color: AppPalette.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (c.mentionable.isNotEmpty)
                _Round(
                  key: const ValueKey('swarm-mention'),
                  label: 'Mention an agent',
                  onTap: () => _mention(c),
                  child: Icon(
                    LucideIcons.atSign,
                    size: 22,
                    color: AppPalette.textSecondary,
                  ),
                ),
              const SizedBox(width: 6),
              Expanded(
                child: _MessageField(controller: _text, focus: _focus),
              ),
              const SizedBox(width: 6),
              _Round(
                key: const ValueKey('swarm-send'),
                label: 'Send',
                fill: canSend ? AppPalette.accent : ttyRaised(tty),
                onTap: canSend ? () => _send(c) : null,
                child: Icon(
                  LucideIcons.arrowUp,
                  size: 20,
                  color: canSend ? Colors.white : AppPalette.textFaint,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The chat's prose in the app's own face, as prototype v2 draws it: the
/// messages, quotes, names and the field. Times, roles and day dividers stay
/// in the terminal's.
TextStyle _sans(
  double size, {
  Color? color,
  FontWeight weight = FontWeight.w400,
  double height = 1.35,
}) => TextStyle(
  fontSize: size,
  height: height,
  color: color ?? AppPalette.textPrimary,
  fontWeight: weight,
);

/// The hairline around the chat's cards, picker and field.
Color _hair(Tty tty) => tty.text.withValues(alpha: 0.12);

/// The ground of a card in the chat: a decision, the picker, a file.
Color _card(Tty tty) =>
    Color.alphaBlend(tty.text.withValues(alpha: 0.05), tty.ground);

/// What the chat draws of its Swarm's read and of what is asked of the
/// person in it: its header, whether they can post, the names an @mention is
/// marked for, each agent's role and the decisions open in it. Made again at
/// each read and equal to the one before when nothing drawn changed, so a read
/// that moved nothing here draws nothing again.
@immutable
class _ChatView {
  const _ChatView({
    required this.known,
    required this.title,
    required this.project,
    required this.canPost,
    required this.archived,
    required this.names,
    required this.roles,
    required this.mentionable,
    required this.decisions,
  });

  /// [c] as its Swarm's read and asks have it now. The decisions of [before]
  /// are kept while each still draws the same.
  factory _ChatView.of(
    SwarmSession session,
    SwarmConversation c,
    _ChatView? before,
  ) {
    final reader = c.reader;
    final snapshot = reader.snapshot;
    final group = c.conversation;
    final agents = snapshot?.agents ?? const <SuperTabAgent>[];
    // A chat not open to the person shows none of its questions either, even
    // while the decisions read has not caught up.
    final decisions = [
      for (final need in session.inbox.needs)
        if (group != null &&
            need is SwarmDecisionNeed &&
            need.swarmId == reader.tabId &&
            need.conversationId == c.id)
          need,
    ];
    return _ChatView(
      known: group != null,
      title: group == null
          ? 'Chat'
          : swarmPmChat(reader, group.projectId)?.id == group.id
          ? 'Chat with PM'
          : group.label,
      project: snapshot?.projects
          .where((p) => p.id == group?.projectId)
          .firstOrNull
          ?.name,
      canPost: c.canPost,
      archived: group?.archived ?? false,
      names: [for (final agent in agents) snapshot!.agentName(agent.id)],
      roles: {
        for (final agent in agents)
          agent.id: ?swarmAgentRole(snapshot!, agent.id),
      },
      mentionable: [for (final agent in c.mentionable) agent.id],
      decisions: before != null && _sameAsks(before.decisions, decisions)
          ? before.decisions
          : List.unmodifiable(decisions),
    );
  }

  /// The conversation is in the Swarm's read.
  final bool known;
  final String title;
  final String? project;
  final bool canPost, archived;

  /// The Swarm's agents by name, for the @mentions marked in messages.
  final List<String> names;

  /// Each agent's compact role, by agent id: PM, Dev or Rev.
  final Map<String, String> roles;

  /// The agents a post can mention, by id.
  final List<String> mentionable;
  final List<SwarmDecisionNeed> decisions;

  /// Whether [a] and [b] draw the same decisions, in the same order.
  static bool _sameAsks(List<SwarmDecisionNeed> a, List<SwarmDecisionNeed> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      final x = a[i].decision, y = b[i].decision;
      if (a[i].key != b[i].key ||
          x.askerName != y.askerName ||
          x.question != y.question ||
          x.unblocks != y.unblocks ||
          x.recommended != y.recommended ||
          x.createdAt != y.createdAt ||
          !listEquals(x.options, y.options)) {
        return false;
      }
    }
    return true;
  }

  @override
  bool operator ==(Object other) =>
      other is _ChatView &&
      other.known == known &&
      other.title == title &&
      other.project == project &&
      other.canPost == canPost &&
      other.archived == archived &&
      listEquals(other.names, names) &&
      mapEquals(other.roles, roles) &&
      listEquals(other.mentionable, mentionable) &&
      identical(other.decisions, decisions);

  @override
  int get hashCode => Object.hash(
    known,
    title,
    project,
    canPost,
    archived,
    Object.hashAll(names),
    Object.hashAll(mentionable),
    decisions,
  );
}

/// One row of the chat.
sealed class _Entry {}

/// Where a day starts.
final class _DayEntry extends _Entry {
  _DayEntry(this.day);
  final DateTime day;
}

final class _MessageEntry extends _Entry {
  _MessageEntry(this.message, {required this.grouped});
  final SuperTabMessage message;

  /// Drawn under the one before, with no avatar, name or time.
  final bool grouped;
}

/// A decision asked of the person, in its place among the messages.
final class _AskEntry extends _Entry {
  _AskEntry(this.need, {this.grouped = false});
  final SwarmDecisionNeed need;

  /// Drawn under its asker's message just before it, as part of it.
  final bool grouped;
}

/// [messages] (oldest first) with the [asks] put where they were asked and a
/// divider where each day starts. An ask from before the messages read so far
/// — while there are [hasOlder] ones — goes at the foot instead, so a question
/// still open is never out of sight behind "Earlier messages".
List<_Entry> _timeline(
  List<SuperTabMessage> messages,
  List<SwarmDecisionNeed> asks, {
  required bool hasOlder,
}) {
  final grouped = swarmGroupedMessages(messages);
  final oldest = messages.map((m) => m.createdAt).nonNulls.firstOrNull;
  bool before(DateTime? asked, DateTime? at) =>
      asked != null && at != null && asked.isBefore(at);
  final waiting = <SwarmDecisionNeed>[], late = <SwarmDecisionNeed>[];
  for (final ask in asks) {
    (hasOlder && before(ask.decision.createdAt, oldest) ? late : waiting).add(
      ask,
    );
  }
  waiting.sort((a, b) {
    final x = a.decision.createdAt, y = b.decision.createdAt;
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return x.compareTo(y);
  });

  final rows = <(_Entry, DateTime?)>[];
  // An ask right after its asker's own message — "One question before the
  // release:" — is drawn as part of it.
  void ask(SwarmDecisionNeed need) {
    final asked = need.decision.createdAt;
    final last = rows.lastOrNull?.$1;
    final at = last is _MessageEntry ? last.message.createdAt : null;
    final grouped =
        last is _MessageEntry &&
        last.message.fromAgent &&
        last.message.authorName == need.decision.askerName &&
        asked != null &&
        at != null &&
        !asked.isBefore(at) &&
        asked.difference(at) <= const Duration(minutes: 5);
    rows.add((_AskEntry(need, grouped: grouped), asked));
  }

  var next = 0;
  for (final m in messages) {
    while (next < waiting.length &&
        before(waiting[next].decision.createdAt, m.createdAt)) {
      ask(waiting[next]);
      next++;
    }
    // Grouped only right under a message: not under a question.
    final under = rows.isNotEmpty && rows.last.$1 is _MessageEntry;
    rows.add((
      _MessageEntry(m, grouped: under && grouped.contains(m.id)),
      m.createdAt,
    ));
  }
  waiting.skip(next).forEach(ask);
  for (final need in late) {
    rows.add((_AskEntry(need), need.decision.createdAt));
  }

  final timeline = <_Entry>[];
  DateTime? day;
  for (final (row, at) in rows) {
    if (at != null) {
      final local = DateUtils.dateOnly(at.toLocal());
      if (local != day) {
        day = local;
        timeline.add(_DayEntry(local));
      }
    }
    timeline.add(row);
  }
  return timeline;
}

const _weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// A day divider's words for [day] (local): Today, Yesterday, the weekday
/// within the week, else the date — with its year when it is not this one.
String swarmDayLabel(DateTime day, DateTime now) {
  final date = DateUtils.dateOnly(day), today = DateUtils.dateOnly(now);
  // In hours, rounded: a day across a clock change is 23 or 25 of them.
  final days = (today.difference(date).inHours / 24).round();
  if (days == 0) return 'Today';
  if (days == 1) return 'Yesterday';
  if (days > 1 && days < 7) return _weekdays[date.weekday - 1];
  final short = '${date.day} ${_months[date.month - 1]}';
  return date.year == today.year ? short : '$short ${date.year}';
}

/// The ids of [messages] (oldest first) drawn as follow-ups under the one
/// before: the same author within five minutes on the same day, short, with
/// no question, line break or reply, and at most three to a run — the
/// desktop's `SuperTabMessageRow.groupsWith`.
Set<String> swarmGroupedMessages(List<SuperTabMessage> messages) {
  bool joins(SuperTabMessage current, SuperTabMessage previous) {
    bool plain(SuperTabMessage m) =>
        m.replyTo == null &&
        m.text.length <= 280 &&
        !m.text.contains('\n') &&
        !m.text.contains('?') &&
        !m.text.contains('？');
    if (!plain(current) ||
        !plain(previous) ||
        current.authorId.isEmpty ||
        current.authorId != previous.authorId ||
        current.authorName != previous.authorName ||
        current.author['kind'] != previous.author['kind'] ||
        current.author['membershipGeneration'] !=
            previous.author['membershipGeneration']) {
      return false;
    }
    final now = current.createdAt, before = previous.createdAt;
    if (now == null || before == null) return false;
    final elapsed = now.difference(before);
    return !elapsed.isNegative &&
        elapsed <= const Duration(minutes: 5) &&
        DateUtils.isSameDay(now.toLocal(), before.toLocal());
  }

  final joined = <String>{};
  var first = 0;
  for (var i = 1; i < messages.length; i++) {
    if (i - first < 3 &&
        joins(messages[i], messages[i - 1]) &&
        joins(messages[i], messages[first])) {
      joined.add(messages[i].id);
    } else {
      first = i;
    }
  }
  return joined;
}

/// An agent's role as its compact badge says it (the Naming System): PM for
/// a project's Product Manager, Rev for a reviewer, Dev for an engineer;
/// none for a person, or an agent no longer in the Swarm.
String? swarmRole(SuperTabSnapshot snapshot, SuperTabMessage message) {
  if (!message.fromAgent) return null;
  return swarmAgentRole(snapshot, message.authorId);
}

String? swarmAgentRole(SuperTabSnapshot snapshot, String agentId) {
  if (snapshot.isLead(agentId)) return 'PM';
  final agent = snapshot.agent(agentId);
  if (agent == null) return null;
  return agent.isReviewer ? 'Rev' : 'Dev';
}

/// The agent asking [need], found by the name it asked under: a decision
/// names its asker, not their id.
SuperTabAgent? swarmAsker(SuperTabSnapshot snapshot, SwarmDecisionNeed need) =>
    snapshot.agents
        .where((a) => snapshot.agentName(a.id) == need.decision.askerName)
        .firstOrNull;

/// [text] with each @mention of one of [names] marked, as the desktop and
/// the prototype mark them.
TextSpan _mentions(String text, List<String> names, TextStyle style) {
  if (names.isEmpty || !text.contains('@')) {
    return TextSpan(text: text, style: style);
  }
  // Longest first, so "@Nova2" is not read as "@Nova".
  final sorted = [...names]..sort((a, b) => b.length.compareTo(a.length));
  final pattern = RegExp(
    '(?<![\\w@])@(?:${sorted.map(RegExp.escape).join('|')})(?![\\w])',
    caseSensitive: false,
  );
  final spans = <InlineSpan>[];
  var at = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > at) {
      spans.add(TextSpan(text: text.substring(at, match.start)));
    }
    spans.add(
      TextSpan(
        text: match[0],
        style: TextStyle(
          color: AppPalette.accentOnSurface,
          backgroundColor: AppPalette.accentOnSurface.withValues(alpha: 0.13),
          fontWeight: FontWeight.w500,
        ),
      ),
    );
    at = match.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return TextSpan(style: style, children: spans);
}

/// A message's frame: avatar, then who wrote it, their role and [trailing]
/// (its time) — none of it for a follow-up — then [body].
class _Row extends StatelessWidget {
  const _Row({
    required this.avatar,
    required this.grouped,
    required this.header,
    required this.body,
  });

  final Widget avatar;
  final bool grouped;
  final Widget header;
  final List<Widget> body;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      grouped ? const SizedBox(width: _Avatar.size) : avatar,
      const SizedBox(width: 10),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [if (!grouped) header, ...body],
        ),
      ),
    ],
  );
}

/// One message: avatar, who wrote it, their role and when — none of it for a
/// follow-up — then what it answers, its text and its files. A tap opens
/// its actions; lit for a moment when a quote leads to it.
class _Message extends StatelessWidget {
  const _Message({
    super.key,
    required this.message,
    required this.name,
    required this.role,
    required this.names,
    required this.grouped,
    required this.lit,
    required this.quote,
    required this.actions,
    required this.onTap,
    required this.onReply,
  });

  final SuperTabMessage message;
  final String name;
  final String? role;

  /// The names an @mention in it is marked for.
  final List<String> names;
  final bool grouped, lit, actions;
  final Widget? quote;
  final VoidCallback onTap;

  /// Null where the person cannot post.
  final VoidCallback? onReply;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final at = message.createdAt?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return AnimatedContainer(
      key: ValueKey('swarm-message-${message.id}'),
      duration: const Duration(milliseconds: 600),
      curve: Curves.easeOut,
      padding: EdgeInsets.fromLTRB(6, grouped ? 0 : 7, 6, 7),
      decoration: BoxDecoration(
        color: lit
            ? AppPalette.accentOnSurface.withValues(alpha: 0.16)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
      ),
      child: _Row(
        grouped: grouped,
        avatar: _Avatar(
          name: name,
          id: message.authorId,
          agent: message.fromAgent,
          pm: role == 'PM',
        ),
        header: _Header(
          name: name,
          agent: message.fromAgent,
          role: role,
          trailing: at == null
              ? null
              : Text(
                  '${two(at.hour)}:${two(at.minute)}',
                  style: tty.style(color: AppPalette.textFaint, size: 12.5),
                ),
        ),
        body: [
          if (lit) SizedBox(key: ValueKey('swarm-lit-${message.id}')),
          ?quote,
          if (message.text.isNotEmpty)
            Semantics(
              button: true,
              hint: 'Reply to this message',
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: onTap,
                child: Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: SizedBox(
                    width: double.infinity,
                    child: Text.rich(
                      _mentions(message.text, names, _sans(16, height: 1.42)),
                    ),
                  ),
                ),
              ),
            ),
          for (final file in message.attachments)
            _File(file: file, link: swarmAttachmentLink(file.url)),
          if (actions)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  if (onReply case final reply?)
                    _SmallButton(
                      key: ValueKey('swarm-reply-${message.id}'),
                      icon: LucideIcons.reply,
                      label: 'Reply',
                      onTap: reply,
                    ),
                  _SmallButton(
                    icon: LucideIcons.copy,
                    label: 'Copy',
                    onTap: () => unawaited(
                      Clipboard.setData(ClipboardData(text: message.text)),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// A message's first line: who, in what role, then [trailing] — its time,
/// or how its post is going.
class _Header extends StatelessWidget {
  const _Header({
    required this.name,
    required this.agent,
    this.role,
    this.trailing,
  });

  final String name;
  final bool agent;
  final String? role;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Wrap(
      spacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          name,
          style: _sans(
            13.5,
            color: agent ? tty.cyan : tty.green,
            weight: FontWeight.w600,
          ),
        ),
        if (role case final role?) _Role(role),
        ?trailing,
      ],
    );
  }
}

/// A role's compact badge: PM, Dev, Rev.
class _Role extends StatelessWidget {
  const _Role(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        border: Border.all(color: _hair(tty)),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: tty
            .style(
              color: AppPalette.textSecondary,
              weight: FontWeight.w600,
              size: 11,
            )
            .copyWith(height: 16 / 11, letterSpacing: 0.44),
      ),
    );
  }
}

/// Who wrote a message, in a circle: an agent's initial on its own deep
/// colour — blue for a Product Manager, as the prototype has River — the
/// person's on theirs, white on each.
class _Avatar extends StatelessWidget {
  const _Avatar({
    required this.name,
    required this.id,
    required this.agent,
    this.pm = false,
  });

  static const double size = 32;

  /// Deep enough under a white initial in either theme.
  static const _agents = [
    Color(0xFF1D5BD6),
    Color(0xFF0F766E),
    Color(0xFF6D28D9),
    Color(0xFFA65A08),
    Color(0xFFBE123C),
    Color(0xFF15803D),
    Color(0xFF4E5D78),
  ];
  static const _person = Color(0xFF4B5F9B);

  final String name, id;
  final bool agent;

  /// A project's Product Manager: the prototype's blue, kept for them alone.
  final bool pm;

  @override
  Widget build(BuildContext context) {
    final fill = !agent
        ? _person
        : pm
        ? _agents.first
        : _agents[1 +
              id.codeUnits.fold(0, (a, b) => a + b) % (_agents.length - 1)];
    final initial = name.trim().isEmpty
        ? '?'
        : name.trim().characters.first.toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
      child: Text(
        initial,
        style: _sans(13.5, color: Colors.white, weight: FontWeight.w600),
      ),
    );
  }
}

/// What a reply answers: its author and the start of its text, or that it
/// is not loaded. A tap leads to it.
class _Quote extends StatelessWidget {
  const _Quote({super.key, this.author, this.text, this.onTap});

  /// Null while the original is not loaded.
  final String? author, text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final quote = Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 5, bottom: 3),
      padding: const EdgeInsets.fromLTRB(10, 7, 10, 8),
      decoration: BoxDecoration(
        color: tty.text.withValues(alpha: 0.05),
        border: Border(left: BorderSide(color: AppPalette.textFaint, width: 3)),
        borderRadius: const BorderRadius.horizontal(
          left: Radius.circular(4),
          right: Radius.circular(10),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (author case final author?)
            Text(
              author,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: _sans(13.5, weight: FontWeight.w600),
            ),
          Text(
            text ?? "The original message isn't loaded.",
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: _sans(14, color: AppPalette.textSecondary),
          ),
        ],
      ),
    );
    if (onTap == null) return quote;
    return Semantics(
      button: true,
      label: 'Go to the quoted message',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: quote,
      ),
    );
  }
}

/// The person's post on its way: "Sending…", then — its answer lost — "Not
/// confirmed" with Send again, until it is read back.
class _Pending extends StatelessWidget {
  const _Pending({
    required this.name,
    required this.text,
    required this.names,
    required this.sending,
    required this.quote,
    required this.onSendAgain,
  });

  final String name, text;
  final List<String> names;
  final bool sending;
  final Widget? quote;
  final VoidCallback onSendAgain;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Padding(
      key: const ValueKey('swarm-pending'),
      padding: const EdgeInsets.fromLTRB(6, 7, 6, 7),
      child: _Row(
        grouped: false,
        avatar: _Avatar(name: name, id: '', agent: false),
        header: _Header(
          name: name,
          agent: false,
          trailing: Text(
            sending ? 'Sending…' : 'Not confirmed',
            style: tty.style(
              color: sending ? AppPalette.textFaint : tty.yellow,
              size: 12.5,
            ),
          ),
        ),
        body: [
          ?quote,
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text.rich(
              _mentions(
                text,
                names,
                _sans(
                  16,
                  height: 1.42,
                  color: sending
                      ? AppPalette.textSecondary
                      : AppPalette.textPrimary,
                ),
              ),
            ),
          ),
          if (!sending)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: _SmallButton(
                key: const ValueKey('swarm-resend-post'),
                icon: LucideIcons.rotateCw,
                label: 'Send again',
                onTap: onSendAgain,
              ),
            ),
        ],
      ),
    );
  }
}

/// A decision asked of the person, among the messages: from its asker, a card
/// with the question and its options side by side.
class _Ask extends StatelessWidget {
  const _Ask({
    required this.session,
    required this.snapshot,
    required this.need,
    required this.grouped,
  });

  final SwarmSession session;
  final SuperTabSnapshot? snapshot;
  final SwarmDecisionNeed need;
  final bool grouped;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final decision = need.decision;
    final snapshot = this.snapshot;
    final asker = snapshot == null ? null : swarmAsker(snapshot, need);
    final role = asker == null ? null : swarmAgentRole(snapshot!, asker.id);
    final at = decision.createdAt?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return Padding(
      key: ValueKey('swarm-ask-${decision.id}'),
      padding: EdgeInsets.fromLTRB(6, grouped ? 0 : 7, 6, 7),
      child: _Row(
        grouped: grouped,
        avatar: _Avatar(
          name: decision.askerName,
          id: asker?.id ?? decision.askerName,
          agent: true,
          pm: role == 'PM',
        ),
        header: _Header(
          name: decision.askerName,
          agent: true,
          role: role,
          trailing: at == null
              ? null
              : Text(
                  '${two(at.hour)}:${two(at.minute)}',
                  style: tty.style(color: AppPalette.textFaint, size: 12.5),
                ),
        ),
        body: [
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
            decoration: BoxDecoration(
              color: _card(tty),
              border: Border.all(color: _hair(tty)),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(decision.question, style: _sans(16, height: 1.4)),
                if (decision.unblocks.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    'Unblocks: ${decision.unblocks}',
                    style: _sans(13.5, color: AppPalette.textSecondary),
                  ),
                ],
                const SizedBox(height: 14),
                // Its answer held, sending or dropped: told by the session
                // and the Swarm's asks, not by the chat around it.
                ListenableBuilder(
                  listenable: Listenable.merge([
                    session,
                    ?session.inbox.asks(need.swarmId),
                  ]),
                  builder: (context, _) => SwarmDecisionAnswer(
                    session: session,
                    need: need,
                    fillRecommended: true,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The chat's agents whose name starts with what follows the @ being typed,
/// over the composer: each with its role and what it is doing.
class _MentionPicker extends StatelessWidget {
  const _MentionPicker({
    required this.agents,
    required this.snapshot,
    required this.query,
    required this.onPick,
  });

  final List<SuperTabAgent> agents;
  final SuperTabSnapshot snapshot;
  final String query;
  final ValueChanged<SuperTabAgent> onPick;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final glances = {
      for (final glance in swarmTeamGlance(snapshot).agents)
        glance.agent.id: glance,
    };
    final prefix = query.toLowerCase();
    final shown = [
      for (final agent in agents)
        if (snapshot.agentName(agent.id).toLowerCase().startsWith(prefix))
          agent,
    ];
    return Container(
      key: const ValueKey('swarm-mention-picker'),
      margin: const EdgeInsets.only(bottom: 8),
      constraints: const BoxConstraints(maxHeight: 220),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: _card(tty),
        border: Border.all(color: _hair(tty)),
        borderRadius: BorderRadius.circular(14),
        boxShadow: const [
          BoxShadow(
            color: Color(0x80000000),
            blurRadius: 30,
            offset: Offset(0, 10),
          ),
        ],
      ),
      child: shown.isEmpty
          ? Padding(
              padding: const EdgeInsets.all(14),
              child: Text(
                'No agent by that name.',
                style: _sans(14, color: AppPalette.textSecondary),
              ),
            )
          : ListView(
              shrinkWrap: true,
              padding: EdgeInsets.zero,
              children: [
                for (final agent in shown)
                  TtyTap(
                    key: ValueKey('swarm-pick-${agent.id}'),
                    semanticsLabel: snapshot.agentName(agent.id),
                    minHeight: 52,
                    onTap: () => onPick(agent),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      child: Row(
                        children: [
                          _Avatar(
                            name: snapshot.agentName(agent.id),
                            id: agent.id,
                            agent: true,
                            pm: snapshot.isLead(agent.id),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    snapshot.agentName(agent.id),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: _sans(16, weight: FontWeight.w500),
                                  ),
                                ),
                                if (swarmAgentRole(snapshot, agent.id)
                                    case final role?) ...[
                                  const SizedBox(width: 6),
                                  _Role(role),
                                ],
                              ],
                            ),
                          ),
                          if (glances[agent.id] case final glance?) ...[
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: _stateColor(tty, glance.state),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              glance.label,
                              style: _sans(13, color: AppPalette.textSecondary),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
              ],
            ),
    );
  }
}

/// The dot beside what an agent is doing: green working, yellow waiting or
/// stuck, red down or limited, faint idle.
Color _stateColor(Tty tty, SwarmAgentState state) => switch (state) {
  SwarmAgentState.working => tty.green,
  SwarmAgentState.waiting || SwarmAgentState.stuck => tty.yellow,
  SwarmAgentState.down || SwarmAgentState.limited => tty.red,
  _ => AppPalette.textFaint,
};

/// The composer's field: one rounded line that grows with what is typed, up
/// to five, in the app's own face.
class _MessageField extends StatelessWidget {
  const _MessageField({required this.controller, required this.focus});

  final TextEditingController controller;
  final FocusNode focus;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return GestureDetector(
      // A tap anywhere in the pill — not only on the text — takes the keyboard.
      behavior: HitTestBehavior.opaque,
      onTap: focus.requestFocus,
      child: Container(
        key: const ValueKey('swarm-field'),
        constraints: const BoxConstraints(minHeight: 44),
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: ttyRaised(tty),
          border: Border.all(color: _hair(tty)),
          borderRadius: BorderRadius.circular(22),
        ),
        child: TextSelectionTheme(
          data: TextSelectionThemeData(
            cursorColor: AppPalette.accentOnSurface,
            selectionColor: AppPalette.accentOnSurface.withValues(alpha: 0.3),
            selectionHandleColor: AppPalette.accentOnSurface,
          ),
          child: TextField(
            controller: controller,
            focusNode: focus,
            minLines: 1,
            maxLines: 5,
            keyboardType: TextInputType.multiline,
            textInputAction: TextInputAction.newline,
            textCapitalization: TextCapitalization.sentences,
            // The keyboard's own composing, left on: Vietnamese Telex on iOS
            // rides on autocorrection. See `ComposingKeyboard`.
            autocorrect: ComposingKeyboard.autocorrect,
            enableSuggestions: ComposingKeyboard.enableSuggestions,
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            cursorColor: AppPalette.accentOnSurface,
            cursorWidth: 2,
            style: _sans(16, height: 22 / 16),
            decoration: InputDecoration(
              isCollapsed: true,
              // No minimum of its own: the pill's 44 is the field's height.
              constraints: const BoxConstraints(),
              filled: false,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              disabledBorder: InputBorder.none,
              contentPadding: EdgeInsets.zero,
              hintText: 'Message',
              hintStyle: _sans(
                16,
                height: 22 / 16,
                color: AppPalette.textFaint,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A round 44pt button: @, Send, the reply bar's ✕. [fill] draws it solid.
class _Round extends StatelessWidget {
  const _Round({
    super.key,
    required this.label,
    required this.onTap,
    required this.child,
    this.fill,
  });

  final String label;
  final VoidCallback? onTap;
  final Widget child;
  final Color? fill;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: onTap != null,
    label: label,
    excludeSemantics: true,
    child: GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
        child: child,
      ),
    ),
  );
}

/// A message's action — Reply, Copy, Send again: small, rounded, raised.
class _SmallButton extends StatelessWidget {
  const _SmallButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: ttyRaised(tty),
            border: Border.all(color: _hair(tty)),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: AppPalette.textPrimary),
              const SizedBox(width: 8),
              Text(label, style: _sans(14, weight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A link in the accent: Earlier messages.
class _Link extends StatelessWidget {
  const _Link({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TtyTap(
    semanticsLabel: label,
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Text(label, style: _sans(15, color: AppPalette.accentOnSurface)),
    ),
  );
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
    final size = kb < 1024 ? '$kb KB' : '${(kb / 1024).toStringAsFixed(1)} MB';
    final url = link;
    final color = url == null ? AppPalette.textFaint : tty.blue;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Semantics(
        button: url != null,
        label: 'File: ${file.name}, $size',
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: url == null
              ? null
              : () => unawaited(
                  launchUrl(url, mode: LaunchMode.inAppBrowserView),
                ),
          child: Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: _card(tty),
              border: Border.all(color: _hair(tty)),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(LucideIcons.file, size: 16, color: color),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    file.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: _sans(14, color: color),
                  ),
                ),
                const SizedBox(width: 8),
                Text(size, style: _sans(13, color: AppPalette.textFaint)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
