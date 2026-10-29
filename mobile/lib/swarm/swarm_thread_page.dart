import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'model.dart';
import 'swarm_attach.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart';
import 'swarm_message_row.dart';
import 'swarm_session.dart';
import 'swarm_thread.dart';

/// Draws one of a thread's messages as its chat draws them; a tap on it
/// opens or closes its actions ([acting]).
typedef SwarmThreadRow = Widget Function(
  SwarmThread thread,
  SuperTabMessage message, {
  required bool grouped,
  required bool acting,
  required VoidCallback onTap,
});

/// Draws the person's reply on its way: "Sending…", then "Not sent · Retry"
typedef SwarmThreadPending = Widget Function(SwarmThread thread, String text);

/// One thread of a chat, full screen as Slack Mobile opens one: its root at
/// the top, "N replies", its replies, and a reply box at the foot with Also
/// send and the chat's + for files (the desktop's thread panel, Tony's
/// mockup of 10-29).
///
/// Its rows are drawn by the chat that opened it ([row], [pending]), so a
/// message looks the same in both. While it is up its Swarm is watched, so
/// replies arrive as they do in the chat.
class SwarmThreadPage extends StatefulWidget {
  const SwarmThreadPage({
    super.key,
    required this.swarmId,
    required this.chat,
    required this.root,
    required this.title,
    required this.row,
    required this.pending,
  });

  final String swarmId;
  final SwarmConversation chat;

  /// The id of the message the thread hangs from.
  final String root;

  /// The chat's name, under "Thread".
  final String? title;
  final SwarmThreadRow row;
  final SwarmThreadPending pending;

  @override
  State<SwarmThreadPage> createState() => _SwarmThreadPageState();
}

class _SwarmThreadPageState extends State<SwarmThreadPage> {
  late final SwarmThread _thread = SwarmThread(widget.chat, widget.root);
  late final _text = TextEditingController(text: _thread.draft);
  final _focus = FocusNode(debugLabel: 'Swarm thread reply');
  final _scroll = ScrollController();

  /// The message whose actions are open (Copy), by a tap on it.
  String? _acting;

  /// What the last pick left out, or why it could not pick, under the box.
  final _attachNote = ValueNotifier<String?>(null);
  bool _picking = false;

  SwarmSession? _session;
  bool _watching = false;

  @override
  void initState() {
    super.initState();
    _text.addListener(_typed);
    _thread.composer.addListener(_drafted);
    unawaited(_thread.load());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    // Off while a screen pushed over this one covers it.
    final watch = session != null && TickerMode.valuesOf(context).enabled;
    if (session != _session || watch != _watching) {
      if (_watching) _session?.unwatch(widget.swarmId);
      _session = session;
      _watching = watch;
      if (watch) session.watch(widget.swarmId);
    }
  }

  @override
  void dispose() {
    if (_watching) _session?.unwatch(widget.swarmId);
    _thread.composer.removeListener(_drafted);
    _thread.dispose();
    _attachNote.dispose();
    _text.dispose();
    _focus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// What the person typed, into the draft.
  void _typed() {
    if (_thread.draft != _text.text) _thread.draft = _text.text;
  }

  /// The draft changed under the field — a reply sent, or refused and put
  /// back.
  void _drafted() {
    final draft = _thread.draft;
    if (draft == _text.text) return;
    _text.value = TextEditingValue(
      text: draft,
      selection: TextSelection.collapsed(offset: draft.length),
    );
  }

  /// The box's + ([attachSwarmFiles]), its files into the thread's.
  Future<void> _pickFiles() async {
    if (_picking) return;
    _picking = true;
    try {
      await attachSwarmFiles(
        context,
        _thread.files,
        // Nothing goes into a thread the person can no longer reply in.
        stillWanted: () =>
            mounted && _thread.state != SwarmChatState.lost && _thread.canPost,
        note: (note) => _attachNote.value = note,
      );
    } finally {
      _picking = false;
    }
  }

  /// Sends the reply, at the foot of the thread where it shows. Once the
  /// backend took it the keyboard goes down, unless the next is being typed.
  Future<void> _send() async {
    _attachNote.value = null;
    if (_scroll.hasClients) {
      unawaited(
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        ),
      );
    }
    final sent = await _thread.send();
    if (sent && mounted && _thread.draft.isEmpty) _focus.unfocus();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    return Scaffold(
      backgroundColor: tty.ground,
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(context, tty),
            Expanded(
              child: ListenableBuilder(
                listenable: _thread,
                builder: (context, _) => _body(tty),
              ),
            ),
            ListenableBuilder(
              listenable: Listenable.merge([_thread, _thread.composer]),
              builder: (context, _) => _foot(tty),
            ),
          ],
        ),
      ),
    );
  }

  Widget _header(BuildContext context, Tty tty) => Padding(
    key: const ValueKey('swarm-thread-header'),
    padding: const EdgeInsets.fromLTRB(0, AppSpace.xs, AppSpace.s, AppSpace.xs),
    child: Row(
      children: [
        TtyBackButton(onPressed: () => Navigator.of(context).maybePop()),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Semantics(
                header: true,
                child: Text(
                  'Thread',
                  key: const ValueKey('swarm-title'),
                  style: tty.style(
                    size: TtySize.title,
                    weight: FontWeight.w600,
                  ),
                ),
              ),
              // Not named once the chat is no longer open to the person.
              ListenableBuilder(
                listenable: _thread,
                builder: (context, _) => switch (widget.title) {
                  final title? when _thread.state != SwarmChatState.lost =>
                    Text(
                      title,
                      key: const ValueKey('swarm-thread-chat-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: swarmChatText(13, color: AppPalette.textSecondary),
                    ),
                  _ => const SizedBox.shrink(),
                },
              ),
            ],
          ),
        ),
      ],
    ),
  );

  /// Until the thread is read, skeleton bubbles; what it could not read, with
  /// Try again; "not open" once the backend refused the chat; then the root,
  /// "N replies", the replies and a reply on its way.
  Widget _body(Tty tty) {
    final t = _thread;
    if (t.state == SwarmChatState.lost) {
      return _said('This chat is not open to you.');
    }
    final messages = t.messages;
    final root = t.rootMessage;
    if (t.state != SwarmChatState.loaded && root == null) {
      if (t.readError case final error?) {
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _said(error, key: const ValueKey('swarm-thread-error')),
            _Link(
              key: const ValueKey('swarm-thread-retry'),
              label: 'Try again',
              onTap: () => unawaited(t.load()),
            ),
          ],
        );
      }
      return const SwarmChatSkeleton();
    }
    if (messages.isEmpty) {
      return _said('The original message is no longer in this chat.');
    }
    final replies = t.replies;
    final count = t.count;
    final pending = t.pending;
    Widget row(SuperTabMessage m, {required bool grouped}) => widget.row(
      t,
      m,
      grouped: grouped,
      acting: _acting == m.id,
      onTap: () => setState(() => _acting = _acting == m.id ? null : m.id),
    );
    return ListView(
      key: const ValueKey('swarm-thread-messages'),
      controller: _scroll,
      // The chat's own inset, so a message sits where it does there.
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.s,
      ),
      children: [
        if (root != null) row(root, grouped: false),
        if (count > 0)
          Padding(
            key: const ValueKey('swarm-thread-divider'),
            // In line with the avatars.
            padding: const EdgeInsets.all(AppSpace.s),
            child: Row(
              children: [
                Text(
                  count == 1 ? '1 reply' : '$count replies',
                  style: swarmChatText(13, color: AppPalette.textSecondary),
                ),
                const SizedBox(width: AppSpace.s),
                Expanded(child: Divider(height: 1, color: swarmChatHair(tty))),
              ],
            ),
          ),
        // What the chat has of it shows, and the rest is read again on a tap.
        if (t.readError case final error?) ...[
          _said(error, key: const ValueKey('swarm-thread-error')),
          Align(
            alignment: Alignment.centerLeft,
            child: _Link(
              key: const ValueKey('swarm-thread-retry'),
              label: 'Try again',
              onTap: () => unawaited(t.load()),
            ),
          ),
        ],
        if (t.hasEarlier)
          Align(
            alignment: Alignment.centerLeft,
            child: t.readingEarlier
                ? Padding(
                    key: const ValueKey('swarm-thread-earlier-loading'),
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpace.s,
                      vertical: AppSpace.m,
                    ),
                    child: Text(
                      'Loading earlier replies…',
                      style: swarmChatText(15, color: AppPalette.textSecondary),
                    ),
                  )
                : _Link(
                    key: const ValueKey('swarm-thread-earlier'),
                    label: 'Show earlier replies',
                    onTap: () => unawaited(t.loadEarlier()),
                  ),
          ),
        for (final (index, reply) in replies.indexed)
          row(
            reply,
            grouped:
                index > 0 &&
                replies[index - 1].authorId == reply.authorId &&
                replies[index - 1].fromAgent == reply.fromAgent,
          ),
        if (pending != null) widget.pending(t, pending),
      ],
    );
  }

  /// What could not be done, then the reply box — or why there is none.
  Widget _foot(Tty tty) {
    final t = _thread;
    if (t.state == SwarmChatState.lost) return const SizedBox.shrink();
    final group = t.chat.conversation;
    final error = t.error;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The first read's failure is said in the body, with Try again.
        if (error != null &&
            error != t.readError &&
            (t.rootMessage != null || t.pending != null))
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.screenInset,
              AppSpace.s,
              AppSpace.screenInset,
              0,
            ),
            child: Text(
              error,
              key: const ValueKey('swarm-thread-post-error'),
              style: swarmChatText(13.5, color: tty.red),
            ),
          ),
        if (t.canPost)
          _box(t, tty)
        else if (group != null)
          Padding(
            padding: const EdgeInsets.all(AppSpace.l),
            child: Text(
              group.archived
                  ? 'This chat is archived.'
                  : 'You can read this chat, not post in it.',
              key: const ValueKey('swarm-thread-read-only'),
              style: swarmChatText(13.5, color: AppPalette.textSecondary),
            ),
          ),
      ],
    );
  }

  /// The reply box: the files going with the reply, a field that grows with
  /// what is typed, then Also send, the + and a round Send (the desktop's
  /// thread composer).
  Widget _box(SwarmThread t, Tty tty) {
    final canSend = t.canSend;
    // A reply not confirmed is sent again from where it shows.
    final writable = !t.sending && t.pending == null;
    final canAttach = !t.uploading && t.files.room > 0;
    return Container(
      key: const ValueKey('swarm-thread-box'),
      decoration: BoxDecoration(
        color: Color.alphaBlend(tty.text.withValues(alpha: 0.02), tty.ground),
        border: Border(top: BorderSide(color: swarmChatHair(tty))),
      ),
      padding: const EdgeInsets.fromLTRB(
        AppSpace.m,
        AppSpace.s,
        AppSpace.m,
        AppSpace.xs,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ValueListenableBuilder(
            valueListenable: _attachNote,
            builder: (context, note, _) => note == null
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.fromLTRB(
                      AppSpace.xs,
                      0,
                      AppSpace.xs,
                      AppSpace.s,
                    ),
                    child: Text(
                      note,
                      key: const ValueKey('swarm-thread-attach-note'),
                      style: AppType.caption(color: tty.yellow),
                    ),
                  ),
          ),
          SwarmOutgoingChips(box: t),
          SwarmMessageField(
            controller: _text,
            focus: _focus,
            hint: 'Reply',
            fieldKey: const ValueKey('swarm-thread-field'),
          ),
          Row(
            children: [
              Expanded(
                child: _AlsoSend(
                  label: t.alsoSendLabel,
                  value: t.alsoSend,
                  onChanged: writable ? (on) => t.alsoSend = on : null,
                ),
              ),
              if (swarmSendsFiles)
                SwarmAttachButton(
                  key: const ValueKey('swarm-thread-attach'),
                  onTap: canAttach ? () => unawaited(_pickFiles()) : null,
                ),
              SwarmRoundButton(
                key: const ValueKey('swarm-thread-send'),
                label: 'Send reply',
                fill: canSend ? AppPalette.accent : ttyRaised(tty),
                onTap: canSend ? () => unawaited(_send()) : null,
                child: Icon(
                  LucideIcons.arrowUp,
                  size: 20,
                  color: canSend ? AppInk.onFill : AppPalette.textFaint,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _said(String text, {Key? key}) => Padding(
    key: key,
    padding: const EdgeInsets.all(AppSpace.xl),
    child: Center(
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: swarmChatText(15, color: AppPalette.textSecondary),
      ),
    ),
  );
}

/// Also send, ticked or not: the reply goes to the chat's main stream too.
/// The whole line is a thumb's target.
class _AlsoSend extends StatelessWidget {
  const _AlsoSend({
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final bool value;

  /// Null while a reply is on its way.
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final enabled = onChanged != null;
    return Semantics(
      key: const ValueKey('swarm-thread-also-send'),
      checked: value,
      enabled: enabled,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? () => onChanged!(!value) : null,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Row(
            children: [
              // The theme's checkbox, as the desktop's thread composer has.
              Checkbox(
                value: value,
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                onChanged: enabled ? (on) => onChanged!(on ?? false) : null,
              ),
              const SizedBox(width: AppSpace.s),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: swarmChatText(
                    14,
                    color: enabled
                        ? AppPalette.textPrimary
                        : AppPalette.textFaint,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A link in the accent: Show earlier replies, Try again.
class _Link extends StatelessWidget {
  const _Link({super.key, required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TtyTap(
    semanticsLabel: label,
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.s,
        vertical: AppSpace.m,
      ),
      child: Text(
        label,
        style: swarmChatText(15, color: AppPalette.accentOnSurface),
      ),
    ),
  );
}
