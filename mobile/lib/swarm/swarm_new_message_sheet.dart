import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import 'package:harness_mobile/core/project_folder.dart' show foldDiacritics;
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_attach.dart';
import 'swarm_buddy.dart';
import 'swarm_choices.dart';
import 'swarm_conversation.dart';
import 'swarm_conversation_page.dart'
    show
        SwarmAttachButton,
        SwarmMessageField,
        SwarmRoundButton,
        attachSwarmFiles;
import 'swarm_inbox.dart';
import 'swarm_outgoing_files.dart';
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_voice.dart';

/// A chat New message can post to: chat [chatId] of Swarm [swarmId].
typedef SwarmChatPick = ({String swarmId, String chatId});

/// One place a new message can go ([swarmNewMessageChats]): a project's own
/// chat, or the person's own Buddy chat there ([buddy]).
@immutable
class SwarmNewMessageChat {
  const SwarmNewMessageChat({
    required this.swarmId,
    required this.swarm,
    required this.chatId,
    required this.project,
    this.buddy,
  });

  final String swarmId, chatId;

  /// The Swarm's name and the project's.
  final String swarm, project;

  /// The person's Buddy there — its agent id while one runs, and its name —
  /// for their Buddy chat; null for the project's chat.
  final ({String? id, String name})? buddy;

  /// "#Mobile", or "Wren · Mobile".
  String get title => switch (buddy) {
    final buddy? => '${buddy.name} · $project',
    null => '#$project',
  };

  SwarmChatPick get pick => (swarmId: swarmId, chatId: chatId);
}

/// What New message lists of [swarms], the Swarms Home shows: each project's
/// chat the person may read, and their own Buddy chat in it; projects first,
/// by name, then the Buddy chats. Never another person's Buddy chat, a
/// private chat, an archived one, or one in a Swarm whose read was taken
/// away or the person may only read ([readOnly]). The list, or a Swarm on it,
/// still to be read is [reading]; one that could not be read is [failed],
/// never no chat.
({List<SwarmNewMessageChat> chats, bool reading, bool failed, bool readOnly})
swarmNewMessageChats(SwarmInbox inbox, List<SwarmListing> swarms) {
  final chats = <SwarmNewMessageChat>[];
  var failed = !inbox.loaded && (inbox.error != null || inbox.noComputer);
  var reading = !inbox.loaded && !failed;
  var readOnly = false;
  for (final swarm in swarms) {
    final reader = inbox.reader(swarm.id);
    if (reader == null || reader.accessRevoked) continue;
    if (reader.loading) reading = true;
    final snapshot = reader.snapshot;
    if (snapshot == null) {
      if (reader.error != null) failed = true;
      continue;
    }
    if (!swarmCanWrite(reader)) {
      readOnly = true;
      continue;
    }
    final me = snapshot.people
        .where((p) => p.id == reader.accountId)
        .firstOrNull;
    for (final project in snapshot.projects) {
      // As the server reads it (`canReadProject`): a private project is its
      // owner's and its members'. The server sends no other; this holds if
      // it ever did.
      if (project.isPrivate &&
          project.ownerId != reader.accountId &&
          (me == null || !project.hasMember(me))) {
        continue;
      }
      final lead = snapshot.conversation(project.leadConversationId);
      if (lead != null &&
          lead.projectId == project.id &&
          !lead.archived &&
          !lead.isBuddyChat &&
          lead.audience == null) {
        chats.add(
          SwarmNewMessageChat(
            swarmId: swarm.id,
            swarm: swarm.name,
            chatId: lead.id,
            project: project.name,
          ),
        );
      }
      final own = swarmBuddyChat(reader, project.id);
      if (own != null &&
          own.projectId == project.id &&
          !own.archived &&
          own.buddyOwnerId == reader.accountId) {
        chats.add(
          SwarmNewMessageChat(
            swarmId: swarm.id,
            swarm: swarm.name,
            chatId: own.id,
            project: project.name,
            buddy: (
              id: swarmBuddy(reader, project.id)?.id,
              name: swarmBuddyName(reader, project.id),
            ),
          ),
        );
      }
    }
  }
  final order = {
    for (final chat in chats)
      chat:
          '${chat.buddy == null ? 0 : 1}'
          '${swarmSearchFold(chat.project)}\u0000'
          '${swarmSearchFold(chat.swarm)}',
  };
  chats.sort((a, b) => order[a]!.compareTo(order[b]!));
  return (
    chats: List.unmodifiable(chats),
    reading: reading,
    failed: failed,
    readOnly: readOnly,
  );
}

/// [text] as New message's To: matches it: in lower case and without its
/// accents — Vietnamese `đ` included — however the keyboard composed them.
String swarmSearchFold(String text) =>
    foldDiacritics(unorm.nfd(text).replaceAll(_marks, '')).toLowerCase();

/// The combining accents a decomposed letter carries.
final _marks = RegExp('[\u0300-\u036f]');

/// New message over Swarm Home (Tony, 10-30: as Slack Mobile starts one):
/// the person picks a project's chat or their own Buddy chat, from the
/// Swarms Home [shown], types and sends from here. Answers the chat the
/// message went to once the backend took it; null when it closed without
/// one, or access went meanwhile.
Future<SwarmChatPick?> showSwarmNewMessage(
  BuildContext context,
  SwarmSession session, {
  required List<SwarmListing> Function() shown,
}) => showModalBottomSheet<SwarmChatPick>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  backgroundColor: AppGlass.rowFill,
  shape: AppControl.sheetShape,
  builder: (_) => SwarmNewMessageSheet(session: session, shown: shown),
);

/// What [showSwarmNewMessage] shows: ✕ and its title; To:, which narrows
/// the chats by name, case and accents aside; the chats
/// ([swarmNewMessageChats]), one picked at a time — the three scrolling as
/// one — and, pinned under them above the keyboard, a composer like a
/// chat's, with + and the mic.
///
/// Send goes the way a chat's own composer sends ([SwarmConversation.send]):
/// once, under one operation id, sent again under the same id while its
/// answer never came. The pick, the text and the files stay as they are
/// until the backend answers; refused or not confirmed, they stay with the
/// reason and nothing opens. Taken, the sheet closes with the chat.
///
/// The account leaving, a Swarm it lists losing its read or leaving the
/// list, or the chat picked leaving it, closes the sheet at once, blank
/// until it goes, with all it held: the text, the files, a post not
/// confirmed and a take under way.
class SwarmNewMessageSheet extends StatefulWidget {
  const SwarmNewMessageSheet({
    super.key,
    required this.session,
    required this.shown,
  });

  final SwarmSession session;

  /// The Swarms Home shows, as it shows them now.
  final List<SwarmListing> Function() shown;

  @override
  State<SwarmNewMessageSheet> createState() => _SwarmNewMessageSheetState();
}

class _SwarmNewMessageSheetState extends State<SwarmNewMessageSheet>
    implements SwarmFilesBox {
  final _query = TextEditingController();
  final _text = TextEditingController();
  final _focus = FocusNode(debugLabel: 'New message');

  /// The files going with the message, until it goes: in memory, or a large
  /// one on disk in the app's temporary folder.
  @override
  final files = SwarmOutgoingFiles();

  SwarmChatPick? _picked;

  /// The chat a post went to, from its first Send: kept while its answer is
  /// awaited or never came, so Send again is the same post.
  SwarmConversation? _chat;

  bool _sending = false, _closing = false, _picking = false;

  /// Why the last Send did not go, and what the last pick left out.
  String? _error, _note;

  /// The mic, while the shell can hear one ([SwarmScope.voiceOf]).
  SwarmVoice? _voice;

  /// No other screen covers the sheet.
  bool _visible = true;

  /// The reader of each Swarm the sheet lists, listened to: one that loses
  /// its read, or leaves the list, closes the sheet.
  final _readers = <String, SwarmReader>{};

  SwarmInbox get _inbox => widget.session.inbox;

  /// A post is on its way, or its answer never came: it goes to the chat
  /// picked, as typed.
  bool get _locked => _sending || (_chat?.unconfirmed ?? false);

  bool get _canSend =>
      !_sending &&
      !_closing &&
      _picked != null &&
      ((_chat?.unconfirmed ?? false) ||
          _text.text.trim().isNotEmpty ||
          files.files.isNotEmpty);

  @override
  void initState() {
    super.initState();
    _inbox.addListener(_changed);
    _query.addListener(_redraw);
    _text.addListener(_redraw);
    files.addListener(_filesChanged);
    _watch();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Signed out, another account, or Swarm turned off.
    if (SwarmScope.of(context) != widget.session) _close();
    _visible = TickerMode.valuesOf(context).enabled;
    if (_voice == null) {
      if (SwarmScope.voiceOf(context) case final create?) {
        _voice = SwarmVoice(
          create: create,
          dictation: SwarmScope.dictationOf(context),
          draft: () => _text.text,
          write: (text) {
            if (_locked || _closing) return;
            _text.value = TextEditingValue(
              text: text,
              selection: TextSelection.collapsed(offset: text.length),
            );
          },
          send: _spoken,
        )..addListener(_redraw);
      }
    }
    // A covered sheet hears nothing: its take goes with it.
    if (!_visible) _voice?.hide();
  }

  @override
  void dispose() {
    _inbox.removeListener(_changed);
    for (final reader in _readers.values) {
      reader.removeListener(_changed);
    }
    _readers.clear();
    _forgetChat();
    _voice
      ?..removeListener(_redraw)
      ..dispose();
    files
      ..removeListener(_filesChanged)
      ..clear()
      ..dispose();
    _query.dispose();
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _redraw() {
    if (mounted && !_closing) setState(() {});
  }

  /// The Swarms or a chat moved: the list follows them, and the sheet closes
  /// once one it lists is lost.
  void _changed() {
    if (_closing) return;
    _watch();
    _redraw();
  }

  /// Closes the sheet once a Swarm it lists left the list, or lost its read
  /// (a reader listed again is a new one), or the chat picked left the list;
  /// listens to each Swarm Home shows, for its read taken away at once.
  void _watch() {
    final inbox = _inbox;
    for (final MapEntry(key: id, value: reader) in _readers.entries) {
      if (reader.accessRevoked ||
          inbox.reader(id) != reader ||
          !inbox.swarms.any((swarm) => swarm.id == id)) {
        _close();
        return;
      }
    }
    for (final swarm in widget.shown()) {
      final reader = inbox.reader(swarm.id);
      if (reader == null ||
          reader.accessRevoked ||
          _readers.containsKey(swarm.id)) {
        continue;
      }
      _readers[swarm.id] = reader..addListener(_changed);
    }
    if (_picked case final pick? when _find(pick) == null) _close();
  }

  /// [pick] as the list has it now; null once it left the list.
  SwarmNewMessageChat? _find(SwarmChatPick pick) => swarmNewMessageChats(
    _inbox,
    widget.shown(),
  ).chats.where((chat) => chat.pick == pick).firstOrNull;

  /// Closes the sheet once, after the frame it went blank in, answering
  /// [sent]: whatever it holds goes now. A sheet or dialog over it (+'s, or
  /// one it opened) goes too.
  void _close([SwarmChatPick? sent]) {
    if (_closing) return;
    _closing = true;
    _forgetChat();
    _voice?.hide();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      navigator.popUntil((top) => top == route || top is! PopupRoute);
      if (route.isCurrent) {
        navigator.pop(sent);
      } else {
        navigator.removeRoute(route);
      }
    });
  }

  /// The chat a post went to is let go: a post not confirmed is given up,
  /// its files with it.
  void _forgetChat() {
    final chat = _chat;
    _chat = null;
    chat
      ?..composer.removeListener(_redraw)
      ..dispose();
  }

  /// Taking a file off takes it off the post too, and gives its upload up.
  void _filesChanged() {
    if (_chat case final chat? when !chat.unconfirmed) {
      for (final file in chat.files.files) {
        if (!files.files.contains(file)) chat.files.remove(file);
      }
    }
    _redraw();
  }

  @override
  bool isUploading(SwarmOutgoingFile file) => _chat?.isUploading(file) ?? false;

  @override
  double? uploadProgress(SwarmOutgoingFile file) => _chat?.uploadProgress(file);

  void _pick(SwarmNewMessageChat chat) {
    if (_locked || _closing) return;
    setState(() {
      _picked = chat.pick;
      _error = null;
    });
    _focus.requestFocus();
  }

  /// The second tap on the mic ended a take: what is in the box goes, as
  /// Send would send it.
  void _spoken() {
    if (_visible && _text.text.trim().isNotEmpty && _canSend) {
      unawaited(_send());
    }
  }

  /// +'s sheet and picker ([attachSwarmFiles]), their files into [files].
  Future<void> _attach() async {
    if (_picking || _locked) return;
    _picking = true;
    try {
      await attachSwarmFiles(
        context,
        files,
        stillWanted: () => mounted && !_closing && !_locked,
        note: (note) {
          if (mounted && !_closing) setState(() => _note = note);
        },
      );
    } finally {
      _picking = false;
    }
  }

  /// Posts the text and the files to the chat picked, through that chat's
  /// own send; or, while its post is not confirmed, sends that one again.
  /// Taken, the person has read that chat through it, as posting in the chat
  /// reads it, and the sheet closes with it; refused or lost, the sheet says
  /// why and keeps it all.
  Future<void> _send() async {
    final pick = _picked;
    if (!_canSend || pick == null || _find(pick) == null) return;
    final reader = _inbox.reader(pick.swarmId);
    if (reader == null || reader.accessRevoked) return;
    if (_chat case final held?
        when held.reader != reader || held.id != pick.chatId) {
      _forgetChat();
    }
    final chat = _chat ??= SwarmConversation(reader, pick.chatId, shown: false)
      ..composer.addListener(_redraw);
    if (!chat.unconfirmed) {
      chat.draft = _text.text;
      // The same files as last time keep what of them went up.
      if (!listEquals(chat.files.files, files.files)) {
        chat.files
          ..clear()
          ..add(files.files);
      }
    }
    setState(() {
      _sending = true;
      _error = _note = null;
    });
    final sent = await chat.send();
    // Closed, or access lost, meanwhile: nothing here moves.
    if (!mounted || _closing || _chat != chat) return;
    if (!sent) {
      setState(() {
        _sending = false;
        _error = chat.error ?? 'Your message was not sent. Try again.';
      });
      return;
    }
    _sending = false;
    chat.shown = true;
    _close(pick);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    if (_closing) return const SizedBox.shrink();
    final tty = Tty.of(context);
    final shown = widget.shown();
    final list = swarmNewMessageChats(_inbox, shown);
    final picked = switch (_picked) {
      final pick? => list.chats.where((chat) => chat.pick == pick).firstOrNull,
      null => null,
    };
    return SizedBox(
      // As tall whatever the list holds: a sheet the size of its rows would
      // jump as To: narrows them.
      height: MediaQuery.sizeOf(context).height * .9,
      child: Padding(
        // The composer rides on the keyboard.
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // ✕, To: and the chats scroll as one, and only the composer is
            // pinned: on a small phone with the keyboard up, a long draft,
            // a reason or files still leave Send above the keys.
            Expanded(
              child: ListView(
                key: const ValueKey('swarm-new-message-list'),
                keyboardDismissBehavior:
                    ScrollViewKeyboardDismissBehavior.onDrag,
                padding: const EdgeInsets.only(bottom: AppSpace.m),
                children: [
                  _header(),
                  _to(),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: _rows(list, several: shown.length > 1),
                    ),
                  ),
                ],
              ),
            ),
            SafeArea(top: false, child: _composer(tty, picked)),
          ],
        ),
      ),
    );
  }

  /// ✕ and the title, centred.
  Widget _header() => Padding(
    padding: const EdgeInsets.fromLTRB(
      AppSpace.xs,
      AppSpace.xs,
      AppSpace.xs,
      0,
    ),
    child: Row(
      children: [
        SwarmIconButton(
          key: const ValueKey('swarm-new-message-close'),
          icon: LucideIcons.x,
          label: 'Close',
          size: AppIconSize.standalone,
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        Expanded(
          child: Text(
            'New message',
            textAlign: TextAlign.center,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppType.heading(color: AppPalette.textPrimary),
          ),
        ),
        // The ✕'s width again, so the title sits in the middle.
        const SizedBox(width: minTouchTarget),
      ],
    ),
  );

  /// To: and the field that narrows the chats.
  Widget _to() => Padding(
    padding: const EdgeInsets.fromLTRB(
      AppSpace.screenInset,
      AppSpace.xs,
      AppSpace.screenInset,
      AppSpace.s,
    ),
    child: Container(
      constraints: const BoxConstraints(minHeight: minTouchTarget),
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
      decoration: BoxDecoration(
        color: AppPalette.swarmSearchSurface,
        borderRadius: BorderRadius.circular(AppControl.radius),
      ),
      child: Row(
        children: [
          Text('To:', style: AppType.body(color: AppPalette.textSecondary)),
          const SizedBox(width: AppSpace.s),
          Expanded(
            child: TextField(
              key: const ValueKey('swarm-new-message-to'),
              controller: _query,
              autofocus: true,
              textInputAction: TextInputAction.search,
              style: AppType.body(color: AppPalette.textPrimary),
              decoration: InputDecoration(
                isCollapsed: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(
                  vertical: AppSpace.m,
                ),
                hintText: 'Search projects and chats',
                hintStyle: AppType.body(color: AppPalette.textFaint),
              ),
            ),
          ),
        ],
      ),
    ),
  );

  List<Widget> _rows(
    ({
      List<SwarmNewMessageChat> chats,
      bool reading,
      bool failed,
      bool readOnly,
    })
    list, {
    required bool several,
  }) {
    final query = swarmSearchFold(_query.text.trim());
    final found = [
      for (final chat in list.chats)
        if (query.isEmpty || swarmSearchFold(chat.title).contains(query)) chat,
    ];
    Widget line(String text, String key) => Padding(
      padding: const EdgeInsets.all(AppSpace.xs),
      child: SwarmRow.line(text, key: ValueKey(key), lines: 2),
    );
    const unread =
        'Some chats could not be loaded. Pull down on Home to try again.';
    if (found.isEmpty) {
      if (list.chats.isEmpty && list.reading) {
        return [SwarmSkeletonRows(id: 'swarm-new-message-loading')];
      }
      if (list.chats.isEmpty && list.failed) {
        return [line(unread, 'swarm-new-message-unread')];
      }
      if (list.chats.isEmpty && list.readOnly) {
        return [
          line(
            'You can read these Swarms, not post in them.',
            'swarm-new-message-read-only',
          ),
        ];
      }
      return [
        line(
          list.chats.isEmpty ? 'No chat yet.' : 'No chat matches.',
          'swarm-new-message-none',
        ),
      ];
    }
    final locked = _locked;
    return [
      SwarmGroup(
        children: [
          for (final chat in found)
            _ChatRow(
              key: ValueKey('swarm-new-message-${chat.swarmId}-${chat.chatId}'),
              chat: chat,
              picked: chat.pick == _picked,
              several: several,
              onTap: locked ? null : () => _pick(chat),
            ),
        ],
      ),
      if (list.failed) line(unread, 'swarm-new-message-unread'),
    ];
  }

  /// Why the last Send did not go, what the last pick left out, what the mic
  /// could not hear, the files going, then +, the field, the mic and Send.
  Widget _composer(Tty tty, SwarmNewMessageChat? picked) {
    final canSend = _canSend;
    final locked = _locked;
    Widget note(String text, String key, Color color) => Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpace.xs,
        0,
        AppSpace.xs,
        AppSpace.s,
      ),
      child: Text(
        text,
        key: ValueKey(key),
        style: AppType.caption(color: color),
      ),
    );
    return Container(
      decoration: BoxDecoration(
        color: Color.alphaBlend(tty.text.withValues(alpha: 0.02), tty.ground),
        border: Border(top: BorderSide(color: AppGlass.hair)),
      ),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.s,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_error case final error?)
            note(error, 'swarm-new-message-error', AppColors.danger),
          if (_note case final text?)
            note(text, 'swarm-new-message-attach-note', tty.yellow),
          if (_voice?.notice case final notice?)
            note(notice, 'swarm-new-message-voice-note', tty.yellow),
          if (_voice?.stopped case final stopped?)
            note(
              stopped,
              'swarm-new-message-voice-stopped',
              AppPalette.textSecondary,
            ),
          SwarmOutgoingChips(box: this),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (swarmSendsFiles)
                SwarmAttachButton(
                  key: const ValueKey('swarm-new-message-attach'),
                  onTap: locked || files.room <= 0
                      ? null
                      : () => unawaited(_attach()),
                ),
              const SizedBox(width: AppSpace.xs),
              Expanded(
                child: IgnorePointer(
                  ignoring: locked,
                  child: SwarmMessageField(
                    controller: _text,
                    focus: _focus,
                    hint: picked == null
                        ? 'Write a message…'
                        : 'Message ${picked.title}',
                    fieldKey: const ValueKey('swarm-new-message-field'),
                  ),
                ),
              ),
              if (_voice case final voice?)
                SwarmVoiceMic(voice: voice)
              else
                const SizedBox(width: AppSpace.xs),
              SwarmRoundButton(
                key: const ValueKey('swarm-new-message-send'),
                label: 'Send',
                fill: canSend || _sending ? AppPalette.accent : ttyRaised(tty),
                onTap: canSend ? () => unawaited(_send()) : null,
                child: _sending
                    ? SizedBox.square(
                        dimension: AppIconSize.besideText,
                        child: CircularProgressIndicator(
                          key: const ValueKey('swarm-new-message-sending'),
                          strokeWidth: 2,
                          color: AppInk.onFill,
                        ),
                      )
                    : Icon(
                        LucideIcons.arrowUp,
                        size: AppIconSize.besideText,
                        color: canSend ? AppInk.onFill : AppPalette.textFaint,
                      ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One chat New message lists: its mark — the project's tile, or the
/// Buddy's face — its title, its Swarm's name under it while Home shows
/// several, and the circle that says whether it is picked.
class _ChatRow extends StatelessWidget {
  const _ChatRow({
    super.key,
    required this.chat,
    required this.picked,
    required this.several,
    required this.onTap,
  });

  final SwarmNewMessageChat chat;
  final bool picked, several;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final buddy = chat.buddy;
    return Semantics(
      button: true,
      selected: picked,
      inMutuallyExclusiveGroup: true,
      enabled: onTap != null,
      onTap: onTap,
      label: [chat.title, if (several) chat.swarm].join(', '),
      excludeSemantics: true,
      child: SwarmRow(
        leading: buddy == null
            ? SwarmProjectTile(chat.project)
            : SwarmAvatar(id: buddy.id ?? chat.chatId, name: buddy.name),
        title: chat.title,
        detail: several ? SwarmRow.line(chat.swarm) : null,
        trailing: _PickCircle(picked: picked),
        onTap: onTap,
      ),
    );
  }
}

/// A row's pick: an empty ring, or the accent's filled circle with a tick.
class _PickCircle extends StatelessWidget {
  const _PickCircle({required this.picked});

  final bool picked;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Container(
      key: picked ? const ValueKey('swarm-new-message-picked') : null,
      width: AppIconSize.standalone,
      height: AppIconSize.standalone,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: picked ? AppPalette.accent : null,
        border: picked
            ? null
            : Border.all(color: AppPalette.textFaint, width: 1.5),
      ),
      child: picked
          ? Icon(LucideIcons.check, size: 16, color: AppInk.onFill)
          : null,
    );
  }
}

/// Home's New message: a round + in the accent, the screen's primary
/// action, floating at its bottom right over the list (Tony, 10-30: as
/// Slack Mobile has it; desktop design system, Phone).
class SwarmNewMessageButton extends StatelessWidget {
  const SwarmNewMessageButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  /// Its round, wider than a target, as a floating action is drawn.
  static const double size = 56;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Semantics(
      button: true,
      label: 'New message',
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: AppSurface.shadow,
        ),
        child: Material(
          color: AppPalette.accent,
          shape: const CircleBorder(),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            child: SizedBox.square(
              dimension: size,
              child: Icon(
                LucideIcons.plus,
                size: AppIconSize.standalone,
                color: AppInk.onFill,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
