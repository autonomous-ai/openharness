import 'package:flutter/foundation.dart';

/// A Swarm link identifies membership access, never a machine, path or command.
/// Opening it only queues a preview; the person must sign in and choose Join.
class SwarmJoinLink {
  const SwarmJoinLink(this.tabId, {this.token});

  final String tabId;
  final String? token;
  static final _id = RegExp(r'^[A-Za-z0-9_-]{1,160}$');
  static final _token = RegExp(r'^[A-Za-z0-9_-]{43}$');

  String get url =>
      'harness://swarm/join/$tabId'
      '${token == null ? '' : '?token=$token'}';

  static SwarmJoinLink? parse(String value) {
    // Match the native URL-open limit, including cold-start delivery.
    if (value.length > 240) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        uri.scheme != 'harness' ||
        uri.host != 'swarm' ||
        uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        uri.pathSegments.length != 2 ||
        uri.pathSegments.first != 'join' ||
        !_id.hasMatch(uri.pathSegments.last)) {
      return null;
    }
    final query = uri.queryParametersAll;
    if (query.isEmpty && !uri.hasQuery) {
      return SwarmJoinLink(uri.pathSegments.last);
    }
    final tokens = query['token'];
    if (query.length != 1 ||
        tokens == null ||
        tokens.length != 1 ||
        !_token.hasMatch(tokens.single)) {
      return null;
    }
    return SwarmJoinLink(uri.pathSegments.last, token: tokens.single);
  }
}

/// Links arriving before sign-in stay in memory, without persisting or logging
/// the bearer token. The native host already queues cold-start URL events.
class SwarmJoinInbox extends ChangeNotifier {
  final List<SwarmJoinLink> _pending = [];
  List<SwarmJoinLink> get pending => List.unmodifiable(_pending);

  Future<void> accept(String value) async {
    final link = SwarmJoinLink.parse(value);
    if (link == null ||
        _pending.length >= 20 ||
        _pending.any((item) => item.url == link.url)) {
      return;
    }
    _pending.add(link);
    notifyListeners();
  }

  void complete(SwarmJoinLink link) {
    _pending.removeWhere((item) => item.url == link.url);
    notifyListeners();
  }
}

final swarmJoinInbox = SwarmJoinInbox();
