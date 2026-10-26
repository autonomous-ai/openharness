import 'dart:async';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:collection/collection.dart' show DeepCollectionEquality;
import 'package:dio/dio.dart' show CancelToken, DioException, DioExceptionType;
import 'package:flutter/foundation.dart';

import '../logging/app_log.dart';
import '../state/harness_attachments.dart';
import 'attachment_upload.dart';
import 'model.dart';
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

/// Personal navigation/drafts live on this client. Membership, work and messages
/// live on the backend; refreshing never selects another person's conversation.
class SuperTabController extends ChangeNotifier {
  SuperTabController({
    required this.tabId,
    required this.accountId,
    required this.request,
    required this.save,
    this.upload = refuseUpload,
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

  /// How long an upload may go without a byte moving before the send gives up.
  final Duration uploadTimeout;
  SuperTabSnapshot? snapshot;
  String selectedId = 'lead';
  int revision = -1;
  String? error, operationError, operationErrorCode;

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

  /// The state last drawn, while the reading adapts ([_read]).
  Map<String, dynamic>? _shownState;

  /// The rows each conversation's messages were read from, kept only to save
  /// the view ([SuperTabReading.drawsSaved]).
  final _rows = <String, Map<String, Map<String, dynamic>>>{};

  /// A saved view is on screen and no read has replaced it yet.
  bool get showingSaved => _showingSaved;
  bool _showingSaved = false;

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
    if (!_policy.pausesAway || _startedAt == null || _disposed) return;
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
  bool get backendUnreachable => _refreshFailing && !accessRevoked;
  bool _refreshFailing = false;

  /// Since when the reads have been failing, while [backendUnreachable]: the first failure of this run of them.
  DateTime? unreachableSince;

  /// How many reads of the Swarm's state have been answered. A sidebar that is waiting for a new reading (back from
  /// the background) knows it has one when this moves.
  int stateReads = 0;
  Future<void> _persisting = Future.value();
  Map<String, dynamic>? _pending;
  final _drafts = <String, String>{};
  final _terminals = <String, String>{};
  final _mentions = <String, Map<String, String>>{};
  final _readAt = <String, int>{};
  final _attachments = <String, HarnessAttachments>{};
  // Files already uploaded for the message being sent, so a retry sends their
  // ids rather than uploading them again.
  final _uploaded = <HarnessAttachment, String>{};
  final _progress = <HarnessAttachment, double>{};
  CancelToken? _cancel;
  ({String conversationId, List<HarnessAttachment> files})? _sending;
  int _uploadRun = 0;
  final _messages = <String, List<SuperTabMessage>>{};
  final _before = <String, int?>{};
  final _reading = <String, Future<void>>{};
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
    devicesSelected = true;
    _saveSoon();
    _changed();
  }

  /// Whether the Machines group's "Offline · N" disclosure is open; it starts closed.
  bool offlineMachinesOpen = false;

  void toggleProject(String id) {
    if (!expandedProjects.remove(id)) expandedProjects.add(id);
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
    // Taking a chip off while its files go up gives the upload up.
    files.addListener(() {
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
    devicesSelected = false;
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
    devicesSelected = false;
    if (agentId == null) {
      _terminals.remove(conversationId);
    } else {
      _terminals[conversationId] = agentId;
    }
    _saveSoon();
    _changed();
  }

  List<SuperTabMessage> messages(String id) => List.unmodifiable(
    (_messages[id] ?? const <SuperTabMessage>[]).where(
      (m) => m.source['kind'] != 'update-request',
    ),
  );

  /// "Reviewer: Ada · Ready: yes on 1a2b3c4d5", from the newest `Ready:` message a
  /// reviewer of [group] posted in the loaded history. Null without a reviewer.
  String? reviewLine(SuperTabConversation? group) {
    final state = snapshot;
    if (group == null) return null;
    final reviewers = state?.reviewers(group) ?? const <SuperTabAgent>[];
    if (reviewers.isEmpty) return null;
    final ids = {for (final r in reviewers) r.id};
    final verdict = messages(group.id).reversed
        .where((m) => m.fromAgent && ids.contains(m.authorId))
        .map((m) => parseSuperTabVerdict(m.text))
        .nonNulls
        .firstOrNull;
    final names = reviewers.map((r) => state!.agentName(r.id)).join(', ');
    return 'Reviewer: $names · ${verdict?.label ?? 'No verdict yet'}';
  }

  bool hasOlder(String id) => _before[id] != null;
  int _loadedMessageSequence(String id) =>
      _messages[id]?.reversed
          .where((m) => m.source['kind'] != 'update-request')
          .firstOrNull
          ?.sequence ??
      0;
  bool unread(SuperTabConversation group) =>
      max(group.lastMessageSequence, _loadedMessageSequence(group.id)) >
      (_readAt[group.id] ?? 0);

  void start() {
    if (_disposed) return;
    _startedAt = _lastActivity = clock.now();
    unawaited(refresh());
    _schedule();
  }

  /// [after] is what is left of the poll once a read took the rest of it.
  void _schedule([Duration? after]) {
    _poll?.cancel();
    if (_disposed || pollInterval <= Duration.zero) return;
    if (!_policy.adapts) {
      _poll = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
      return;
    }
    if (accessRevoked || (_policy.pausesAway && _away)) return;
    final wait = after ?? pollInterval;
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
    await (_fullReadDue ? refresh() : _readMessages(selectedId, light: true));
    _schedule(pollInterval - clock.now().difference(began));
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

  void _keepRows(String id, List rows) {
    if (!_policy.drawsSaved) return;
    final kept = _rows[id] ??= {};
    for (final row in rows) {
      final map = superTabMap(row);
      kept[map['id'] as String] = map;
    }
  }

  /// The view to keep on this device ([SuperTabReading.drawsSaved]): the
  /// state as last read and the open conversation's last page, or null.
  Map<String, dynamic>? get savedView {
    final state = _shownState;
    if (!_policy.drawsSaved || state == null || accessRevoked) return null;
    final id = selectedId;
    final shown = _messages[id] ?? const <SuperTabMessage>[];
    final page = shown.length > _savedPage
        ? shown.sublist(shown.length - _savedPage)
        : shown;
    final rows = [for (final message in page) ?_rows[id]?[message.id]];
    return {
      'revision': revision,
      'state': state,
      'conversationId': id,
      'messages': rows,
      'next': page.length < shown.length ? page.first.sequence : _before[id],
    };
  }

  /// A conversation's page as the backend reads it.
  static const _savedPage = 100;

  /// Draws a [savedView] kept from an earlier visit, before [start]: the
  /// first read replaces it. One for another Swarm, or that no longer
  /// parses, draws nothing.
  void drawSaved(Map<String, dynamic> view) {
    if (!_policy.drawsSaved || snapshot != null || _startedAt != null) return;
    try {
      final state = superTabMap(view['state']);
      final saved = SuperTabSnapshot.fromJson(state);
      if (saved.id != tabId) return;
      final id = view['conversationId'];
      final rows = [
        for (final row in view['messages'] as List? ?? const [])
          superTabMap(row),
      ];
      final messages = rows.map(SuperTabMessage.fromJson).toList();
      final revisionSaved = (view['revision'] as num).toInt();
      snapshot = saved;
      revision = revisionSaved;
      _shownState = state;
      if (id == selectedId &&
          saved.conversation(id as String) != null &&
          messages.every((m) => m.conversationId == id)) {
        _messages[id] = messages
          ..sort((a, b) => a.sequence.compareTo(b.sequence));
        _keepRows(id, rows);
        _before[id] = (view['next'] as num?)?.toInt();
      }
      _showingSaved = true;
    } on FormatException {
      _dropSaved();
    } on TypeError {
      _dropSaved();
    }
  }

  /// A view from an older shape: draw nothing, read as usual.
  void _dropSaved() {
    snapshot = null;
    revision = -1;
    _shownState = null;
    _messages.clear();
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
    _messages.clear();
    _poll?.cancel();
    _changed();
  }

  Map<String, dynamic> _localState() => {
    'tabId': tabId,
    'accountId': accountId,
    'selectedId': selectedId,
    'expandedProjects': expandedProjects.toList(),
    'expandedMachines': expandedMachines.toList(),
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
    if (_pending != null) 'pending': _pending,
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

  Map<String, String> mentions(String conversationId) =>
      Map.unmodifiable(_mentions[conversationId] ?? const {});

  void select(String id) {
    if (snapshot?.conversation(id) == null ||
        (id == selectedId && !devicesSelected)) {
      return;
    }
    devicesSelected = false;
    _acted();
    if (!snapshot!.isProjectLead(id)) {
      final group = snapshot!.conversation(id)!;
      expandedProjects.add(group.projectId);
      if (group.archived) closedOpenProjects.add(group.projectId);
    }
    selectedId = id;
    operationNotice = null;
    _saveSoon();
    _changed();
    unawaited(loadMessages(id));
  }

  /// A visible transcript passes the boundary it displayed. The loaded messages
  /// are authoritative: snapshots can arrive either before or after their tail.
  void markRead(String id, {int? through}) {
    if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
      return;
    }
    final loaded = _loadedMessageSequence(id);
    final last = min(through ?? loaded, loaded);
    if ((_readAt[id] ?? 0) >= last) return;
    _readAt[id] = last;
    _saveSoon();
    _changed();
  }

  Future<void> refresh() {
    if (_disposed || accessRevoked) return Future.value();
    return _refreshing ??= _read().whenComplete(() => _refreshing = null);
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
    final took = Stopwatch()..start();
    // The open conversation's messages, asked for beside the state
    // ([SuperTabReading.messagesWithState]); dropped if the state moves the
    // selection elsewhere.
    final earlyId = selectedId;
    final earlyQuery = _earlyQuery(earlyId);
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
      final answer = await request('GET', _path);
      if (_disposed || accessRevoked) return;
      _refreshFailing = false;
      unreachableSince = null;
      _waitingForMachine = false;
      _graceEnd?.cancel();
      stateReads++;
      final nextRevision = (answer['revision'] as num).toInt();
      // How long the Swarm took to answer, and nothing it said: the log shows a slow or failing
      // backend, which the sidebar's ages and the machines' states otherwise only hint at.
      appLog.debug(
        'swarm',
        'state read in ${took.elapsedMilliseconds} ms (revision $nextRevision)',
      );
      final raw = superTabMap(answer['state']);
      // Some of the state is worked out at read time (an agent seen down, a
      // limit that ran out) and changes with no new revision.
      if (_policy.adapts) {
        stateChanged = !const DeepCollectionEquality().equals(raw, _shownState);
        _shownState = raw;
      }
      final next = SuperTabSnapshot.fromJson(raw);
      if (next.id != tabId) {
        throw const FormatException('A different Swarm was returned.');
      }
      if (nextRevision >= revision) {
        snapshot = next;
        final allowed = next.conversations.map((c) => c.id).toSet();
        final localAccessChanged =
            !allowed.contains(selectedId) ||
            [
              ..._drafts.keys,
              ..._terminals.keys,
              ..._mentions.keys,
              ..._readAt.keys,
            ].any((id) => !allowed.contains(id)) ||
            expandedProjects.any(
              (id) => !next.projects.any((project) => project.id == id),
            );
        _messages.removeWhere((id, _) => !allowed.contains(id));
        _rows.removeWhere((id, _) => !allowed.contains(id));
        _drafts.removeWhere((id, _) => !allowed.contains(id));
        _attachments.removeWhere((id, files) {
          if (allowed.contains(id)) return false;
          files.dispose();
          return true;
        });
        _terminals.removeWhere((id, _) => !allowed.contains(id));
        _mentions.removeWhere((id, _) => !allowed.contains(id));
        _before.removeWhere((id, _) => !allowed.contains(id));
        _readAt.removeWhere((id, _) => !allowed.contains(id));
        expandedProjects.removeWhere(
          (id) => !next.projects.any((project) => project.id == id),
        );
        if (!allowed.contains(selectedId)) {
          selectedId = next.projects.firstOrNull?.leadConversationId ?? 'lead';
        }
        revision = nextRevision;
        error = null;
        if (localAccessChanged) _saveSoon();
      }
      await (selectedId == earlyId && messagesRead != null
          ? messagesRead
          : _readMessages(
              selectedId,
              early: selectedId == earlyId && early != null
                  ? (query: earlyQuery!, page: early)
                  : null,
            ));
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

  /// What a state read can change on screen, beside the messages.
  ({int revision, String? error, bool failing, bool revoked, bool loading})
  get _shown => (
    revision: revision,
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
  static bool _sameMessages(
    List<SuperTabMessage>? shown,
    List<SuperTabMessage> next,
  ) {
    if (shown == null || shown.length != next.length) return false;
    for (var i = 0; i < next.length; i++) {
      final a = shown[i], b = next[i];
      if (a.id != b.id || a.deliveries.length != b.deliveries.length) {
        return false;
      }
      for (var j = 0; j < b.deliveries.length; j++) {
        if (!mapEquals(a.deliveries[j], b.deliveries[j])) return false;
      }
    }
    return true;
  }

  String _messagesPath(String id) =>
      '$_path/conversations/${Uri.encodeComponent(id)}/messages';

  /// What a read of [id]'s messages asks for: the page before the oldest
  /// shown, what came after the newest, or the latest page.
  String _query(String id, {bool older = false}) {
    if (older) return '?before=${_before[id]}';
    // A saved page may be stale in its receipts as well as short of new
    // messages: the first read after it takes the latest page whole.
    if (_showingSaved) return '';
    final tail = _messages[id]?.lastOrNull?.sequence;
    return tail != null ? '?after=$tail' : '';
  }

  /// The query of [id]'s messages read to start beside a state read, or null.
  /// On first open only for the conversation the saved state named; after
  /// that, for a conversation the state has and no read of it under way.
  String? _earlyQuery(String id) {
    if (!_policy.messagesWithState || _reading.containsKey(id)) return null;
    final known = snapshot == null
        ? _savedSelection
        : snapshot!.conversation(id) != null;
    return known ? _query(id) : null;
  }

  void _readFailure(Object failure, {bool revokeTab = true}) {
    if (_disposed) return;
    error = failure is SuperTabFailure
        ? failure.message
        : 'Could not refresh this conversation. Try again.';
    if (revokeTab &&
        failure is SuperTabFailure &&
        const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
      accessRevoked = true;
      devicesSelected = false;
      snapshot = null;
      _messages.clear();
      _poll?.cancel();
    }
  }

  /// Joins a read of [id] already under way, so a caller can wait for it.
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
  }) => _reading[id] ??=
      _loadMessages(id, older: older, light: light, early: early).whenComplete(
        () {
          // A block: whenComplete would wait on the removed future, itself.
          _reading.remove(id);
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
    try {
      final known = _messages[id];
      final tail = known != null && known.isNotEmpty
          ? known.last.sequence
          : null;
      final query = _query(id, older: older);
      final first = early != null && early.query == query ? early.page : null;
      var answer = first != null
          ? await first.catchError(
              (Object _) => request('GET', '${_messagesPath(id)}$query'),
            )
          : await request('GET', '${_messagesPath(id)}$query');
      final arrived =
          !older && tail != null && (answer['messages'] as List).isNotEmpty;
      if (!_disposed &&
          !older &&
          !light &&
          tail != null &&
          (answer['messages'] as List).isEmpty) {
        // No new text: refresh delivery receipts in the page already shown.
        answer = await request(
          'GET',
          '$_path/conversations/${Uri.encodeComponent(id)}/messages?before=${tail + 1}',
        );
      }
      if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
        return;
      }
      final incoming = (answer['messages'] as List)
          .map((m) => SuperTabMessage.fromJson(superTabMap(m)))
          .toList();
      if (incoming.any((m) => m.conversationId != id)) {
        throw const FormatException('A different conversation was returned.');
      }
      _keepRows(id, answer['messages'] as List);
      final combined = {
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
        if (_disposed || accessRevoked || snapshot?.conversation(id) == null) {
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
      final next = combined.values.toList()
        ..sort((a, b) => a.sequence.compareTo(b.sequence));
      // An adapting read that found nothing new changes nothing on screen.
      final same = _policy.adapts && _sameMessages(_messages[id], next);
      _messages[id] = next;
      if (older || !_before.containsKey(id)) {
        _before[id] = (answer['next'] as num?)?.toInt();
      }
      // Something new in the conversation on screen keeps the full poll.
      if (arrived && id == selectedId) _acted();
      if (!same) _changed();
    } catch (failure) {
      // The state read waits for a machine within the grace: so do these.
      if (!_inConnectGrace(failure)) _readFailure(failure, revokeTab: false);
      if (failure is SuperTabFailure &&
          const {'FORBIDDEN', 'NOT_FOUND'}.contains(failure.code)) {
        _messages.remove(id);
        unawaited(refresh());
      }
      _changed();
    }
  }

  Future<Map<String, dynamic>?> command(Map<String, dynamic> command) async {
    if (_disposed || !_maySend(command) || saving || _pending != null) {
      return null;
    }
    _acted();
    _pending = {
      'operationId': superTabOperationId(),
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
        selectedId = result['conversationId'] as String;
      }
      _pending = null;
      try {
        await _persist();
      } catch (_) {
        _pending = pending;
        rethrow;
      }
      await refresh();
      if (!_disposed &&
          revision < ((answer['revision'] as num?)?.toInt() ?? revision)) {
        await refresh();
      }
      return result;
    } catch (failure) {
      if (!_disposed) {
        operationError = failure is SuperTabFailure
            ? failure.message
            : 'The action is not confirmed. Retry to check it.';
        operationErrorCode = failure is SuperTabFailure ? failure.code : null;
        if (failure is SuperTabFailure &&
            failure.statusCode >= 400 &&
            failure.statusCode < 500 &&
            !const {408, 429}.contains(failure.statusCode)) {
          // A definitive rejection made no change. Preserve the draft and let
          // the person correct it; a lost reply retains its exact receipt ID.
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

  bool _maySend(Map<String, dynamic> command) =>
      canWrite ||
      (!accessRevoked &&
          snapshot != null &&
          command['type'] == 'member.remove' &&
          command['userId'] == accountId);

  Future<Map<String, dynamic>?> send({
    String? replyTo,
    List<String> recipients = const [],
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
    final addressed = recipients.isEmpty
        ? mentions(selectedId).entries
              .where((entry) => containsMention(text, entry.value))
              .map((entry) => entry.key)
              .toList()
        : recipients;
    if (addressed.any((id) => !selected!.agentIds.contains(id))) {
      operationError = 'A mentioned agent is no longer in this conversation. Remove its mention or choose another agent.';
      _changed();
      return null;
    }
    final conversationId = selectedId;
    final ids = await _uploadAll(conversationId, files);
    if (ids == null) return null;
    final result = await command({
      'type': 'message.send',
      'conversationId': conversationId,
      'text': text,
      'replyTo': replyTo,
      'recipientIds': addressed,
      if (ids.isNotEmpty) 'attachmentIds': ids,
    });
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
        operationError = failure is SuperTabFailure
            ? failure.message
            : failure is TimeoutException
            ? 'The upload stopped moving. Try again.'
            : 'Could not upload ${files.length == 1 ? 'the file' : 'the files'}. Try again.';
        operationErrorCode = failure is SuperTabFailure ? failure.code : null;
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
    _poll?.cancel();
    _graceEnd?.cancel();
    _draftSave?.cancel();
    for (final files in _attachments.values) {
      files.dispose();
    }
    // The owner awaits flush when changing account or closing the tab.
    super.dispose();
  }
}
