import 'dart:async';
import 'dart:collection';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:dio/dio.dart' show CancelToken, DioException, DioExceptionType;
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import '../state/harness_attachments.dart';
import 'attachment_upload.dart';
import 'avatar_upload.dart';
import 'message_link.dart';
import 'model.dart';
import 'buddy_chat.dart';
import 'project_github.dart';
import 'parts.dart';
import 'read_marks.dart';
import 'reading.dart';
import 'review_verdict.dart';

/// A messages read started beside a state read, and what it asked for.
typedef _EarlyRead = ({String query, Future<Map<String, dynamic>> page});

typedef SuperTabRequest = Future<Map<String, dynamic>> Function(
  String method,
  String path, {
  Map<String, dynamic>? body,
});

String superTabOperationId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

class SuperTabFailure implements Exception {
  const SuperTabFailure(this.code, this.message, {this.statusCode = 0});
  final String code, message;
  final int statusCode;
  @override
  String toString() => message;
}

/// Where a message the reader sent stands while the transcript does not
/// show it yet.
enum SuperTabOutgoingState {
  /// On its way, or accepted and not read back yet.
  sending,

  /// Sent with no answer: it may or may not have arrived. Retry checks and
  /// sends it once.
  unconfirmed,

  /// The backend refused it; nothing was posted.
  refused,
}

/// A message the backend refused, with the tags it was sent with.
typedef _Refused = ({
  String operationId,
  Map<String, dynamic> command,
  Map<String, String> mentions,
  String error,
});

/// A message the reader sent that the transcript does not hold yet.
class SuperTabOutgoing {
  const SuperTabOutgoing({
    required this.conversationId,
    required this.text,
    required this.state,
    this.operationId,
    this.replyTo,
    this.thread,
    this.alsoSend = false,
    this.error,
  });
  final String conversationId, text;

  /// The thread root a reply goes to, null for a top-level or inline reply.
  final String? thread;

  /// A thread reply also sent to the main stream.
  final bool alsoSend;
  bool get inMainStream => thread == null || alsoSend;

  /// The send's receipt id, while it is not confirmed.
  final String? operationId;
  final String? replyTo;
  final SuperTabOutgoingState state;

  /// Why it was refused, as the backend said it.
  final String? error;
}

/// Personal navigation/drafts live on this client. Membership, work and messages
/// live on the backend; refreshing never selects another person's conversation.
/// WS roadmap Phase 2a: a server that pushes Swarm changes (backend
/// lib/swarmClientPushes.ts) says so every 4 minutes. Without that word for
/// this long (an older server, a rollback, Redis down) a Swarm polls as
/// before.
const kSwarmPushLease = Duration(minutes: 5);

/// While the server pushes, a Swarm nothing was said of is still read this
/// often: the safety net for a push lost on the way.
const kSwarmPushSafetyNet = Duration(seconds: 60);

/// While the server pushes, which Swarms the account is in is still read this
/// often; a change to one asks for a read at once (`SuperTabClient`).
const kSwarmDiscoverySafetyNet = Duration(minutes: 2);

class SuperTabController extends ChangeNotifier {
  SuperTabController({
    required this.tabId,
    required this.accountId,
    required this.request,
    required this.save,
    this.upload = refuseUpload,
    this.avatarUpload = refuseAvatarUpload,
    this.uploadTimeout = const Duration(minutes: 2),
    Map<String, dynamic> initial = const {},
    this.pollInterval = const Duration(seconds: 3),
    SuperTabReading reading = const SuperTabReading(),
  }) : _policy = reading {
    if (initial['tabId'] == tabId && initial['accountId'] == accountId) {
      _savedSelection = initial['selectedId'] is String;
      expandedProjects.addAll(
        (initial['expandedProjects'] as List? ?? const []).whereType<String>(),
      );
      expandedMachines.addAll(
        (initial['expandedMachines'] as List? ?? const []).whereType<String>(),
      );
      _decisionsAside.addAll(
        (initial['decisionsAside'] as List? ?? const []).whereType<String>(),
      );
      devicesSelected = initial['devicesSelected'] == true;
      projectsGroupOpen = initial['projectsGroupOpen'] as bool? ?? true;
      machinesGroupOpen = initial['machinesGroupOpen'] as bool? ?? true;
      offlineMachinesOpen = initial['offlineMachinesOpen'] as bool? ?? false;
      selectedId = initial['selectedId'] as String? ?? 'lead';
      final drafts = initial['drafts'];
      if (drafts is Map) {
        for (final entry in drafts.entries) {
          if (entry.key is String && entry.value is String) {
            _drafts[entry.key as String] = entry.value as String;
          }
        }
      }
      final read = initial['readAt'];
      final terminals = initial['terminals'];
      if (terminals is Map) {
        for (final entry in terminals.entries) {
          if (entry.key is String && entry.value is String) {
            _terminals[entry.key as String] = entry.value as String;
          }
        }
      }
      final mentions = initial['mentions'];
      if (mentions is Map) {
        for (final group in mentions.entries) {
          if (group.key is String && group.value is Map) {
            _mentions[group.key as String] = {
              for (final mention in (group.value as Map).entries)
                if (mention.key is String && mention.value is String)
                  mention.key as String: mention.value as String,
            };
          }
        }
      }
      if (read is Map) {
        for (final entry in read.entries) {
          if (entry.key is String && entry.value is num) {
            _readAt[entry.key as String] = (entry.value as num).toInt();
          }
        }
      }
      if (initial['threadSeen'] case final Map seen) {
        for (final MapEntry(:key, :value) in seen.entries) {
          if (key is String && value is num) _threadSeen[key] = value.toInt();
        }
      }
      final refused = initial['refused'];
      if (refused is Map) {
        for (final MapEntry(:key, :value) in refused.entries) {
          if (key is! String || value is! List) continue;
          final kept = [
            for (final row in value)
              if (row is Map &&
                  row['operationId'] is String &&
                  row['command'] is Map &&
                  row['error'] is String)
                (
                  operationId: row['operationId'] as String,
                  command: superTabMap(row['command']),
                  mentions: {
                    for (final MapEntry(key: agent, value: token)
                        in superTabMap(row['mentions']).entries)
                      if (token is String) agent: token,
                  },
                  error: row['error'] as String,
                ),
          ];
          if (kept.isNotEmpty) _refused[key] = kept;
        }
      }
      if (initial['pending'] is Map) {
        final value = superTabMap(initial['pending']);
        if (value['operationId'] is String && value['command'] is Map) {
          _pending = value;
          operationError = 'Check the pending action before sending it again.';
        }
      }
    }
  }

  final String tabId, accountId;
  final SuperTabRequest request;
  final Future<void> Function(Map<String, dynamic> state) save;
  final Duration pollInterval;

  /// Sends one file to the backend.
  final SuperTabUpload upload;

  /// Sends an avatar picture (profile_actions.dart).
  final SuperTabAvatarUpload avatarUpload;

  /// How long an upload may go without a byte moving before the send gives up.
  final Duration uploadTimeout;
  SuperTabSnapshot? snapshot;
  String selectedId = 'lead';

  /// Counts the reader's moves ([_moveView]), so a slow [select] cannot land
  /// over a newer choice.
  int _selectRequest = 0;

  /// Every move of what the reader looks at goes through here: a [select]
  /// still reading its conversation then knows it was overtaken.
  void _moveView({String? to, bool devices = false}) {
    _selectRequest++;
    devicesSelected = devices;
    if (to != null && to != selectedId) {
      _leftAt[selectedId] = clock.now();
      selectedId = to;
    }
  }

  /// The newest change of the Swarm this tab has read, in epoch milliseconds: what tells the app and the tag list
  /// that it changed (spec ruling 8).
  int lastChangedAt = -1;

  /// The backend no longer serves this build's reads (HTTP 426): the tab says
  /// to update Harness and asks nothing more (section 5.1).
  bool updateRequired = false;

  /// What the tab says once [updateRequired] (docs/naming-system.md).
  static const updateMessage = 'Update Harness to keep using this Swarm.';

  /// The Swarm's parts as last read: what the next read asks changes for, and what [snapshot] is built from.
  SuperTabParts? _parts;

  /// The visibility epoch of the last read: it moves when who may read what changes (backend parts/commit.ts
  /// `visibilityChanged`). Null before a read.
  int? get visibilityEpoch => _parts?.epoch;
  String? error, operationError, operationErrorCode;

  /// Why the files of each conversation's last send did not go up. Kept apart
  /// from [operationError] so it shows only under its own conversation.
  final _uploadErrors = <String, String>{};

  /// What the composer of [conversationId] says went wrong: the last action's
  /// [operationError], else its own upload failure.
  String? composerError(String conversationId) =>
      operationError ?? _uploadErrors[conversationId];

  /// One line for the sender after a command succeeds, from the backend: that a
  /// credential was removed from what they sent and should be revoked.
  String? operationNotice;
  bool loading = false, saving = false, uploading = false;
  bool accessRevoked = false;
  bool _disposed = false;
  Timer? _poll, _draftSave, _graceEnd;
  Future<void>? _refreshing;

  /// How this tab keeps itself current; Desktop's unless a host sets another.
  SuperTabReading get reading => _policy;
  set reading(SuperTabReading value) {
    if (identical(value, _policy)) return;
    _policy = value;
    if (_startedAt != null) _schedule();
  }

  SuperTabReading _policy;
  DateTime? _startedAt, _lastFullRead;

  /// Until when the server is known to push this Swarm's changes
  /// ([kSwarmPushLease]); set by [SuperTabClient] as it hears the server.
  DateTime? pushUntil;

  /// Told of a change since the last read began: one of its main parts, or a
  /// machine's reading alone; and the change times told lately, to know a
  /// push heard again ([_kToldTimes] of them).
  bool _toldMain = false, _toldMachine = false;
  final _toldTimes = <int>{};
  static const _kToldTimes = 64;

  bool get _pushing {
    final until = pushUntil;
    return until != null && clock.now().isBefore(until);
  }

  /// The server said this Swarm changed, at [at] when it names the commit's
  /// time. Only an exact repeat is dropped: a time already told, or the one
  /// the last read returned. A phone hears each push once per machine socket
  /// (review of #2121). An older time is not a repeat: each server stamps a
  /// commit from its own clock as the command starts, so a later commit can
  /// carry an earlier time (re-check of #2121). The rest is read on the next allowed read: now if the old poll
  /// would have read by now, else on the tick that would ([_readGap]), so a
  /// busy Swarm reads no more often than before pushes. A machine's reading
  /// alone always waits for the tick. Not on screen while the reading pauses,
  /// nothing is read until it is shown again, which reads at once.
  void told({required bool main, int? at}) {
    if (_disposed || accessRevoked || updateRequired) return;
    if (main && at != null) {
      if (at == lastChangedAt || !_toldTimes.add(at)) return;
      if (_toldTimes.length > _kToldTimes) _toldTimes.remove(_toldTimes.first);
    }
    if (main) {
      _toldMain = true;
    } else {
      _toldMachine = true;
    }
    _readWhenAllowed();
  }

  /// One read at the next allowed moment for what it was told: now if the
  /// gap since the last read has passed, else when it does; after a read
  /// under way, for a change heard while it was out.
  Timer? _toldRead;
  void _readWhenAllowed() {
    if (_toldRead != null || _disposed || !(_toldMain || _toldMachine)) return;
    if (_policy.pausesAway && _away) return;
    // A read under way reads again, if it must, once it ends (refresh).
    if (_refreshing != null) return;
    final last = _lastFullRead;
    final wait = last == null
        ? Duration.zero
        : _readGap - clock.now().difference(last);
    if (wait <= Duration.zero) {
      unawaited(refresh());
      return;
    }
    _toldRead = Timer(wait, () {
      _toldRead = null;
      if (_disposed || accessRevoked || updateRequired) return;
      if (!(_toldMain || _toldMachine) || (_policy.pausesAway && _away)) {
        return;
      }
      if (_refreshing == null) unawaited(refresh());
    });
  }

  /// How often the idle poll reads: every [pollInterval], or
  /// [SuperTabReading.awayPoll] while the Swarm is away (never more often
  /// than [pollInterval]). A push is not an idle poll: [_readGap] keeps
  /// reading a told change at [pollInterval], so a tag reaches an away
  /// Swarm's badge and notice as fast as before.
  Duration get _every {
    final away = _policy.awayPoll;
    if (away == null || !_away) return pollInterval;
    return away > pollInterval ? away : pollInterval;
  }

  /// How often the poll read before pushes: every [pollInterval], or
  /// [SuperTabReading.quietPoll] once the person has been quiet a while.
  Duration get _readGap {
    final quiet = _policy.quietPoll;
    if (quiet != null &&
        clock.now().difference(_lastActivity) >= _policy.quietAfter) {
      return quiet;
    }
    return pollInterval;
  }

  bool get _gapPassed {
    final last = _lastFullRead;
    return last == null || clock.now().difference(last) >= _readGap;
  }

  /// Whether this poll reads. Always, unless the server pushes: then only when
  /// told and the old poll would have read by now, when the safety net is
  /// due, or while the person's own message in the open conversation waits
  /// for its receipt, which no push names.
  bool get _pollDue {
    if (!_pushing || _receiptOpen(selectedId)) return true;
    if ((_toldMain || _toldMachine) && _gapPassed) return true;
    final last = _lastFullRead;
    return last == null || clock.now().difference(last) >= kSwarmPushSafetyNet;
  }

  /// The person's latest message in [id] still has a delivery in hand.
  bool _receiptOpen(String id) {
    SuperTabMessage? own;
    for (final m in _messages[id] ?? const <SuperTabMessage>[]) {
      if (m.fromAgent || m.fromTerminal || m.authorId != accountId) continue;
      if (own == null || m.sequence > own.sequence) own = m;
    }
    return own != null &&
        own.deliveries.any(
          (d) => !const {
            'answered',
            'cancelled',
            'superseded',
          }.contains(d['status']),
        );
  }

  /// When the parts held were last read: how old a [savedView] of them is.
  DateTime? _partsReadAt;

  /// The rows each conversation's messages were read from, kept only to save
  /// the view ([SuperTabReading.drawsSaved]).
  final _rows = <String, Map<String, Map<String, dynamic>>>{};

  /// A saved view is on screen and no read has replaced it yet.
  bool get showingSaved => _showingSaved;
  bool _showingSaved = false;

  /// Moves when what a [savedView] holds changes: the state as read, or the
  /// open conversation and its page. Not for what only the page around them
  /// does (read marks, open groups), which needs no new copy kept.
  int get viewVersion => _viewVersion;
  int _viewVersion = 0;

  /// The last time the person did something here, or a new message reached
  /// the open conversation: what keeps the full poll ([SuperTabReading.quietPoll]).
  DateTime _lastActivity = clock.now();

  /// The saved state named the open conversation before any read.
  bool _savedSelection = false;

  /// The first reads found no machine connected, within the grace
  /// ([SuperTabReading.connectGrace]): still loading rather than failed.
  bool _waitingForMachine = false;
  Object? _graceFailure;

  /// Not on screen: another tab is shown, or the page is hidden. Only a
  /// reading that [SuperTabReading.pausesAway] stops polling for it; coming
  /// back reads at once.
  bool get away => _away;
  bool _away = false;
  set away(bool value) {
    if (_away == value) return;
    _away = value;
    if (_startedAt == null || _disposed) return;
    if (!_policy.pausesAway) {
      // Going away slows the poll; coming back reads at once unless a poll
      // just did ([SuperTabReading.awayPoll]).
      if (_policy.awayPoll == null) return;
      final last = _lastFullRead;
      if (!value &&
          (last == null || clock.now().difference(last) >= pollInterval)) {
        unawaited(refresh());
      }
      _schedule();
      return;
    }
    if (value) {
      _poll?.cancel();
      return;
    }
    _acted();
    unawaited(refresh());
    _schedule();
  }

  /// The latest read of the Swarm's state failed (and the tab is still ours). While it is, what the
  /// machines last reported cannot be told from what they report now: a machine is neither online nor
  /// offline, and the Swarm says its backend is unreachable instead of calling machines offline.
  bool get backendUnreachable =>
      _refreshFailing && !accessRevoked && !updateRequired;
  bool _refreshFailing = false;

  /// Since when the reads have been failing, while [backendUnreachable]: the first failure of this run of them.
  DateTime? unreachableSince;

  /// How many reads of the Swarm's state have been answered. A sidebar that is waiting for a new reading (back from
  /// the background) knows it has one when this moves.
  int stateReads = 0;
  Future<void> _persisting = Future.value();
  Map<String, dynamic>? _pending;

  /// Sends the backend took, by message id, until the transcript holds them.
  final _sent = <String, Map<String, dynamic>>{};

  /// The tags of each message on its way, by operation id, for a refusal to
  /// give back.
  final _sendingMentions = <String, Map<String, String>>{};

  /// Per conversation, oldest first, the messages the backend refused, each
  /// kept until it is sent again or deleted.
  final _refused = <String, List<_Refused>>{};
  final _drafts = <String, String>{};
  final _terminals = <String, String>{};
  final _mentions = <String, Map<String, String>>{};
  final _readAt = <String, int>{};

  /// Per conversation, each thread's summary as the newest page said it.
  final _threads = <String, Map<String, SuperTabThread>>{};

  /// Per thread root, the newest reply the reader has seen.
  final _threadSeen = <String, int>{};

  /// Each thread's rows as its own read brought them.
  final _threadRows = <String, List<SuperTabMessage>>{};

  /// Where each thread's earlier replies continue, while there are more.
  final _threadBefore = <String, Map<String, dynamic>>{};
  final _threadDrafts = <String, String>{};

  /// The thread open beside the chat.
  ({String conversationId, String root})? openedThread;
  final _attachments = <String, HarnessAttachments>{};
  // Files already uploaded for the message being sent, so a retry sends their
  // ids rather than uploading them again.
  final _uploaded = <HarnessAttachment, String>{};
  final _progress = <HarnessAttachment, double>{};
  CancelToken? _cancel;
  ({String conversationId, List<HarnessAttachment> files})? _sending;
  int _uploadRun = 0;
  final _messages = <String, List<SuperTabMessage>>{};

  /// Originals of replies quoted from outside the pages read, one message
  /// each, never part of the list: null when it is gone or refused.
  final _quoted = <String, Map<String, SuperTabMessage?>>{};

  /// The originals asked for, with how many reads of each failed (not refused).
  final _quoting = <String, Map<String, int>>{};
  final _quoteRetries = <Timer>{};
  static const _quoteTries = 3;
  static const _quoteRetryAfter = Duration(seconds: 3);

  /// Where each conversation's older history continues: the oldest message
  /// read, as the backend's page cursor names it (section 4.6). Null at the
  /// start of the conversation.
  final _before = <String, SuperTabPage?>{};

  /// At most this many messages are held of a conversation whose reader is at
  /// its end: a busy one left open all day reads, sorts and folds no more
  /// each poll. The rows cut are read again by scrolling up.
  static const _heldMessages = 500;

  /// Per conversation, the message its view lays its list out from (its
  /// dividing row): from it on, no row is cut, since cutting them moves the
  /// rows on screen. Rows before it may be cut.
  final _cutBefore = <String, SuperTabMessage>{};

  /// The view of [id] lays its list out from [message] on ([_cutBefore]).
  void keepFrom(String id, SuperTabMessage message) => _cutBefore[id] = message;

  /// When the reader left each conversation they opened, until it is open
  /// again or its messages are dropped ([_dropLeft]).
  final _leftAt = <String, DateTime>{};

  /// A conversation left this long holds no messages: opening it again reads
  /// its latest page, as the first open did. Longer than going back and forth
  /// between a few groups; short enough that a day of browsing holds only the
  /// ones read lately.
  static const _keepLeft = Duration(minutes: 15);

  /// Each conversation's reads under way, newest and older apart: an older
  /// page asked for during a poll's read is a read of its own.
  final _reading = <(String, bool), Future<void>>{};
  final expandedProjects = <String>{};
  final expandedMachines = <String>{};
  bool devicesSelected = false;
  bool projectsGroupOpen = true, machinesGroupOpen = true;

  bool isMachineExpanded(String id) => expandedMachines.contains(id);

  void toggleMachineExpanded(String id) {
    if (!expandedMachines.remove(id)) expandedMachines.add(id);
    _saveSoon();
    _changed();
  }

  /// Devices is personal navigation inside this Swarm. The selected workgroup,
  /// its draft and terminal choice stay available when the person returns.
  void selectDevices() {
    if (_disposed || accessRevoked || devicesSelected) return;
    _moveView(devices: true);
    _saveSoon();
    _changed();
  }

  /// Whether the Machines group's "Offline · N" disclosure is open; it starts closed.
  bool offlineMachinesOpen = false;

  void toggleProject(String id) {
    if (!expandedProjects.remove(id)) {
      expandedProjects.add(id);
      unawaited(loadDormant(id));
    }
    _saveSoon();
    _changed();
  }

  /// Projects whose "Closed (N)" row is open; every one starts collapsed and
  /// the choice is not saved.
  final closedOpenProjects = <String>{};

  void toggleClosed(String projectId) {
    if (!closedOpenProjects.remove(projectId)) {
      closedOpenProjects.add(projectId);
    }
    _changed();
  }

  /// Open decisions the reader set aside in their Buddy chat (Not now, Hide):
  /// saved on this computer for this reader, so they stay folded after a
  /// restart. A decision asked later is not among them, so it shows.
  final _decisionsAside = <String>{};
  Set<String> get decisionsAside => UnmodifiableSetView(_decisionsAside);

  void setDecisionsAside(Iterable<String> ids, {required bool aside}) {
    var changed = false;
    for (final id in ids) {
      changed |= aside ? _decisionsAside.add(id) : _decisionsAside.remove(id);
    }
    if (!changed) return;
    _saveSoon();
    _changed();
  }

  /// Forgets the set-aside decisions known answered or [gone], so the saved
  /// set holds only what may still wait.
  void forgetDecisionsAside(bool Function(String id) gone) {
    final before = _decisionsAside.length;
    _decisionsAside.removeWhere(gone);
    if (_decisionsAside.length != before) _saveSoon();
  }

  void toggleProjectsGroup() {
    projectsGroupOpen = !projectsGroupOpen;
    _saveSoon();
    _changed();
  }

  void toggleMachinesGroup() {
    machinesGroupOpen = !machinesGroupOpen;
    _saveSoon();
    _changed();
  }

  void toggleOfflineMachines() {
    offlineMachinesOpen = !offlineMachinesOpen;
    _saveSoon();
    _changed();
  }

  String get _path => '/api/super-tabs/${Uri.encodeComponent(tabId)}';
  SuperTabConversation? get selected => snapshot?.conversation(selectedId);
  bool get isOwner => snapshot?.ownerId == accountId;
  bool get canWrite =>
      !_disposed &&
      !accessRevoked &&
      (snapshot?.people.where((p) => p.id == accountId).firstOrNull?.canWrite ??
          false);
  bool get hasPendingAction => _pending != null;
  Map<String, dynamic>? get pendingCommand =>
      _pending == null ? null : superTabMap(_pending!['command']);
  String draft(String id) => _drafts[id] ?? '';

  /// The files waiting to go with the next message in a conversation. They
  /// stay in memory: only the text of a draft is saved.
  HarnessAttachments attachments(String id) => _attachments.putIfAbsent(id, () {
    final files = HarnessAttachments(
      limitBytes: kSuperTabAttachmentMaxBytes,
      limitFiles: kSuperTabAttachmentMaxFiles,
    );
    files.addListener(() {
      // Changing the files answers a refused upload.
      if (_uploadErrors.remove(id) != null) _changed();
      // Taking a chip off while its files go up gives the upload up.
      if (uploading &&
          _sending?.conversationId == id &&
          !files.files.toSet().containsAll(_sending!.files)) {
        cancelUpload();
      }
    });
    return files;
  });

  /// Whether [file] is still on its way to the backend in a send.
  bool isUploading(HarnessAttachment file) =>
      uploading && !_uploaded.containsKey(file);

  /// How much of [file] has gone up, from 0 to 1, while it is going up.
  double? uploadProgress(HarnessAttachment file) => _progress[file];

  SuperTabAgent? terminalAgent(String conversationId) {
    return terminalAgents(conversationId).firstOrNull;
  }

  List<SuperTabAgent> terminalAgents(String conversationId) {
    if (accessRevoked || devicesSelected) return const [];
    final id = _terminals[conversationId];
    final group = snapshot?.conversation(conversationId);
    if (id == null || group == null) return const [];
    return snapshot!.agents
        .where((agent) => group.agentIds.contains(agent.id))
        .toList();
  }

  void selectGroupTerminals(String conversationId) {
    if (_disposed ||
        accessRevoked ||
        snapshot?.conversation(conversationId) == null) {
      return;
    }
    _terminals[conversationId] = '*';
    _moveView();
    _saveSoon();
    _changed();
  }

  void selectTerminal(String conversationId, String? agentId) {
    if (_disposed || accessRevoked) return;
    if (agentId != null &&
        snapshot?.conversation(conversationId)?.agentIds.contains(agentId) !=
            true) {
      return;
    }
    if (_terminals[conversationId] == agentId && !devicesSelected) {
      return;
    }
    _moveView();
    if (agentId == null) {
      _terminals.remove(conversationId);
    } else {
      _terminals[conversationId] = agentId;
    }
    _saveSoon();
    _changed();
  }

  /// The original [messageId] of a reply in [id] whose page is not read:
  /// read by itself the first time it is asked for. Null until it is known;
  /// a record holding null when the conversation no longer has it.
  ({SuperTabMessage? message})? quoted(String id, String messageId) {
    final known = _quoted[id];
    if (known != null && known.containsKey(messageId)) {
      return (message: known[messageId]);
    }
    if (!(_quoting[id] ??= {}).containsKey(messageId)) {
      _quoting[id]![messageId] = 0;
      scheduleMicrotask(() => _readQuoted(id, messageId));
    }
    return null;
  }

  /// Whether the original [messageId] of [id] could not be read after every
  /// try, so it is told apart from one still being read.
  bool quoteGaveUp(String id, String messageId) =>
      (_quoting[id]?[messageId] ?? 0) >= _quoteTries;

  /// What the backend last said of each project's GitHub access (backend github/projectAccess.ts), and when.
  final Map<String, ({SuperTabProjectGitHub value, DateTime at})> _github = {};
  final Set<String> _githubReading = {};

  /// When each project's GitHub access was last asked for, answered or not: a failed read is not asked again on every
  /// rebuild either.
  final Map<String, DateTime> _githubAsked = {};

  /// Whether teammates' agents can push to [projectId]'s repository, as last read; null before a read, or from a
  /// server too old to say.
  SuperTabProjectGitHub? githubAccessOf(String projectId) =>
      _github[projectId]?.value;

  /// Reads [projectId]'s GitHub access, at most every 5 minutes; [refresh]: a person checks again (the server asks
  /// GitHub at once, at most every 15 seconds per repository). An older server has no such read: nothing is shown.
  Future<void> readGitHubAccess(
    String projectId, {
    bool refresh = false,
  }) async {
    final asked = _githubAsked[projectId];
    if (_disposed ||
        accessRevoked ||
        (!refresh &&
            asked != null &&
            clock.now().difference(asked) < const Duration(minutes: 5))) {
      return;
    }
    if (!_githubReading.add(projectId)) return;
    _githubAsked[projectId] = clock.now();
    try {
      final answer = await request(
        'GET',
        '$_path/projects/${Uri.encodeComponent(projectId)}/github${refresh ? '?refresh=1' : ''}',
      );
      _github[projectId] = (
        value: SuperTabProjectGitHub.fromJson(answer),
        at: clock.now(),
      );
      _changed();
    } catch (error) {
      appLog.debug('super-tabs', 'project GitHub access not read: $error');
      // A server without the route (an older backend) shows nothing, as before. Any other failure says it could not
      // check, and is asked again after 30 seconds, not 5 minutes: a Swarm read in its first seconds came back
      // empty and Project details showed no GitHub access at all (2026-10-28).
      final absent =
          error is SuperTabFailure &&
          (error.statusCode == 404 || error.code == 'NOT_FOUND');
      if (absent || _github[projectId] == null) {
        _github[projectId] = (
          value: SuperTabProjectGitHub.fromJson({
            'state': absent ? 'unavailable' : 'unread',
          }),
          at: clock.now(),
        );
      }
      if (!absent) {
        _githubAsked[projectId] = clock.now().subtract(
          const Duration(minutes: 5) - const Duration(seconds: 30),
        );
      }
      _changed();
    } finally {
      _githubReading.remove(projectId);
    }
  }

  /// Starts approving [projectId]'s repository for teammates' agents ([scope] `project`, or `swarm` for every project):
  /// the links that sign the person in to GitHub through the Harness GitHub App, or install it there first. GitHub sends
  /// them back to the backend, which checks they can push to the repository (backend github/approvals.ts).
  Future<({String authorizeUrl, String? installUrl})> approveGitHub(
    String projectId,
    String scope,
  ) async {
    final answer = await request(
      'POST',
      '$_path/projects/${Uri.encodeComponent(projectId)}/github/approve',
      body: {'scope': scope},
    );
    return (
      authorizeUrl: answer['authorizeUrl'] as String,
      installUrl: answer['installUrl'] as String?,
    );
  }

  /// Reads one message of [id] only: the backend checks the reader may read
  /// that conversation, as for its pages. A refusal is recorded as the message
  /// being gone; any other failure is read again after 3 s and 6 s, then left
  /// ([quoteGaveUp]).
  Future<void> _readQuoted(String id, String messageId) async {
    if (_disposed ||
        accessRevoked ||
        snapshot?.conversation(id) == null ||
        _quoting[id]?.containsKey(messageId) != true) {
      return;
    }
    try {
      final answer = await request(
        'GET',
        '${_messagesPath(id)}?messageId=${Uri.encodeComponent(messageId)}',
      );
      if (_disposed ||
          accessRevoked ||
          snapshot?.conversation(id) == null ||
          _quoting[id]?.containsKey(messageId) != true) {
        return;
      }
      final rows = (answer['messages'] as List)
          .map((m) => SuperTabMessage.fromJson(superTabMap(m)))
          .toList();
      if (rows.length > 1 ||
          rows.any((m) => m.id != messageId || m.conversationId != id)) {
        return;
      }
      // A row the list never lists is no original to quote either.
      (_quoted[id] ??= {})[messageId] = rows.where(_listed).firstOrNull;
      _changed();
    } catch (failure) {
      _quoteFailed(id, messageId, failure);
    }
  }

  void _quoteFailed(String id, String messageId, Object failure) {
    final asked = _quoting[id];
    if (_disposed || asked == null || !asked.containsKey(messageId)) return;
    if (failure is SuperTabFailure &&
        const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
      (_quoted[id] ??= {})[messageId] = null;
      _changed();
      return;
    }
    final tries = asked[messageId] = asked[messageId]! + 1;
    if (tries >= _quoteTries) {
      _changed();
      return;
    }
    late final Timer retry;
    retry = Timer(_quoteRetryAfter * tries, () {
      _quoteRetries.remove(retry);
      unawaited(_readQuoted(id, messageId));
    });
    _quoteRetries.add(retry);
  }

  /// [root]'s thread summary in conversation [id], once a page named it.
  SuperTabThread? thread(String id, String root) => _threads[id]?[root];

  /// Whether [thread] has a reply the reader has not seen, from someone else,
  /// in a thread they wrote in or were tagged in.
  bool threadUnread(SuperTabThread thread) {
    final last = thread.authors.firstOrNull;
    return thread.people.contains(accountId) &&
        thread.lastSequence > (_threadSeen[thread.id] ?? 0) &&
        !(last?['kind'] == 'person' && last?['id'] == accountId);
  }

  void _keepThreads(String id, Object? rows) {
    if (rows is! List) return;
    final held = _threads[id] ??= {};
    for (final row in rows) {
      final thread = SuperTabThread.fromJson(superTabMap(row));
      if ((held[thread.id]?.lastSequence ?? -1) > thread.lastSequence) continue;
      held[thread.id] = thread;
      // A thread first seen here is read as far as the conversation is:
      // replies the reader passed before threads were counted stay read.
      _threadSeen.putIfAbsent(
        thread.id,
        () => min(_readAt[id] ?? 0, thread.lastSequence),
      );
      if (openedThread?.root == thread.id) _seeThread(thread.id);
    }
  }

  void _seeThread(String root) {
    final open = openedThread;
    final last = max(
      (open == null ? null : _threads[open.conversationId]?[root])
              ?.lastSequence ??
          0,
      threadMessages(root).lastOrNull?.sequence ?? 0,
    );
    if ((_threadSeen[root] ?? 0) >= last) return;
    // Moved to the end: the newest marks are the ones a save keeps.
    _threadSeen.remove(root);
    _threadSeen[root] = last;
    _saveSoon();
  }

  /// The root and replies of [root]'s thread in the selected conversation,
  /// oldest first: what its own read brought, and replies polled since.
  List<SuperTabMessage> threadMessages(String root) {
    final id = openedThread?.conversationId ?? selectedId;
    final rows = {
      for (final m in _threadRows[root] ?? const <SuperTabMessage>[]) m.id: m,
      for (final m in _messages[id] ?? const <SuperTabMessage>[])
        if (m.thread == root) m.id: m,
    };
    return rows.values.toList()..sort(superTabMessageOrder);
  }

  /// The thread [messageId] is in, from the rows held of [id].
  String? _threadOf(String id, String? messageId) {
    if (messageId == null) return null;
    for (final m in [
      ..._messages[id] ?? const <SuperTabMessage>[],
      for (final rows in _threadRows.values) ...rows,
    ]) {
      if (m.id == messageId) return m.thread;
    }
    return null;
  }

  /// Forgets what was read of threads in conversations [keep] refuses (all,
  /// without it), as the transcript is forgotten when access goes.
  void _forgetThreads([bool Function(String conversationId)? keep]) {
    bool gone(String id) => keep == null || !keep(id);
    _threads.removeWhere((id, _) => gone(id));
    final roots = {
      for (final MapEntry(key: root, value: rows) in _threadRows.entries)
        if (rows.any((m) => gone(m.conversationId))) root,
    };
    _threadRows.removeWhere((root, _) => roots.contains(root));
    _threadBefore.removeWhere((root, _) => roots.contains(root));
    if (openedThread case final open? when gone(open.conversationId)) {
      openedThread = null;
    }
  }

  /// Whether [root]'s thread has replies before those read.
  bool hasEarlierReplies(String root) => _threadBefore.containsKey(root);
  bool readingEarlierReplies = false;

  /// Opens [root]'s thread of the selected conversation beside the chat.
  void openThread(String root) {
    if (accessRevoked) return;
    openedThread = (conversationId: selectedId, root: root);
    _seeThread(root);
    _changed();
    unawaited(loadThread());
  }

  void closeThread() {
    if (openedThread == null) return;
    openedThread = null;
    _changed();
  }

  String threadDraft(String root) => _threadDrafts[root] ?? '';
  void setThreadDraft(String root, String text) => _threadDrafts[root] = text;

  /// How many pages a thread reads when it opens; past them "Show earlier
  /// replies" reads on, a page at a time.
  static const threadPagesOnOpen = 5;

  /// Reads the open thread: from its newest reply back through
  /// [threadPagesOnOpen] pages, or with [earlier] the page before those read,
  /// and its root when no page brought it.
  Future<void> loadThread({bool earlier = false}) async {
    final open = openedThread;
    if (open == null || _disposed || accessRevoked) return;
    if (earlier && (!hasEarlierReplies(open.root) || readingEarlierReplies)) {
      return;
    }
    final path = _messagesPath(open.conversationId);
    final thread = Uri.encodeQueryComponent(open.root);
    // Still open, still readable: an answer that comes back after access went
    // or the thread closed is not kept.
    bool current() =>
        !_disposed &&
        !accessRevoked &&
        openedThread == open &&
        snapshot?.conversation(open.conversationId) != null;
    List<SuperTabMessage> rowsOf(Map<String, dynamic> page) => [
      for (final row in page['messages'] as List)
        if (SuperTabMessage.fromJson(superTabMap(row)) case final m
            when m.conversationId == open.conversationId &&
                m.thread == open.root)
          m,
    ];
    readingEarlierReplies = earlier;
    try {
      final rows = {
        if (earlier)
          for (final m in _threadRows[open.root] ?? const <SuperTabMessage>[])
            m.id: m,
      };
      Map<String, dynamic>? from = earlier ? _threadBefore[open.root] : null;
      Object? threads;
      for (var page = 0; page < (earlier ? 1 : threadPagesOnOpen); page++) {
        final answer = await request(
          'GET',
          from == null
              ? '$path?thread=$thread'
              : '$path?thread=$thread&before=${from['sequence']}&beforeId=${Uri.encodeQueryComponent(from['id'] as String)}',
        );
        if (!current()) return;
        threads ??= answer['threads'];
        for (final m in rowsOf(answer)) {
          rows[m.id] = m;
        }
        from = answer['next'] is Map ? superTabMap(answer['next']) : null;
        if (from == null) break;
      }
      // A long thread's pages read so far start after its root.
      if (!rows.containsKey(open.root) &&
          !(_messages[open.conversationId] ?? const []).any(
            (m) => m.id == open.root,
          )) {
        final root = await request(
          'GET',
          '$path?messageId=${Uri.encodeQueryComponent(open.root)}',
        );
        if (!current()) return;
        for (final m in rowsOf(root)) {
          if (m.id == open.root) rows[m.id] = m;
        }
      }
      _threadRows[open.root] = rows.values.toList();
      if (from == null) {
        _threadBefore.remove(open.root);
      } else {
        _threadBefore[open.root] = from;
      }
      _keepThreads(open.conversationId, threads);
      _seeThread(open.root);
      _changed();
    } catch (failure) {
      if (!current()) return;
      _readFailure(failure, revokeTab: false);
      _changed();
    } finally {
      if (earlier) readingEarlierReplies = false;
    }
  }

  /// Sends the open thread's draft to its root; [alsoSend] shows it in the
  /// main stream too.
  Future<Map<String, dynamic>?> sendThreadReply({bool alsoSend = false}) async {
    final open = openedThread;
    final text = threadDraft(open?.root ?? '').trim();
    if (open == null ||
        text.isEmpty ||
        selected == null ||
        selected!.archived ||
        !canWrite ||
        saving ||
        _pending != null) {
      return null;
    }
    final sending = command({
      'type': 'message.send',
      'conversationId': open.conversationId,
      'text': text,
      'replyTo': open.root,
      'recipientIds': const <String>[],
      if (alsoSend) 'alsoSend': true,
    });
    if (_pending != null) {
      _threadDrafts.remove(open.root);
      _changed();
    }
    return await sending;
  }

  List<SuperTabMessage> messages(String id) => List.unmodifiable(
    (_messages[id] ?? const <SuperTabMessage>[]).where(_listed),
  );

  static bool _listed(SuperTabMessage m) =>
      m.source['kind'] != 'update-request';

  /// "Reviewer: Ada · Ready: yes on 1a2b3c4d5". The verdict is the newest
  /// review group's for [group], as its Reviewer recorded it (its result or
  /// check evidence), else the newest `Ready:` message a reviewer of [group]
  /// posted in the loaded history. Null without a reviewer.
  String? reviewLine(SuperTabConversation? group) {
    final state = snapshot;
    if (group == null || state == null) return null;
    final reviews =
        state.conversations.where((c) => c.reviewOf == group.id).toList()
          ..sort((a, b) => (b.number ?? 0).compareTo(a.number ?? 0));
    final reviewers = {
      for (final r in [
        ...state.reviewers(group),
        for (final review in reviews) ...state.reviewers(review),
      ])
        r.id: r,
    }.values;
    if (reviewers.isEmpty) return null;
    final ids = {for (final r in reviewers) r.id};
    final recorded = reviews
        .expand(
          (review) => [
            review.assignment?['result'],
            for (final check in review.checks) check['evidence'],
          ],
        )
        .whereType<String>();
    final posted = messages(group.id).reversed
        .where((m) => m.fromAgent && ids.contains(m.authorId))
        .map((m) => m.text);
    final verdict = [
      ...recorded,
      ...posted,
    ].map(parseSuperTabVerdict).nonNulls.firstOrNull;
    final names = reviewers.map((r) => state.agentName(r.id)).join(', ');
    return 'Reviewer: $names · ${verdict?.label ?? 'No verdict yet'}';
  }

  bool hasOlder(String id) => _before[id] != null;

  /// Conversations whose reader is scrolled up ([readingBack]).
  final _readingBack = <String>{};

  /// Conversations with messages after the newest held that no read has
  /// brought yet ([hasNewer]).
  final _newer = <String>{};

  /// Conversations whose next read takes the latest page whole
  /// ([showLatest]).
  final _latestWanted = <String>{};

  /// How many pages joined below the rows of a reader scrolled up, by
  /// conversation.
  final _pagesBelow = <String, int>{};

  /// At most this many pages join below a reader scrolled up: past them the
  /// rest waits for [showLatest], so a long burst is not all held.
  static const _pagesBelowReader = 3;

  /// Whether [id]'s reader is scrolled up with all the pages that join below
  /// them held: the rest waits for [showLatest], so no poll reads it.
  bool _holding(String id) =>
      _readingBack.contains(id) &&
      _newer.contains(id) &&
      !_latestWanted.contains(id) &&
      (_pagesBelow[id] ?? 0) >= _pagesBelowReader;

  /// Forgets reading back in [id], or in every conversation.
  void _forgetNewer([String? id]) {
    for (final kept in [_readingBack, _newer, _latestWanted]) {
      id == null ? kept.clear() : kept.remove(id);
    }
    id == null ? _pagesBelow.clear() : _pagesBelow.remove(id);
  }

  /// The reader of [id] scrolled up, or back to its end. While they read
  /// back, a read that finds more than a page new keeps the rows they are
  /// reading and adds the next page below; [showLatest] reads the rest.
  void readingBack(String id, bool reading) =>
      reading ? _readingBack.add(id) : _readingBack.remove(id);

  /// Whether more messages came after the newest held than reads brought.
  bool hasNewer(String id) => _newer.contains(id);

  /// Brings [id]'s newest messages: when more are waiting than reads
  /// brought, the latest page replaces what is held; otherwise what came
  /// after it is read. Its own read: one already under way may have asked
  /// for less (the rows held below a reader scrolled up).
  Future<void> showLatest(String id) async {
    _readingBack.remove(id);
    for (
      var under = _reading[(id, false)];
      under != null;
      under = _reading[(id, false)]
    ) {
      await under;
    }
    if (_disposed) return;
    if (_newer.contains(id)) _latestWanted.add(id);
    await _readMessages(id);
  }

  /// At most this many older pages are read to reach a reader's read mark;
  /// past them the page just after the mark is read instead.
  static const _pagesToMark = 3;

  /// Whether [id]'s held messages reach back to [mark], or nothing older is
  /// left to read.
  bool heldBackTo(String id, int mark) {
    final held = _messages[id];
    return held == null ||
        held.isEmpty ||
        held.first.sequence <= mark ||
        !hasOlder(id);
  }

  /// Holds [id]'s messages back to the reader's [mark], so its first unread
  /// is among them: older pages while the mark is at most [_pagesToMark]
  /// pages back, else the page just after it alone, with the newer ones
  /// waiting for [showLatest] as under a reader scrolled up. Whether they
  /// reach it now; a read that failed throws, and nothing counts as read.
  /// A try again after one failed passes [olderPages] 0: the pages read the
  /// first time stay, and it goes straight to the page after the mark.
  Future<bool> loadBackTo(String id, int mark, {int? olderPages}) async {
    for (var page = 0; page < (olderPages ?? _pagesToMark); page++) {
      if (_disposed || heldBackTo(id, mark)) return heldBackTo(id, mark);
      await _readMessages(id, older: true);
    }
    if (_disposed || heldBackTo(id, mark)) return heldBackTo(id, mark);
    return _readAfterMark(id, mark);
  }

  /// Moves when a read back replaces what a conversation holds: a read of
  /// newer messages that set out before then would join across the gap.
  final _heldGeneration = <String, int>{};

  /// Replaces what [id] holds with the page just after [mark]; whether it
  /// did. A read of newer messages under way finishes first, and one that
  /// sets out meanwhile is dropped when it lands ([_heldGeneration]).
  Future<bool> _readAfterMark(String id, int mark) async {
    for (
      var under = _reading[(id, false)];
      under != null;
      under = _reading[(id, false)]
    ) {
      await under;
    }
    if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
      return false;
    }
    final answer = await request('GET', '${_messagesPath(id)}?after=$mark');
    if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
      return false;
    }
    final rows = answer['messages'] as List;
    final page = [
      for (final row in rows) SuperTabMessage.fromJson(superTabMap(row)),
    ]..sort(superTabMessageOrder);
    // Nothing after the mark: everything held is read.
    if (page.isEmpty) return true;
    if (page.any((m) => m.conversationId != id)) {
      throw const FormatException('A different conversation was returned.');
    }
    _heldGeneration[id] = (_heldGeneration[id] ?? 0) + 1;
    _rows.remove(id);
    _keepRows(id, rows);
    _messages[id] = page;
    _before[id] = SuperTabPage.of(page.first);
    if (answer['next'] != null) {
      _readingBack.add(id);
      _newer.add(id);
      _pagesBelow[id] = 1;
    }
    _viewVersion++;
    _changed();
    return true;
  }

  /// Each conversation's reaction counter as its last page said it.
  final _reactionSeq = <String, int>{};
  int _loadedMessageSequence(String id) =>
      _messages[id]?.reversed
          .where((m) => m.source['kind'] != 'update-request')
          .firstOrNull
          ?.sequence ??
      0;

  /// How far the reader has read [id]: the higher of the mark kept on the
  /// server, from any of their devices, and this device's own, which stands
  /// in while the server is out of reach.
  int readMark(String id) =>
      max(_readAt[id] ?? 0, snapshot?.readMarks[id] ?? 0);

  late final _serverMarks = SuperTabReadMarkSender(
    (id, sequence) => request(
      'POST',
      '$_path/conversations/${Uri.encodeComponent(id)}/read',
      body: {'sequence': sequence},
    ),
  );

  /// Whether [group] has a message in its main stream past the reader's
  /// mark. A reply only in its thread leaves the chat as it was: it lights its
  /// thread's reply line instead ([threadUnread]). The server's newest
  /// main-stream message covers a chat not held here; an older server's
  /// newest message, and the newest held, stand in for it.
  bool unread(SuperTabConversation group) =>
      max(
        group.lastMainSequence ?? group.lastMessageSequence,
        _messages[group.id]?.reversed
                .where(
                  (m) => m.source['kind'] != 'update-request' && m.inMainStream,
                )
                .firstOrNull
                ?.sequence ??
            0,
      ) >
      readMark(group.id);

  void start() {
    if (_disposed) return;
    _startedAt = _lastActivity = clock.now();
    unawaited(refresh());
    _schedule();
  }

  /// [after] is what is left of the poll once a read took the rest of it.
  void _schedule([Duration? after]) {
    _poll?.cancel();
    if (_disposed || updateRequired || pollInterval <= Duration.zero) return;
    if (!_policy.adapts) {
      _poll = Timer.periodic(_every, (_) {
        if (_pollDue) unawaited(refresh());
      });
      return;
    }
    if (accessRevoked || (_policy.pausesAway && _away)) return;
    final wait = after ?? _every;
    _poll = Timer(
      wait > Duration.zero ? wait : Duration.zero,
      () => unawaited(_tick()),
    );
  }

  /// One adaptive poll: the full read when it is due, else only the open
  /// conversation's new messages and its own unsettled receipt. The next one
  /// comes a poll after this one began, however long its answer took.
  Future<void> _tick() async {
    final began = clock.now();
    if (_pollDue) {
      // Told of a change: the whole Swarm, not only the open conversation.
      await (_fullReadDue || _toldMain || _toldMachine
          ? refresh()
          : _readMessages(selectedId, light: true));
    }
    _schedule(_every - clock.now().difference(began));
  }

  bool get _fullReadDue {
    final quiet = _policy.quietPoll;
    if (quiet == null || snapshot == null || _refreshFailing) return true;
    final now = clock.now();
    if (now.difference(_lastActivity) < _policy.quietAfter) return true;
    final last = _lastFullRead;
    return last == null || now.difference(last) >= quiet;
  }

  void _acted() => _lastActivity = clock.now();

  /// Drops the messages held of each conversation left [_keepLeft] ago.
  /// Kept for now: one being read, which would land on nothing and lose where
  /// earlier history continues, and one whose unread count its held messages
  /// give, which would read "1" until read again.
  void _dropLeft() {
    final now = clock.now();
    _leftAt.removeWhere((id, left) {
      if (id == selectedId) return true;
      final group = snapshot?.conversation(id);
      if (now.difference(left) < _keepLeft ||
          _reading.keys.any((read) => read.$1 == id) ||
          (group != null && unreadCount(group) > 1)) {
        return false;
      }
      _messages.remove(id);
      _rows.remove(id);
      _before.remove(id);
      _quoted.remove(id);
      _quoting.remove(id);
      _reactionSeq.remove(id);
      _forgetNewer(id);
      return true;
    });
  }

  void _keepRows(String id, List rows) {
    if (!_policy.drawsSaved) return;
    final kept = _rows[id] ??= {};
    for (final row in rows) {
      final map = superTabMap(row);
      kept[map['id'] as String] = map;
    }
  }

  /// The view to keep on this device ([SuperTabReading.drawsSaved]): the
  /// Swarm's parts as last read, with the cursor the next read starts at,
  /// and the open conversation's last page; or null.
  Map<String, dynamic>? get savedView {
    final parts = _parts, readAt = _partsReadAt;
    if (!_policy.drawsSaved ||
        parts == null ||
        readAt == null ||
        accessRevoked ||
        _showingSaved) {
      return null;
    }
    final id = selectedId;
    final shown = _messages[id] ?? const <SuperTabMessage>[];
    final page = shown.length > _savedPage
        ? shown.sublist(shown.length - _savedPage)
        : shown;
    final rows = [for (final message in page) ?_rows[id]?[message.id]];
    return {
      'format': superTabReadFormat,
      'savedAt': readAt.millisecondsSinceEpoch,
      'lastChangedAt': lastChangedAt,
      'parts': parts.toJson(),
      'conversationId': id,
      'messages': rows,
      'next': page.length < shown.length
          ? SuperTabPage.of(page.first).toJson()
          : _before[id]?.toJson(),
    };
  }

  /// A conversation's page as the backend reads it.
  static const _savedPage = 100;

  /// How long a saved view's cursor is good for: the backend keeps
  /// tombstones 7 days and reloads older cursors an hour before that.
  static const _savedFor = Duration(days: 6, hours: 23);

  /// Draws a [savedView] kept from an earlier visit while the first read is
  /// on its way, and holds its parts: the first read asks only for what
  /// changed since, and replaces it. With [SuperTabReading.confirmsSaved] it
  /// only holds them, for that read to draw. One for another Swarm, one too
  /// old for its cursor, one that no longer parses, or one after a read has
  /// landed or been refused, draws nothing.
  void drawSaved(Map<String, dynamic> view) {
    if (!_policy.drawsSaved ||
        accessRevoked ||
        snapshot != null ||
        stateReads > 0) {
      return;
    }
    try {
      if (view['format'] != superTabReadFormat) return;
      final savedAt = DateTime.fromMillisecondsSinceEpoch(
        (view['savedAt'] as num).toInt(),
      );
      if (clock.now().difference(savedAt) >= _savedFor) return;
      final parts = SuperTabParts.fromJson(superTabMap(view['parts']));
      final saved = SuperTabSnapshot.fromJson(parts.state);
      if (saved.id != tabId) return;
      final id = view['conversationId'];
      final rows = [
        for (final row in view['messages'] as List? ?? const [])
          superTabMap(row),
      ];
      final messages = rows.map(SuperTabMessage.fromJson).toList();
      final changedAt = (view['lastChangedAt'] as num).toInt();
      if (_policy.confirmsSaved) {
        // Held for the first read to start from, drawn once it answers; the
        // conversation it showed is read beside it.
        _parts = parts;
        _partsReadAt = savedAt;
        if (id == selectedId) _savedSelection = true;
        return;
      }
      snapshot = saved;
      lastChangedAt = changedAt;
      _parts = parts;
      _partsReadAt = savedAt;
      if (id == selectedId &&
          saved.conversation(id as String) != null &&
          messages.every((m) => m.conversationId == id)) {
        _messages[id] = messages..sort(superTabMessageOrder);
        _dropShownSends(id);
        _keepRows(id, rows);
        _before[id] = SuperTabPage.read(view['next']);
      }
      _showingSaved = true;
      loading = false;
      if (_startedAt != null) _changed();
    } on FormatException {
      _dropSaved();
    } on TypeError {
      _dropSaved();
    }
  }

  /// A view from an older shape: draw nothing, read as usual.
  void _dropSaved() {
    snapshot = null;
    lastChangedAt = -1;
    _parts = null;
    _partsReadAt = null;
    _messages.clear();
    _quoted.clear();
    _quoting.clear();
    _forgetThreads();
    _rows.clear();
    _before.clear();
  }

  /// A machine able to serve Swarm reads just connected: read now instead of
  /// at the next poll ([SuperTabReading.readsOnConnect]). Joins a read under way.
  Future<void> machineAvailable() {
    if (!_policy.readsOnConnect ||
        _disposed ||
        accessRevoked ||
        (_policy.pausesAway && _away)) {
      return Future.value();
    }
    return refresh();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// Open dialogs and native panes lose their content immediately, before
  /// account cleanup waits for an in-flight read or a draft write.
  void revokeAccess(String message) {
    if (_disposed) return;
    accessRevoked = true;
    devicesSelected = false;
    error = message;
    snapshot = null;
    _parts = null;
    _messages.clear();
    _forgetNewer();
    _quoted.clear();
    _quoting.clear();
    _forgetThreads();
    _sent.clear();
    _refused.clear();
    _poll?.cancel();
    _changed();
  }

  Map<String, dynamic> _localState() => {
    'tabId': tabId,
    'accountId': accountId,
    'selectedId': selectedId,
    'expandedProjects': expandedProjects.toList(),
    'expandedMachines': expandedMachines.toList(),
    'decisionsAside': _decisionsAside.toList(),
    'devicesSelected': devicesSelected,
    'projectsGroupOpen': projectsGroupOpen,
    'machinesGroupOpen': machinesGroupOpen,
    'offlineMachinesOpen': offlineMachinesOpen,
    'drafts': Map<String, String>.of(_drafts),
    'terminals': Map<String, String>.of(_terminals),

    'mentions': {
      for (final entry in _mentions.entries)
        entry.key: Map<String, String>.of(entry.value),
    },
    'readAt': Map<String, int>.of(_readAt),
    // ponytail: the newest 500 threads' marks; an older one forgotten shows
    // read again through the conversation's read mark ([_keepThreads]).
    'threadSeen': Map<String, int>.fromEntries(
      _threadSeen.entries.skip(max(0, _threadSeen.length - 500)),
    ),
    if (_pending != null) 'pending': _pending,
    if (_refused.isNotEmpty)
      'refused': {
        for (final MapEntry(:key, :value) in _refused.entries)
          key: [
            for (final refused in value)
              {
                'operationId': refused.operationId,
                'command': refused.command,
                'mentions': refused.mentions,
                'error': refused.error,
              },
          ],
      },
  };

  Future<void> _persist() {
    // Serial writes prevent an older autosave from restoring a resolved receipt.
    final next = _persisting
        .catchError((Object _) {})
        .then((_) => save(_localState()));
    _persisting = next;
    return next;
  }

  void _saveSoon() {
    _draftSave?.cancel();
    _draftSave = Timer(const Duration(milliseconds: 200), () {
      unawaited(
        _persist().catchError((Object _) {
          error = 'Could not save this draft on this computer.';
          _changed();
        }),
      );
    });
  }

  void setDraft(String conversationId, String value) {
    _acted();
    _drafts[conversationId] = value;
    _mentions[conversationId]?.removeWhere(
      (_, token) => !containsMention(value, token),
    );
    _saveSoon();
  }

  static bool containsMention(String text, String token) =>
      RegExp('(?:^|\\s)${RegExp.escape(token)}(?=\$|\\s|[.,!?;:])')
          .hasMatch(text);

  void mention(String conversationId, String agentId, String token) {
    if (containsMention(draft(conversationId), token)) {
      (_mentions[conversationId] ??= {})[agentId] = token;
      _saveSoon();
      _changed();
    }
  }

  /// What the reader sent to conversation [id] that its transcript does not
  /// hold yet, oldest first.
  List<SuperTabOutgoing> outgoing(String id) {
    final held = {for (final m in _messages[id] ?? const []) m.id};
    SuperTabOutgoing of(
      Map<String, dynamic> command,
      SuperTabOutgoingState state, {
      String? operationId,
      String? error,
    }) => SuperTabOutgoing(
      conversationId: id,
      text: command['text'] as String? ?? '',
      replyTo: command['replyTo'] as String?,
      thread: _threadOf(id, command['replyTo'] as String?),
      alsoSend: command['alsoSend'] == true,
      state: state,
      operationId: operationId,
      error: error,
    );
    final pending = _pending,
        command = pending == null
            ? const <String, dynamic>{}
            : superTabMap(pending['command']);
    return [
      for (final refused in _refused[id] ?? const <_Refused>[])
        of(
          refused.command,
          SuperTabOutgoingState.refused,
          operationId: refused.operationId,
          error: refused.error,
        ),
      for (final MapEntry(key: messageId, value: sent) in _sent.entries)
        if (sent['conversationId'] == id && !held.contains(messageId))
          of(sent, SuperTabOutgoingState.sending),
      // The backend names a person's message by its send's operation id, so
      // one read back while its answer was lost is not shown twice.
      if (command['type'] == 'message.send' &&
          command['conversationId'] == id &&
          !held.contains(pending!['operationId']))
        of(
          command,
          saving
              ? SuperTabOutgoingState.sending
              : SuperTabOutgoingState.unconfirmed,
          operationId: pending['operationId'] as String?,
        ),
    ];
  }

  /// Sends failed [message] again: one with no answer under its own receipt
  /// id, so it is posted once; a refused one as it was, tags and reply too.
  Future<Map<String, dynamic>?> retryOutgoing(SuperTabOutgoing message) async {
    if (message.state == SuperTabOutgoingState.unconfirmed) {
      return _pending?['operationId'] == message.operationId ? retry() : null;
    }
    if (saving || _pending != null) return null;
    final refused = _takeRefused(message);
    if (refused == null) return null;
    _sendingMentions[refused.operationId] = refused.mentions;
    _pending = {'operationId': refused.operationId, 'command': refused.command};
    return retry();
  }

  /// Removes failed [message] from its chat: a refused one, or one sent
  /// without an answer. The second may have arrived after all; then the next
  /// read shows it, once.
  void discardOutgoing(SuperTabOutgoing message) {
    final command = _pending == null
        ? const <String, dynamic>{}
        : superTabMap(_pending!['command']);
    final unconfirmed =
        message.state == SuperTabOutgoingState.unconfirmed &&
        !saving &&
        command['type'] == 'message.send' &&
        _pending!['operationId'] == message.operationId;
    if (!unconfirmed && _takeRefused(message) == null) return;
    if (unconfirmed) {
      _sendingMentions.remove(_pending!['operationId']);
      _pending = null;
    }
    operationError = null;
    operationErrorCode = null;
    unawaited(
      _persist().catchError((Object _) {
        error = 'Could not save this change on this computer.';
        _changed();
      }),
    );
    _changed();
  }

  Map<String, String> mentions(String conversationId) =>
      Map.unmodifiable(_mentions[conversationId] ?? const {});

  /// Makes conversation [id] part of [snapshot]: one not held (a closed
  /// group a link or Work details names) is read by id. False when it cannot
  /// be read.
  Future<bool> loadGroup(String id) async {
    if (snapshot == null) return false;
    if (snapshot!.conversation(id) != null) return true;
    final parts = _parts;
    try {
      if (parts == null || !await _readGroup(parts, id)) return false;
    } catch (failure) {
      _readFailure(failure, revokeTab: false);
      _changed();
      return false;
    }
    _redraw();
    return !_disposed && snapshot?.conversation(id) != null;
  }

  /// [projectId]'s conversations, open and closed, in the snapshot's order.
  List<SuperTabConversation> projectConversations(String projectId) =>
      _indexed()?.byProject[projectId] ?? const [];

  /// [snapshot]'s conversations by project, and each project's [buddyChat],
  /// worked out once per snapshot: the sidebar asks for them on every
  /// rebuild, and a snapshot is replaced, never changed, when the Swarm moves.
  ({
    SuperTabSnapshot of,
    Map<String, List<SuperTabConversation>> byProject,
    Map<String, SuperTabConversation> buddyChats,
  })?
  _index;

  ({
    SuperTabSnapshot of,
    Map<String, List<SuperTabConversation>> byProject,
    Map<String, SuperTabConversation> buddyChats,
  })?
  _indexed() {
    final snapshot = this.snapshot;
    if (snapshot == null) return null;
    if (_index case final index? when identical(index.of, snapshot)) {
      return index;
    }
    final byProject = <String, List<SuperTabConversation>>{};
    final buddyChats = <String, SuperTabConversation>{};
    for (final g in snapshot.conversations) {
      byProject.putIfAbsent(g.projectId, () => []).add(g);
      if (g.isBuddyChat && g.buddyOwnerId == accountId) {
        buddyChats.putIfAbsent(g.projectId, () => g);
      }
    }
    return _index = (
      of: snapshot,
      byProject: {
        for (final MapEntry(:key, :value) in byProject.entries)
          key: List.unmodifiable(value),
      },
      buddyChats: buddyChats,
    );
  }

  /// The signed-in person's chat with their Buddy in [projectId], where the
  /// PM's private lines to them land too: Buddies replaced Chat with PM in
  /// every Swarm (Ken, 10-29). It is there before any Buddy is
  /// ([openBuddyChat]), and stays after one is removed.
  SuperTabConversation? buddyChat(String projectId) =>
      _indexed()?.buddyChats[projectId];

  /// The signed-in person's Buddy in [projectId]; null when they have none.
  SuperTabAgent? buddy(String projectId) => snapshot?.agents
      .where(
        (a) => a.isBuddy && a.buddyOf == accountId && a.projectId == projectId,
      )
      .firstOrNull;

  /// The newest start of the reader's Buddy in [projectId]: under way while
  /// it has neither a harness nor an error, failed with an error.
  Map<String, dynamic>? buddyStart(String projectId) {
    // The index itself: the sidebar has asked [buddyChat] once already.
    final chat = _indexed()?.buddyChats[projectId]?.id;
    return snapshot?.buddyStarts.reversed.where((start) {
      final request = superTabMap(start['request']);
      return superTabMap(request['buddyOf'])['personId'] == accountId &&
          (request['projectId'] == projectId ||
              (chat != null && request['conversationId'] == chat));
    }).firstOrNull;
  }

  /// Adds the reader's Buddy in [projectId] on [machineId] with [engine], and
  /// opens its chat. False when refused: [operationError] says why.
  Future<bool> addBuddy({
    required String projectId,
    required String machineId,
    required String engine,
  }) async {
    final result = await command({
      'type': 'buddy.create',
      'projectId': projectId,
      'machineId': machineId,
      'engine': engine,
    });
    if (result == null) return false;
    final id = result['conversationId'];
    if (id is String) await select(id);
    return true;
  }

  /// Removes the reader's Buddy in [projectId]; its chat stays.
  Future<bool> removeBuddy(String projectId) async =>
      await command({'type': 'buddy.remove', 'projectId': projectId}) != null;

  /// Whether [group] is out of the app: there is no private channel to the
  /// PM (Ken, 10-29), so no private chat but a Buddy chat is listed or opened,
  /// the reader's old Chat with PM that an older server still sends included.
  bool hiddenByBuddies(SuperTabConversation group) =>
      group.audience != null && !group.isBuddyChat;

  /// Where opening conversation [id] lands: itself, unless the app hides it.
  String landsOn(String id) => _shownFor(id);

  /// Where conversation [id] opens: a chat [hiddenByBuddies] opens its
  /// project's chat, where the PM is talked to; any other opens itself.
  String _shownFor(String id) {
    final group = snapshot?.conversation(id);
    if (group == null || !hiddenByBuddies(group)) return id;
    return snapshot!.projects
            .where((p) => p.id == group.projectId)
            .firstOrNull
            ?.leadConversationId ??
        id;
  }

  /// How many of [group]'s messages from others came after the reader's read
  /// mark: exact once the messages held reach back to the mark
  /// ([_heldSinceRead]), else a lower bound, one at least, while more are read
  /// ([_readUnreadBuddyChats]).
  int unreadCount(SuperTabConversation group) {
    if (!unread(group)) return 0;
    final readAt = readMark(group.id);
    final count = messages(group.id)
        .where((m) => m.sequence > readAt && m.inMainStream && !isOwn(m))
        .length;
    return _heldSinceRead(group) ? count : max(count, 1);
  }

  /// Whether [m] is the reader's own: written by them, not by an agent or a
  /// terminal.
  bool isOwn(SuperTabMessage m) =>
      !m.fromAgent && !m.fromTerminal && m.authorId == accountId;

  /// Whether the messages held of [group] run from its read mark (or its
  /// first message) to its newest, update requests included.
  bool _heldSinceRead(SuperTabConversation group) {
    final held = _messages[group.id];
    if (held == null || held.isEmpty) return false;
    return held.last.sequence >= group.lastMessageSequence &&
        (held.first.sequence <= readMark(group.id) || !hasOlder(group.id));
  }

  /// The unread messages in the reader's own Buddy chats, the PM's private
  /// lines among them, for the Swarm badge.
  int get buddyUnread => [
    for (final project in snapshot?.projects ?? const <SuperTabProject>[])
      if (buddyChat(project.id) case final chat?) unreadCount(chat),
  ].fold(0, (a, b) => a + b);

  /// Reads each Buddy chat whose count is still open ([_countOpen]), page by
  /// page, so the count is exact up to [kCountCap]; nothing once every chat's
  /// count is known.
  void _readUnreadBuddyChats() {
    for (final project in snapshot?.projects ?? const <SuperTabProject>[]) {
      final chat = buddyChat(project.id);
      if (chat == null || !_countOpen(chat) || !_counting.add(chat.id)) {
        continue;
      }
      unawaited(
        _countChat(chat.id).whenComplete(() {
          _counting.remove(chat.id);
        }),
      );
    }
  }

  final _counting = <String>{};

  /// A Buddy chat off screen, unread, under [kCountCap] and not held back to its
  /// read mark: past the cap the badge says "99+" whatever the rest holds, so
  /// a device with no read mark never reads the whole history.
  bool _countOpen(SuperTabConversation chat) =>
      chat.id != selectedId &&
      unread(chat) &&
      unreadCount(chat) < kCountCap &&
      !_heldSinceRead(chat);

  /// Newer pages until the newest message is held, then older ones back to
  /// the read mark; stops when a read brings nothing (no more, or it failed:
  /// the next state read tries again).
  Future<void> _countChat(String id) async {
    while (!_disposed) {
      final chat = snapshot?.conversation(id);
      if (chat == null || !_countOpen(chat)) return;
      final held = _messages[id];
      final before = (held?.firstOrNull?.sequence, held?.lastOrNull?.sequence);
      final newer =
          held == null ||
          held.isEmpty ||
          held.last.sequence < chat.lastMessageSequence;
      await _readMessages(id, older: !newer, light: newer);
      final after = _messages[id];
      if ((after?.firstOrNull?.sequence, after?.lastOrNull?.sequence) ==
          before) {
        return;
      }
    }
  }

  /// The project of the conversation on screen, else the first one.
  String? get currentProjectId {
    final state = snapshot;
    if (state == null) return null;
    final selected = state.conversation(selectedId)?.projectId;
    return state.projects.any((p) => p.id == selected)
        ? selected
        : state.projects.firstOrNull?.id;
  }

  /// A tag or decision the menu bar asked to open ([openNotice]), until the
  /// Swarm view on screen takes it.
  ({String kind, String id})? noticeRequest;

  /// Opens the reader's tag (`mention`) at its message, or shows their
  /// decisions (`decision`) where they are answered, in the view on screen,
  /// or the one shown next.
  void openNotice(String kind, String id) {
    noticeRequest = (kind: kind, id: id);
    notifyListeners();
  }

  /// A message the reader asked to open by its link ([openMessageLink]), until
  /// the Swarm view on screen takes it.
  ({String conversationId, String messageId})? messageRequest;

  /// Asks the Swarm view to open [link]'s message, in the view on screen or
  /// the one shown next. A link to another Swarm is not this one's to open.
  bool openMessageLink(SwarmMessageLink link) {
    if (link.tabId != tabId) return false;
    messageRequest = (
      conversationId: link.conversationId,
      messageId: link.messageId,
    );
    notifyListeners();
    return true;
  }

  /// Conversations a link named that the Swarm did not hold, when each was
  /// last asked for by id (the backend decides who may read it) and which are
  /// being asked for now. A refusal is asked again after a minute, in case the
  /// reader has since been let in.
  final _linkGroupAsked = <String, DateTime>{};
  final _linkGroupReading = <String>{};
  static const _linkGroupRetry = Duration(minutes: 1);

  /// What [link] points at for this reader: null when it is not a message they
  /// may read (another Swarm, a conversation the backend will not give them, a
  /// message gone); `message` null while it is being read. A conversation the
  /// Swarm does not hold (a closed one) is asked for by id, once a minute at
  /// most, so a link reveals nothing the backend does not already let them read.
  ({SuperTabMessage? message})? linkTarget(SwarmMessageLink link) {
    final id = link.conversationId;
    if (link.tabId != tabId || accessRevoked || snapshot == null) return null;
    if (snapshot!.conversation(id) == null) {
      if (_linkGroupReading.contains(id)) return (message: null);
      final asked = _linkGroupAsked[id];
      if (asked != null && clock.now().difference(asked) < _linkGroupRetry) {
        return null;
      }
      _linkGroupAsked[id] = clock.now();
      _linkGroupReading.add(id);
      unawaited(
        loadGroup(id).whenComplete(() {
          _linkGroupReading.remove(id);
          _changed();
        }),
      );
      return (message: null);
    }
    // A chat the app hides (an old Chat with PM, with Buddies on) is not one
    // a link can open, so it is not previewed either.
    if (landsOn(id) != id) return null;
    final held = messages(id).where((m) => m.id == link.messageId).firstOrNull;
    final read = held != null ? (message: held) : quoted(id, link.messageId);
    // Still being read, unless every try failed.
    if (read == null) {
      return quoteGaveUp(id, link.messageId) ? null : (message: null);
    }
    final message = read.message;
    // A waiting notice is never announced, so it is not previewed either.
    return message == null || message.source['kind'] == 'delivery-hold'
        ? null
        : (message: message);
  }

  /// Set by the Swarm view on screen: opens a project's Buddy chat in front
  /// of whatever covers the conversation, Notifications or a terminal.
  Future<bool> Function(String projectId)? buddyChatOpener;

  /// Opens the [currentProjectId]'s Buddy chat, through the view on screen
  /// ([buddyChatOpener]) when there is one, else [openBuddyChat].
  Future<bool> openCurrentBuddyChat() async {
    final project = currentProjectId;
    return project != null && await (buddyChatOpener ?? openBuddyChat)(project);
  }

  /// Opens the reader's [buddyChat] in [projectId], opening it on the server
  /// first when they have none: every person has one in each project before
  /// any Buddy (backend buddy.chat), so the PM's private lines never drop.
  /// The request is one per person, membership and project, so a second click
  /// or another window gets the same chat back.
  Future<bool> openBuddyChat(String projectId) async {
    if (buddyChat(projectId) case final chat?) return select(chat.id);
    final me = snapshot?.people.where((p) => p.id == accountId).firstOrNull;
    final result = await command({
      'type': 'buddy.chat',
      'projectId': projectId,
    }, operationId: _buddyChatOperation(projectId, me?.generation));
    final id = result?['conversationId'];
    return id is String && await select(id);
  }

  String _buddyChatOperation(String projectId, String? generation) {
    final id = 'buddy-chat-$projectId-$accountId-${generation ?? ''}';
    // The backend's operation ids are at most 160 characters.
    return id.length > 160 ? id.substring(0, 160) : id;
  }

  /// Opens conversation [id], reading it first when it is not held
  /// ([loadGroup]); false when it cannot be read, or another was opened while
  /// it was.
  Future<bool> select(String id) async {
    final ask = ++_selectRequest;
    // A held group is selected at once, before this returns.
    if (snapshot?.conversation(id) == null) {
      if (!await loadGroup(id)) return false;
      // The reader moved on while this was read: it must not pull them back.
      if (ask != _selectRequest) return false;
    }
    id = _shownFor(id);
    if (id == selectedId && !devicesSelected) return true;
    _acted();
    final group = snapshot!.conversation(id)!;
    // A workgroup is shown under its project, so its project opens. A Buddy
    // chat has its own row under Buddies and leaves projects as they were.
    if (!snapshot!.isProjectLead(id) && !group.isBuddyChat) {
      expandedProjects.add(group.projectId);
      unawaited(loadDormant(group.projectId));
      if (group.closed) closedOpenProjects.add(group.projectId);
    }
    _moveView(to: id);
    openedThread = null;
    _viewVersion++;
    operationNotice = null;
    _saveSoon();
    _changed();
    unawaited(loadMessages(id));
    return true;
  }

  /// A visible transcript passes the boundary it displayed. The loaded messages
  /// are authoritative: snapshots can arrive either before or after their tail.
  void markRead(String id, {int? through}) {
    if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
      return;
    }
    final loaded = _loadedMessageSequence(id);
    final last = min(through ?? loaded, loaded);
    _serverMarks.mark(id, last, kept: snapshot?.readMarks[id] ?? 0);
    if ((_readAt[id] ?? 0) >= last) return;
    _readAt[id] = last;
    _saveSoon();
    _changed();
  }

  Future<void> refresh() {
    if (_disposed || accessRevoked || updateRequired) return Future.value();
    return _refreshing ??= _read().whenComplete(() {
      _refreshing = null;
      // A change heard while it was out: read on the next allowed read.
      if (_pushing) _readWhenAllowed();
    });
  }

  Future<void> _read() async {
    // An adapting read that changes nothing redraws nothing: on a phone each
    // redraw of the whole tab is a long frame, every poll.
    final quiet = _policy.adapts && snapshot != null;
    final before = _shown;
    var stateChanged = false;
    loading = snapshot == null;
    if (!quiet) _changed();
    _lastFullRead = clock.now();
    // Taken as the read starts: a push heard while it is out reads once more,
    // on the next allowed read, unless it repeats a time already told.
    final told = _toldMain || _toldMachine;
    _toldMain = _toldMachine = false;
    final took = Stopwatch()..start();
    // The open conversation's messages, asked for beside the state
    // ([SuperTabReading.messagesWithState]); dropped if the state moves the
    // selection elsewhere.
    final earlyId = selectedId;
    // Only when something may have happened: a first read, a saved view, a
    // push, a message waiting for its receipt. Otherwise the messages wait
    // for the state to say there is news (roadmap 2.5).
    final earlyQuery = told || !_messagesCurrent(earlyId)
        ? _earlyQuery(earlyId)
        : null;
    final early = earlyQuery == null
        ? null
        : (request('GET', '${_messagesPath(earlyId)}$earlyQuery')..ignore());
    // A conversation the state already has takes its answer as it comes, so
    // a reply shows without waiting for the state.
    final messagesRead = early != null && snapshot != null
        ? (_readMessages(earlyId, early: (query: earlyQuery!, page: early))
            ..ignore())
        : null;
    try {
      final heldSaved = _parts != null && stateReads == 0;
      final read = await _readParts();
      if (_disposed || accessRevoked) return;
      final stateMs = took.elapsedMilliseconds;
      final parts = _parts!;
      _refreshFailing = false;
      unreachableSince = null;
      _waitingForMachine = false;
      _graceEnd?.cancel();
      stateReads++;
      // How long the Swarm took to answer, and nothing it said: the log shows a slow or failing
      // backend, which the sidebar's ages and the machines' states otherwise only hint at.
      appLog.debug(
        'swarm',
        'state read in ${took.elapsedMilliseconds} ms '
            '(${read.full ? 'first load' : 'changes'}, last changed ${parts.lastChangedAt})',
      );
      // A part or a value worked out at read time (an agent seen down, a
      // limit that ran out) changed: the snapshot is built again. The first
      // read over a saved view wins, whatever it saved.
      final moved = read.changed || _showingSaved || snapshot == null;
      if (moved) {
        // A closed group named by the saved selection is read by id: a first
        // load has only the active groups.
        if (read.full && !parts.holdsGroup(selectedId)) {
          await _readGroup(parts, selectedId);
          if (_disposed || accessRevoked) return;
        }
        final raw = parts.state;
        if (_policy.adapts) {
          stateChanged = true;
          // A read mark moving is the page around the view: no new copy kept.
          if (!read.marksOnly) _viewVersion++;
        }
        final next = SuperTabSnapshot.fromJson(raw);
        if (next.id != tabId) {
          throw const FormatException('A different Swarm was returned.');
        }
        snapshot = next;
        final allowed = next.conversations.map((c) => c.id).toSet();
        // What this device keeps of a group goes with the group itself (a
        // tombstone), not when a read leaves it out: a closed group is out of
        // every first load and still has its drafts and read marks.
        final removed = read.removed;
        final localAccessChanged =
            !allowed.contains(selectedId) ||
            [
              ..._drafts.keys,
              ..._terminals.keys,
              ..._mentions.keys,
              ..._readAt.keys,
              ..._refused.keys,
            ].any(removed.contains) ||
            expandedProjects.any(
              (id) => !next.projects.any((project) => project.id == id),
            );
        _messages.removeWhere((id, _) => !allowed.contains(id));
        _quoted.removeWhere((id, _) => !allowed.contains(id));
        _quoting.removeWhere((id, _) => !allowed.contains(id));
        _forgetThreads(allowed.contains);
        _rows.removeWhere((id, _) => !allowed.contains(id));
        _drafts.removeWhere((id, _) => removed.contains(id));
        _attachments.removeWhere((id, files) {
          if (allowed.contains(id)) return false;
          files.dispose();
          return true;
        });
        _terminals.removeWhere((id, _) => removed.contains(id));
        _mentions.removeWhere((id, _) => removed.contains(id));
        _sent.removeWhere(
          (_, sent) => !allowed.contains(sent['conversationId']),
        );
        _refused.removeWhere((id, _) => removed.contains(id));
        _before.removeWhere((id, _) => !allowed.contains(id));
        _readAt.removeWhere((id, _) => removed.contains(id));
        expandedProjects.removeWhere(
          (id) => !next.projects.any((project) => project.id == id),
        );
        if (!allowed.contains(selectedId)) {
          selectedId = next.projects.firstOrNull?.leadConversationId ?? 'lead';
        }
        selectedId = _shownFor(selectedId);
        if (localAccessChanged) _saveSoon();
        // A new store holds no closed groups yet, nor one a saved view drew:
        // the open projects read theirs.
        if (read.full || stateReads == 1) {
          // A read for the parts before has nothing to give these.
          _dormantPages.clear();
          _dormantReads.clear();
          for (final project in expandedProjects) {
            unawaited(loadDormant(project));
          }
        }
      }
      // A first open draws its sidebar now, not once its chat answers.
      if (stateReads == 1) _changed();
      final sidebarMs = took.elapsedMilliseconds;
      lastChangedAt = parts.lastChangedAt;
      // Every state read, a quiet one too: a count a failed read left open is
      // finished; one that is known reads nothing.
      _dropLeft();
      _readUnreadBuddyChats();
      _partsReadAt = clock.now();
      error = null;
      // A state that moved nothing, over messages read at that very state,
      // has no news for the conversation: no read of it (roadmap 2.5).
      if (early != null ||
          !_messagesCurrent(selectedId) ||
          read.full ||
          read.changed) {
        await (selectedId == earlyId && messagesRead != null
            ? messagesRead
            : _readMessages(
                selectedId,
                early: selectedId == earlyId && early != null
                    ? (query: earlyQuery!, page: early)
                    : null,
              ));
      }
      if (stateReads == 1) {
        // Where a first open's time went, from the tab asking to the chat it shows.
        appLog.debug(
          'swarm',
          'first open: sidebar after $sidebarMs ms, chat after ${took.elapsedMilliseconds} ms '
              '(state read $stateMs ms, ${read.full ? 'first load' : 'changes since the saved view'}'
              '${heldSaved ? '' : ', no saved view'})',
        );
      }
      if (_showingSaved) {
        // Read now: the saved view, and its Updating line, give way.
        _showingSaved = false;
        stateChanged = true;
      }
    } catch (failure) {
      if (_inConnectGrace(failure)) {
        _waitingForMachine = true;
        _graceFailure = failure;
      } else {
        _waitingForMachine = false;
        _readFailure(failure);
      }
      if (!_disposed && !accessRevoked) {
        _refreshFailing = true;
        unreachableSince ??= DateTime.now();
      }
      // The kind and code of the failure, never its message: a refusal can quote what was sent.
      appLog.warn(
        'swarm',
        'state read failed after ${took.elapsedMilliseconds} ms: '
            '${failure is SuperTabFailure ? '${failure.code} (status ${failure.statusCode})' : failure.runtimeType}',
      );
    } finally {
      loading = _waitingForMachine;
      if (!quiet || stateChanged || _shown != before) _changed();
    }
  }

  /// One read of the Swarm's parts: changes since the cursor once a first load
  /// is held, else a first load. A reload answer, or a change read refused (the
  /// Swarm or the reader's access moved), reads in full at once.
  Future<({bool full, bool changed, bool marksOnly, Set<String> removed})>
  _readParts() async {
    final held = _parts;
    if (held != null) {
      try {
        final answer = await request(
          'GET',
          '$_path/changes?cursor=${Uri.encodeQueryComponent(held.cursor)}',
        );
        if (answer['reload'] != true) {
          final SuperTabPartsChange change;
          try {
            change = held.apply(answer);
          } catch (_) {
            // Half merged: the next read starts again from a first load.
            if (identical(_parts, held)) _parts = null;
            rethrow;
          }
          final refreshed = await _refreshStale(held);
          return (
            full: false,
            changed: change.changed || refreshed,
            marksOnly: change.readMarksOnly && !refreshed,
            removed: change.removedGroups,
          );
        }
      } on SuperTabFailure catch (failure) {
        if (!const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) rethrow;
      }
      _parts = null;
    }
    final parts = SuperTabParts.firstLoad(await request('GET', '$_path/parts'));
    if (parts.state['id'] != tabId) {
      throw const FormatException('A different Swarm was returned.');
    }
    _parts = parts;
    return (
      full: true,
      changed: true,
      marksOnly: false,
      removed: const <String>{},
    );
  }

  /// A stub says a held group closed, not how: its data is read again by id.
  /// Best effort, after the change read is merged: a failed read leaves the
  /// group as it was and is tried at the next read; only an update answer
  /// stops the tab. True when a group's data was read.
  Future<bool> _refreshStale(SuperTabParts parts) async {
    var read = false;
    for (final id in parts.staleGroups) {
      try {
        if (await _readGroup(parts, id)) {
          read = true;
        } else {
          // Gone or no longer the reader's: its tombstone or a reload follows.
          parts.forgetStale(id);
        }
      } catch (failure) {
        if (_isUpdateRequired(failure)) rethrow;
        appLog.warn(
          'swarm',
          'closed group read failed: '
              '${failure is SuperTabFailure ? '${failure.code} (status ${failure.statusCode})' : failure.runtimeType}',
        );
      }
    }
    return read;
  }

  /// Reads group [id] by id into [parts], active or closed (section 4.5).
  /// False when the reader cannot read it (gone, or no longer theirs).
  Future<bool> _readGroup(SuperTabParts parts, String id) async {
    try {
      final answer = await request(
        'GET',
        '$_path/groups/${Uri.encodeComponent(id)}',
      );
      if (!identical(parts, _parts) && _parts != null) return false;
      parts.addDormant([answer['group']]);
      return true;
    } on SuperTabFailure catch (failure) {
      if (const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) return false;
      rethrow;
    }
  }

  /// The closed groups read for each project: where the next earlier page
  /// starts, null when there is none. A project not here has not been read.
  final _dormantPages = <String, String?>{};
  final _dormantReads = <String, Future<void>>{};

  /// Whether [projectId]'s closed groups have been read.
  bool dormantLoaded(String projectId) => _dormantPages.containsKey(projectId);

  /// Whether a read of [projectId]'s closed groups is under way.
  bool dormantLoading(String projectId) => _dormantReads.containsKey(projectId);

  /// Whether [projectId] has closed groups older than those read.
  bool hasEarlierDormant(String projectId) => _dormantPages[projectId] != null;

  /// Reads [projectId]'s closed groups, newest first, a page at a time: the
  /// first page once, [earlier] the next one. Joins a read under way.
  Future<void> loadDormant(String projectId, {bool earlier = false}) {
    if (_disposed || accessRevoked || _parts == null) return Future.value();
    if (_dormantReads[projectId] case final reading?) return reading;
    if (earlier ? !hasEarlierDormant(projectId) : dormantLoaded(projectId)) {
      return Future.value();
    }
    _changed();
    late final Future<void> reading;
    reading = _readDormant(projectId, earlier).whenComplete(() {
      if (identical(_dormantReads[projectId], reading)) {
        _dormantReads.remove(projectId);
      }
      _changed();
    });
    return _dormantReads[projectId] = reading;
  }

  Future<void> _readDormant(String projectId, bool earlier) async {
    final parts = _parts!;
    final before = earlier ? _dormantPages[projectId] : null;
    try {
      final answer = await request(
        'GET',
        '$_path/groups?dormant=1&projectId=${Uri.encodeQueryComponent(projectId)}'
            '${before == null ? '' : '&before=${Uri.encodeQueryComponent(before)}'}',
      );
      if (_disposed || accessRevoked || !identical(parts, _parts)) return;
      final change = parts.addDormant(answer['groups'] as List);
      _dormantPages[projectId] = answer['next'] as String?;
      // Nothing new read changes nothing drawn, nor the view kept.
      if (change.changed) _redraw();
    } catch (failure) {
      if (_isUpdateRequired(failure)) {
        _requireUpdate();
        return;
      }
      // Not read: the next open of the list asks again.
      appLog.warn(
        'swarm',
        'closed groups read failed: '
            '${failure is SuperTabFailure ? '${failure.code} (status ${failure.statusCode})' : failure.runtimeType}',
      );
    }
  }

  /// Builds the snapshot again from the parts held, after a read on demand.
  void _redraw() {
    final parts = _parts;
    if (parts == null || snapshot == null) return;
    snapshot = SuperTabSnapshot.fromJson(parts.state);
    _viewVersion++;
    _changed();
  }

  /// What a state read can change on screen, beside the messages.
  ({int lastChangedAt, String? error, bool failing, bool revoked, bool loading})
  get _shown => (
    lastChangedAt: lastChangedAt,
    error: error,
    failing: _refreshFailing,
    revoked: accessRevoked,
    loading: loading,
  );

  /// A first read that found no machine connected, before the grace
  /// ([SuperTabReading.connectGrace]) runs out: its error waits for the grace.
  bool _inConnectGrace(Object failure) {
    final since = _startedAt;
    if (stateReads > 0 ||
        since == null ||
        failure is! SuperTabFailure ||
        failure.code != 'MACHINE_UNAVAILABLE') {
      return false;
    }
    final left = _policy.connectGrace - clock.now().difference(since);
    if (left <= Duration.zero) return false;
    _graceEnd ??= Timer(left, () {
      if (_disposed || !_waitingForMachine) return;
      _waitingForMachine = false;
      _readFailure(_graceFailure!);
      loading = false;
      _changed();
    });
    return true;
  }

  /// The same messages with the same receipts: posted text does not change.
  /// Whether [answer] says a reaction changed in [id] since its rows were
  /// last refreshed: a poll then reads the page shown again (backend
  /// reactions.ts). The first answer only records where it stands.
  bool _reactionsMoved(String id, Map<String, dynamic> answer) {
    final seq = answer['reactionSeq'];
    final known = _reactionSeq[id];
    return seq is int && known != null && known != seq;
  }

  static bool _sameMessages(
    List<SuperTabMessage>? shown,
    List<SuperTabMessage> next,
  ) {
    if (shown == null || shown.length != next.length) return false;
    for (var i = 0; i < next.length; i++) {
      final a = shown[i], b = next[i];
      if (a.id != b.id ||
          a.deliveries.length != b.deliveries.length ||
          !_sameReactions(a.reactions, b.reactions)) {
        return false;
      }
      for (var j = 0; j < b.deliveries.length; j++) {
        if (!mapEquals(a.deliveries[j], b.deliveries[j])) return false;
      }
    }
    return true;
  }

  static bool _sameReactions(
    List<SuperTabReactionCount> a,
    List<SuperTabReactionCount> b,
  ) =>
      a.length == b.length &&
      [
        for (var i = 0; i < a.length; i++)
          a[i].emoji == b[i].emoji &&
              listEquals(
                [for (final who in a[i].by) '${who.kind}:${who.id}'],
                [for (final who in b[i].by) '${who.kind}:${who.id}'],
              ),
      ].every((same) => same);

  String _messagesPath(String id) =>
      '$_path/conversations/${Uri.encodeComponent(id)}/messages';

  /// What a read of [id]'s messages asks for: the page before the oldest
  /// shown, what came after the newest, or the latest page.
  String _query(String id, {bool older = false}) {
    if (older) {
      final page = _before[id]!;
      return '?before=${page.sequence}&beforeId=${Uri.encodeQueryComponent(page.id)}';
    }
    // A saved page may be stale in its receipts as well as short of new
    // messages: the first read after it takes the latest page whole.
    if (_showingSaved || _latestWanted.contains(id)) return '';
    final tail = _messages[id]?.lastOrNull?.sequence;
    // Holding: the rows shown, for their receipts and reactions.
    if (tail != null && _holding(id)) return '?before=${tail + 1}';
    return tail != null ? '?after=$tail' : '';
  }

  /// The state's last change when [id]'s newest messages were read: while the
  /// state has not moved past it, nothing new can be in the conversation.
  final _messagesAt = <String, int>{};

  /// [id]'s messages are as new as the state held, and nothing outside the
  /// state is waited for: no receipt, no saved page, no newer page asked for.
  bool _messagesCurrent(String id) =>
      _policy.messagesWhenChanged &&
      !_showingSaved &&
      snapshot != null &&
      _messages[id] != null &&
      _messagesAt[id] == lastChangedAt &&
      !_holding(id) &&
      !_latestWanted.contains(id) &&
      !_receiptOpen(id);

  /// The query of [id]'s messages read to start beside a state read, or null.
  /// On first open only for the conversation the saved state named; after
  /// that, for a conversation the state has and no read of it under way.
  String? _earlyQuery(String id) {
    if (!_policy.messagesWithState || _reading.containsKey((id, false))) {
      return null;
    }
    final known = snapshot == null
        ? _savedSelection
        : snapshot!.conversation(id) != null;
    return known ? _query(id) : null;
  }

  /// A refusal that says this build is too old for the backend.
  static bool _isUpdateRequired(Object failure) =>
      failure is SuperTabFailure &&
      (failure.statusCode == 426 ||
          (failure.code == 'UPDATE_REQUIRED' && failure.statusCode != 400));

  /// Says to update Harness and stops the poll: no read can succeed now.
  void _requireUpdate() {
    updateRequired = true;
    error = updateMessage;
    _poll?.cancel();
  }

  void _readFailure(Object failure, {bool revokeTab = true}) {
    if (_disposed) return;
    if (_isUpdateRequired(failure)) return _requireUpdate();
    error = failure is SuperTabFailure
        ? failure.message
        : 'Could not refresh this conversation. Try again.';
    if (revokeTab &&
        failure is SuperTabFailure &&
        const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
      accessRevoked = true;
      devicesSelected = false;
      snapshot = null;
      _parts = null;
      _messages.clear();
      _forgetNewer();
      _quoted.clear();
      _quoting.clear();
      _forgetThreads();
      _poll?.cancel();
    }
  }

  /// Joins a read of [id] in the same direction already under way, so a
  /// caller can wait for it.
  Future<void> loadMessages(String id, {bool older = false}) {
    if (older) _acted();
    return _readMessages(id, older: older);
  }

  /// [light] asks only for new messages (and the person's own unsettled
  /// receipt), not the page again; [early] is a read already asked for.
  Future<void> _readMessages(
    String id, {
    bool older = false,
    bool light = false,
    _EarlyRead? early,
  }) => _reading[(id, older)] ??=
      _loadMessages(id, older: older, light: light, early: early).whenComplete(
        () {
          // A block: whenComplete would wait on the removed future, itself.
          _reading.remove((id, older));
        },
      );

  Future<void> _loadMessages(
    String id, {
    required bool older,
    bool light = false,
    _EarlyRead? early,
  }) async {
    if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
      return;
    }
    if (older && !hasOlder(id)) return;
    // A light check asks only for new messages, which wait while holding.
    if (light && _holding(id)) return;
    final generation = _heldGeneration[id];
    // What the Swarm's state had said when this read was asked for.
    final stateAt = lastChangedAt;
    // What [id] held was replaced while newer messages were on their way.
    bool replaced() => !older && _heldGeneration[id] != generation;
    try {
      final known = _messages[id];
      final tail = known != null && known.isNotEmpty
          ? known.last.sequence
          : null;
      final holding = !older && _holding(id);
      final query = _query(id, older: older);
      final latest = !older && _latestWanted.remove(id);
      final from = _before[id];
      final first = early != null && early.query == query ? early.page : null;
      var answer = first != null
          ? await first.catchError(
              (Object _) => request('GET', '${_messagesPath(id)}$query'),
            )
          : await request('GET', '${_messagesPath(id)}$query');
      final arrived =
          !older &&
          !holding &&
          tail != null &&
          (answer['messages'] as List).isNotEmpty;
      final reacted = !older && _reactionsMoved(id, answer);
      // Recorded only once the rows are refreshed: a read that fails leaves
      // the change for the next poll.
      final reactionSeq = older ? null : answer['reactionSeq'];
      // More than a page arrived after the newest held (back from another
      // conversation, or from sleep): the page after it would show messages
      // from hours ago as the newest. The latest page replaces what is held,
      // unless the reader is scrolled up: their rows stay, the page joins
      // below them, and the rest waits for [showLatest].
      final skipped = query.startsWith('?after=') && answer['next'] != null;
      final keepPlace = skipped && _readingBack.contains(id);
      if (!_disposed && skipped && !keepPlace) {
        answer = await request('GET', _messagesPath(id));
      } else if (!_disposed && keepPlace) {
        // A changed reaction refreshes the page ending at the newest held:
        // the latest page, under rows read back, would leave a gap.
        final shown = reacted
            ? (await request(
                    'GET',
                    '${_messagesPath(id)}?before=${tail! + 1}',
                  ))['messages']
                  as List
            : const [];
        answer = {
          ...answer,
          'messages': [...shown, ...answer['messages'] as List],
        };
      } else if (!_disposed &&
          !older &&
          (!light || reacted) &&
          tail != null &&
          (answer['messages'] as List).isEmpty) {
        // No new text: refresh delivery receipts in the page already shown,
        // and on a light read the counts of a reaction that changed there.
        answer = await request(
          'GET',
          '$_path/conversations/${Uri.encodeComponent(id)}/messages?before=${tail + 1}',
        );
      } else if (!_disposed && reacted && arrived) {
        // New messages and a changed reaction at once: the rows already shown
        // need their counts too, so the latest page is read with the new ones.
        final page = await request('GET', _messagesPath(id));
        answer = {
          ...answer,
          'messages': [
            ...page['messages'] as List,
            ...answer['messages'] as List,
          ],
        };
      }
      if (_disposed ||
          accessRevoked ||
          snapshot?.conversation(id) == null ||
          replaced()) {
        return;
      }
      // A read replacing the saved page moved where earlier continues while
      // this page was on its way: under the new page it would leave a gap.
      // Read on from where earlier continues now.
      if (older &&
          (_before[id]?.sequence != from?.sequence ||
              _before[id]?.id != from?.id)) {
        return await _loadMessages(id, older: true);
      }
      final incoming = (answer['messages'] as List)
          .map((m) => SuperTabMessage.fromJson(superTabMap(m)))
          .toList();
      if (incoming.any((m) => m.conversationId != id)) {
        throw const FormatException('A different conversation was returned.');
      }
      // The first read over a saved page replaces it: merged, the saved
      // page would leave a gap when more than a page arrived since.
      final replacing =
          (_showingSaved || latest || (skipped && !keepPlace)) && !older;
      if (replacing) _rows.remove(id);
      _keepRows(id, answer['messages'] as List);
      _keepThreads(id, answer['threads']);
      final combined = {
        if (!replacing)
          for (final m in _messages[id] ?? <SuperTabMessage>[]) m.id: m,
        for (final m in incoming) m.id: m,
      };
      final own = combined.values
          .where(
            (m) => !m.fromAgent && !m.fromTerminal && m.authorId == accountId,
          )
          .fold<SuperTabMessage?>(
            null,
            (latest, m) =>
                latest == null || m.sequence > latest.sequence ? m : latest,
          );
      if (!older &&
          own != null &&
          own.deliveries.isNotEmpty &&
          own.deliveries.any(
            (d) => !const {
              'answered',
              'cancelled',
              'superseded',
            }.contains(d['status']),
          ) &&
          !incoming.any((m) => m.id == own.id)) {
        // New replies (or a long stream of agent updates) otherwise leave the
        // original row outside this page and its inline receipt stuck at Sent.
        final receipt = await request(
          'GET',
          '$_path/conversations/${Uri.encodeComponent(id)}/messages?messageId=${Uri.encodeComponent(own.id)}',
        );
        if (_disposed ||
            accessRevoked ||
            snapshot?.conversation(id) == null ||
            replaced()) {
          return;
        }
        final rows = (receipt['messages'] as List)
            .map((m) => SuperTabMessage.fromJson(superTabMap(m)))
            .toList();
        if (rows.length > 1 ||
            rows.any((m) => m.id != own.id || m.conversationId != id)) {
          throw const FormatException(
            'A different message receipt was returned.',
          );
        }
        for (final row in rows) {
          combined[row.id] = row;
        }
        _keepRows(id, receipt['messages'] as List);
      }
      // An older page read meanwhile (during the receipt read above) stays:
      // what is held now, under what this read brought.
      if (!replacing) {
        for (final m in _messages[id] ?? <SuperTabMessage>[]) {
          combined.putIfAbsent(m.id, () => m);
        }
      }
      final sorted = combined.values.toList()..sort(superTabMessageOrder);
      // Past the cap the oldest rows go, where earlier history continues;
      // never under a reader scrolled up, nor from an older page they asked
      // for, nor from where the view lays its list out.
      final floor = _cutBefore[id];
      final below = floor == null
          ? -1
          : sorted.indexWhere((m) => superTabMessageOrder(m, floor) >= 0);
      final cut = older || _readingBack.contains(id)
          ? 0
          : max(
              0,
              min(
                sorted.length - _heldMessages,
                below < 0 ? sorted.length : below,
              ),
            );
      final next = cut > 0 ? sorted.sublist(cut) : sorted;
      // An adapting read that found nothing new changes nothing on screen.
      final same = _policy.adapts && _sameMessages(_messages[id], next);
      _messages[id] = next;
      if (keepPlace) {
        _newer.add(id);
        _pagesBelow[id] = (_pagesBelow[id] ?? 0) + 1;
      } else if (!older && !holding) {
        _newer.remove(id);
        _pagesBelow.remove(id);
      }
      _dropShownSends(id);
      if (reactionSeq is int) _reactionSeq[id] = reactionSeq;
      if (!older && !holding) _messagesAt[id] = stateAt;
      if (older || replacing || !_before.containsKey(id)) {
        _before[id] = SuperTabPage.read(answer['next']);
      }
      if (cut > 0) {
        _before[id] = SuperTabPage.of(next.first);
        final kept = {for (final m in next) m.id};
        _rows[id]?.removeWhere((messageId, _) => !kept.contains(messageId));
      }
      // Something new in the conversation on screen keeps the full poll.
      if (arrived && id == selectedId) _acted();
      if (!same) {
        if (id == selectedId) _viewVersion++;
        _changed();
      }
    } catch (failure) {
      // The state read waits for a machine within the grace: so do these.
      if (!_inConnectGrace(failure)) _readFailure(failure, revokeTab: false);
      if (failure is SuperTabFailure &&
          const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        _messages.remove(id);
        _forgetNewer(id);
        _quoted.remove(id);
        _quoting.remove(id);
        unawaited(refresh());
      }
      _changed();
    }
  }

  /// Sends [command] once, under [operationId] when the caller fixes one so
  /// that a repeat is the same request (a new one by default).
  Future<Map<String, dynamic>?> command(
    Map<String, dynamic> command, {
    String? operationId,
  }) async {
    if (_disposed || !_maySend(command) || saving || _pending != null) {
      return null;
    }
    _acted();
    _pending = {
      'operationId': operationId ?? superTabOperationId(),
      'command': Map<String, dynamic>.of(command),
    };
    return retry();
  }

  Future<Map<String, dynamic>?> retry() async {
    final pending = _pending;
    if (_disposed ||
        saving ||
        pending == null ||
        !_maySend(superTabMap(pending['command']))) {
      return null;
    }
    saving = true;
    operationError = null;
    operationErrorCode = null;
    operationNotice = null;
    _changed();
    try {
      // The receipt ID reaches durable local storage before the request can reach the server.
      await _persist();
      if (_disposed) return null;
      final answer = await request('POST', '$_path/commands', body: pending);
      if (_disposed) return null;
      final result = superTabMap(answer['result']);
      final command = superTabMap(pending['command']);
      final notice = result['credentialNotice'];
      operationNotice = notice is String && notice.isNotEmpty ? notice : null;
      if (command['type'] == 'message.send') {
        final id = command['conversationId'] as String;
        _sendingMentions.remove(pending['operationId']);
        // Shown as sending until the transcript holds it, so it never leaves
        // the chat between the answer and the read that brings it.
        _sent[result['messageId'] as String? ??
                pending['operationId'] as String] =
            command;
        if (_drafts[id]?.trim() == command['text']) {
          _drafts.remove(id);
          _mentions.remove(id);
        }
        // Only what went with this message: more may have been added since.
        final sent = command['attachmentIds'];
        if (sent is List) {
          for (final entry in _uploaded.entries.toList()) {
            if (sent.contains(entry.value)) {
              _attachments[id]?.remove(entry.key);
              _uploaded.remove(entry.key);
            }
          }
        }
      }
      if (command['type'] == 'conversation.create' &&
          result['conversationId'] is String) {
        // A successful create selects its confirmed destination even when the
        // following read is offline. Never leave the old group's composer active.
        _moveView(to: result['conversationId'] as String);
      }
      _pending = null;
      try {
        await _persist();
      } catch (_) {
        _pending = pending;
        rethrow;
      }
      // What the command wrote is in the next change read.
      await refresh();
      return result;
    } catch (failure) {
      if (!_disposed && _isUpdateRequired(failure)) {
        _requireUpdate();
        operationError = updateMessage;
        operationErrorCode = 'UPDATE_REQUIRED';
        // Refused by the backend: nothing was done, nothing to retry.
        _refuse(pending, operationError!);
        _pending = null;
        try {
          await _persist();
        } catch (_) {
          _pending = pending;
        }
      } else if (!_disposed) {
        operationError = failure is SuperTabFailure
            ? failure.message
            : 'The action is not confirmed. Retry to check it.';
        operationErrorCode = failure is SuperTabFailure ? failure.code : null;
        if (failure is SuperTabFailure &&
            failure.statusCode >= 400 &&
            failure.statusCode < 500 &&
            !const {408, 429}.contains(failure.statusCode)) {
          // A definitive rejection made no change. Keep the message for the
          // person to correct; a lost reply retains its exact receipt ID.
          _refuse(pending, operationError!);
          _pending = null;
          try {
            await _persist();
          } catch (_) {
            _pending = pending;
          }
        }
        if (failure is SuperTabFailure &&
            const {
              'FORBIDDEN',
              'NOT_FOUND',
              'READ_ONLY',
            }.contains(failure.code)) {
          await refresh();
        }
      }
      return null;
    } finally {
      saving = false;
      _changed();
    }
  }

  /// Keeps a refused [pending] message, with its tags, for Retry.
  void _refuse(Map<String, dynamic> pending, String error) {
    final command = superTabMap(pending['command']);
    final mentions = _sendingMentions.remove(pending['operationId']);
    if (command['type'] != 'message.send') return;
    (_refused[command['conversationId'] as String] ??= []).add((
      operationId: pending['operationId'] as String,
      command: command,
      mentions: mentions ?? const {},
      error: error,
    ));
  }

  /// Removes refused [message] from what is kept, and returns it.
  _Refused? _takeRefused(SuperTabOutgoing message) {
    if (message.state != SuperTabOutgoingState.refused) return null;
    final kept = _refused[message.conversationId];
    final i =
        kept?.indexWhere((r) => r.operationId == message.operationId) ?? -1;
    if (i < 0) return null;
    final refused = kept!.removeAt(i);
    if (kept.isEmpty) _refused.remove(message.conversationId);
    return refused;
  }

  /// Drops the sends the transcript of [id] holds now.
  void _dropShownSends(String id) {
    final held = {for (final m in _messages[id] ?? const []) m.id};
    _sent.removeWhere((messageId, _) => held.contains(messageId));
  }

  bool _maySend(Map<String, dynamic> command) =>
      canWrite ||
      (!accessRevoked &&
          snapshot != null &&
          command['type'] == 'member.remove' &&
          command['userId'] == accountId);

  /// Sends the selected conversation's draft. [onSending] is told when the
  /// message is on its way and shows in [outgoing].
  Future<Map<String, dynamic>?> send({
    String? replyTo,
    List<String> recipients = const [],
    VoidCallback? onSending,
  }) async {
    final text = draft(selectedId).trim();
    final files = attachments(selectedId).files;
    if ((text.isEmpty && files.isEmpty) ||
        selected == null ||
        selected!.archived ||
        !canWrite ||
        uploading ||
        saving ||
        _pending != null) {
      return null;
    }
    // A tag the text still says: an agent's is a recipient, a person's a tag.
    final said = mentions(selectedId).entries
        .where((entry) => containsMention(text, entry.value))
        .map((entry) => entry.key);
    bool isPerson(String id) => snapshot?.people.any((p) => p.id == id) == true;
    final tagged = said.where(isPerson).toList();
    final addressed = recipients.isEmpty
        ? said.where((id) => !isPerson(id)).toList()
        : recipients;
    if (addressed.any((id) => !selected!.agentIds.contains(id))) {
      operationError = 'A mentioned agent is no longer in this conversation. Remove its mention or choose another agent.';
      _changed();
      return null;
    }
    final conversationId = selectedId;
    final ids = await _uploadAll(conversationId, files);
    if (ids == null) return null;
    final before = _pending;
    final tags = Map<String, String>.of(_mentions[conversationId] ?? const {});
    final sending = command({
      'type': 'message.send',
      'conversationId': conversationId,
      'text': text,
      'replyTo': replyTo,
      'recipientIds': addressed,
      if (tagged.isNotEmpty) 'mentions': tagged,
      if (ids.isNotEmpty) 'attachmentIds': ids,
    });
    // On its way: the message shows in the chat, and the draft is free for
    // the next one. Both are in the save made before the request.
    if (_pending case final pending? when !identical(pending, before)) {
      _sendingMentions[pending['operationId'] as String] = tags;
      if (_drafts[conversationId]?.trim() == text) {
        _drafts.remove(conversationId);
        _mentions.remove(conversationId);
      }
      onSending?.call();
      _changed();
    }
    final result = await sending;
    // A refusal of the files themselves sends them up once more; one of the
    // message (a mention, a recipient) leaves them uploaded.
    if (result == null &&
        _pending == null &&
        operationErrorCode?.contains('ATTACHMENT') == true) {
      _uploaded.clear();
    }
    return result;
  }

  /// Uploads each of [files] that has not gone up yet and returns their ids,
  /// or null with [operationError] set when one could not. The draft and the
  /// files stay where they are.
  Future<List<String>?> _uploadAll(
    String conversationId,
    List<HarnessAttachment> files,
  ) async {
    // Any send of this conversation answers its last refused upload.
    _uploadErrors.remove(conversationId);
    if (files.isEmpty) return const [];
    final run = ++_uploadRun;
    uploading = true;
    operationError = null;
    _sending = (conversationId: conversationId, files: files);
    _uploaded.removeWhere((file, _) => !files.contains(file));
    _changed();
    try {
      final ids = <String>[];
      for (final file in files) {
        var id = _uploaded[file];
        if (id == null) {
          final answer = await _uploadFile(conversationId, file);
          if (run != _uploadRun) return null;
          id = superTabMap(answer['attachment'])['id'] as String;
          _uploaded[file] = id;
        }
        ids.add(id);
      }
      return ids;
    } catch (failure) {
      if (!_disposed && run == _uploadRun) {
        // Into the conversation the files were for, whichever is shown now.
        _uploadErrors[conversationId] = failure is SuperTabFailure
            ? failure.message
            : failure is TimeoutException
            ? 'The upload stopped moving. Try again.'
            : 'Could not upload ${files.length == 1 ? 'the file' : 'the files'}. Try again.';
      }
      return null;
    } finally {
      if (run == _uploadRun) {
        uploading = false;
        _sending = null;
        _progress.clear();
        _changed();
      }
    }
  }

  /// Sends [file] to the backend and returns its attachment. Gives up when no
  /// byte has moved for [uploadTimeout], or when the upload is cancelled.
  Future<Map<String, dynamic>> _uploadFile(
    String conversationId,
    HarnessAttachment file,
  ) async {
    final token = _cancel = CancelToken();
    Timer? watchdog;
    var stalled = false;
    void watch() {
      watchdog?.cancel();
      watchdog = Timer(uploadTimeout, () {
        stalled = true;
        token.cancel('stalled');
      });
    }

    watch();
    try {
      // The token also ends a transport that ignores it.
      return await Future.any([
        upload(
          tabId: tabId,
          conversationId: conversationId,
          name: file.name,
          mime: mimeForName(file.name),
          bytes: file.bytes,
          cancel: token,
          onProgress: (sent) {
            watch();
            _progress[file] = sent;
            _changed();
          },
        ),
        token.whenCancel.then<Map<String, dynamic>>(
          (cancelled) => throw cancelled,
        ),
      ]);
    } on DioException catch (failure) {
      if (stalled && failure.type == DioExceptionType.cancel) {
        throw TimeoutException('The upload stopped moving.');
      }
      rethrow;
    } finally {
      watchdog?.cancel();
    }
  }

  /// Gives up the files on their way, whether they are stalled or not wanted
  /// any more: the composer is free again, and the draft and files stay.
  void cancelUpload() {
    if (!uploading) return;
    _cancel?.cancel('given up');
    _uploadRun++;
    uploading = false;
    _sending = null;
    _changed();
  }

  Future<void> flush() async {
    _draftSave?.cancel();
    await _persist();
  }

  @override
  void dispose() {
    _disposed = true;
    _serverMarks.dispose();
    _poll?.cancel();
    _toldRead?.cancel();
    _graceEnd?.cancel();
    _draftSave?.cancel();
    for (final retry in _quoteRetries) {
      retry.cancel();
    }
    for (final files in _attachments.values) {
      files.dispose();
    }
    // The owner awaits flush when changing account or closing the tab.
    super.dispose();
  }
}
