import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';

import '../state/app_state.dart';
import 'controller.dart';
import 'identity.dart';
import 'message_link.dart';
import 'message_link_preview.dart';
import 'model.dart';

/// How a message link reaches the other Swarms of the account.
abstract interface class SwarmLinkSwarms {
  /// [tabId]'s controller if that Swarm is loaded here, else null. Nothing is
  /// loaded for a preview.
  SuperTabController? loaded(String tabId);

  /// What [link] points at in a Swarm that is not loaded here, read once as
  /// that one message and kept as text only: no Swarm is opened, so nothing
  /// polls, saves or badges for it. [onRead] says when the answer arrives.
  SuperTabLinkTarget read(SwarmMessageLink link, VoidCallback onRead);

  /// Opens [link]'s Swarm and asks it for the message; false when it cannot.
  Future<bool> open(SwarmMessageLink link);
}

/// Whether the account lists the Swarm [tabId], open or closed here.
bool swarmListed(AppNotifier app, String tabId) =>
    app.swarms.any((s) => s.superTabId == tabId) ||
    app.closedSuperTabs.any((s) => s.id == tabId);

/// The account's Swarms as the app lists them.
class AppLinkSwarms implements SwarmLinkSwarms {
  AppLinkSwarms(
    this.app, {
    Future<Map<String, dynamic>> Function(String path)? get,
    this.controllerFor,
  }) : _get = get ?? ((path) => app.superTabs.map('GET', path));
  final AppNotifier app;
  final Future<Map<String, dynamic>> Function(String path) _get;

  /// How [open] reaches a Swarm's controller; the app's own unless given.
  final Future<SuperTabController> Function(String tabId)? controllerFor;

  static const _kept = 50;
  static const _retryAfter = Duration(minutes: 1);
  // What each link read: newest last, so the oldest is dropped past [_kept].
  final _reads = <String, _Read>{};

  @override
  SuperTabController? loaded(String tabId) =>
      swarmListed(app, tabId) ? app.superTabs.peek(tabId) : null;

  @override
  SuperTabLinkTarget read(SwarmMessageLink link, VoidCallback onRead) {
    if (!swarmListed(app, link.tabId)) {
      return const SuperTabLinkTarget.unavailable();
    }
    final known = _reads[link.url];
    if (known != null &&
        (known.reading || clock.now().difference(known.at) < _retryAfter)) {
      return known.target;
    }
    final read = _reads.remove(link.url) ?? _Read();
    _reads[link.url] = read
      ..reading = true
      ..target = const SuperTabLinkTarget.loading();
    if (_reads.length > _kept) _reads.remove(_reads.keys.first);
    unawaited(_read(link, read, onRead));
    return read.target;
  }

  Future<void> _read(
    SwarmMessageLink link,
    _Read read,
    VoidCallback onRead,
  ) async {
    SuperTabLinkTarget target = const SuperTabLinkTarget.unavailable();
    try {
      // The backend checks the reader may read the conversation, as for its pages.
      final answer = await _get(
        '/api/super-tabs/${Uri.encodeComponent(link.tabId)}'
        '/conversations/${Uri.encodeComponent(link.conversationId)}/messages'
        '?messageId=${Uri.encodeQueryComponent(link.messageId)}',
      );
      final rows = [
        for (final row in answer['messages'] as List)
          SuperTabMessage.fromJson(superTabMap(row)),
      ];
      final message = rows.length == 1 ? rows.single : null;
      if (message != null &&
          message.id == link.messageId &&
          message.conversationId == link.conversationId &&
          const {
            'delivery-hold',
            'update-request',
          }.every((kind) => message.source['kind'] != kind)) {
        target = SuperTabLinkTarget.message(message, author: _author(message));
      }
    } catch (_) {
      // Refused or failed: unavailable, asked again after a minute.
    }
    read
      ..reading = false
      ..at = clock.now()
      ..target = target;
    onRead();
  }

  String _author(SuperTabMessage message) =>
      message.authorId == app.currentUser?.id && !message.fromAgent
      ? 'You'
      : message.fromAgent
      ? message.authorName
      : superTabPersonName(message.authorName);

  @override
  Future<bool> open(SwarmMessageLink link) =>
      openSwarmMessageLink(app, link, controllerFor: controllerFor);
}

/// Brings the Swarm [link] names to the front and asks it to open the message.
/// False when the reader is not in that Swarm (or it cannot be read now): the
/// caller says only that the message is unavailable. A Swarm is opened only if
/// the account already lists it; the Swarm's own view then checks the
/// conversation and the message, so the link grants nothing.
Future<bool> openSwarmMessageLink(
  AppNotifier app,
  SwarmMessageLink link, {
  Future<SuperTabController> Function(String tabId)? controllerFor,
}) async {
  final tabId = link.tabId;
  final open = app.swarms.where((s) => s.superTabId == tabId).firstOrNull;
  final closed = app.closedSuperTabs.where((s) => s.id == tabId).firstOrNull;
  if (open == null && closed == null) return false;
  app.openSuperTab(tabId, open?.name ?? closed!.name);
  try {
    final controller = await (controllerFor ?? app.superTabs.open)(tabId);
    return controller.openMessageLink(link);
  } catch (_) {
    return false;
  }
}

class _Read {
  bool reading = false;
  DateTime at = DateTime.fromMillisecondsSinceEpoch(0);
  SuperTabLinkTarget target = const SuperTabLinkTarget.loading();
}
