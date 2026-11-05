import 'package:flutter/foundation.dart';

import 'controller.dart';

/// The Swarm's three pages in the sidebar, each one thing (anh Dee, 11-05,
/// task #2996): what waits on the reader's answer, the tags of them, and the
/// threads they follow.
enum SwarmPage { decisions, mentions, threads }

/// A place the reader was in a Swarm: one of its pages, or a chat with the
/// thread open beside it ([root]) or none.
@immutable
class SuperTabPlace {
  const SuperTabPlace.page(SwarmPage this.page)
    : conversationId = null,
      root = null;
  const SuperTabPlace.chat(String this.conversationId, {this.root})
    : page = null;

  final SwarmPage? page;
  final String? conversationId, root;

  @override
  bool operator ==(Object other) =>
      other is SuperTabPlace &&
      other.page == page &&
      other.conversationId == conversationId &&
      other.root == root;

  @override
  int get hashCode => Object.hash(page, conversationId, root);

  @override
  String toString() => page?.name ?? '$conversationId/${root ?? ''}';
}

/// The reader's places in one Swarm, as a browser's history: Back and
/// Forward (the sidebar's arrows, ⌘[ and ⌘]) step through them. In memory
/// only, at most [capacity]. The view records where it is after each frame; a
/// step is asked
/// here ([step]) and taken by the view ([takeStep]), which goes there. One per
/// controller.
class SuperTabPlaces extends ChangeNotifier {
  SuperTabPlaces._(this.controller) {
    controller.onDispose(dispose);
  }

  static final _all = Expando<SuperTabPlaces>();
  static SuperTabPlaces of(SuperTabController controller) =>
      _all[controller] ??= SuperTabPlaces._(controller);

  final SuperTabController controller;
  static const capacity = 64;

  final _trail = <SuperTabPlace>[];
  int _cursor = -1;
  SuperTabPlace? _asked;
  bool _disposed = false;

  /// Where the reader is now. The same place again is no new step; a new one
  /// after going back drops the places ahead, as a browser does.
  void record(SuperTabPlace place) {
    if (_cursor >= 0 && _trail[_cursor] == place) return;
    _trail
      ..removeRange(_cursor + 1, _trail.length)
      ..add(place);
    if (_trail.length > capacity) _trail.removeAt(0);
    _cursor = _trail.length - 1;
    // The arrows follow; the view records after its frame, never in a build.
    if (!_disposed) notifyListeners();
  }

  /// A page is always there; a chat only while the reader still has it.
  bool _there(SuperTabPlace place) =>
      place.conversationId == null ||
      (!controller.accessRevoked &&
          controller.snapshot?.conversation(place.conversationId!) != null);

  int? _next(int direction) {
    for (
      var i = _cursor + direction;
      i >= 0 && i < _trail.length;
      i += direction
    ) {
      if (_there(_trail[i])) return i;
    }
    return null;
  }

  bool get canGoBack => _next(-1) != null;
  bool get canGoForward => _next(1) != null;

  /// Asks to go back (-1) or forward (1); the view on screen goes there.
  void step(int direction) {
    if (_disposed || (direction != -1 && direction != 1)) return;
    final index = _next(direction);
    if (index == null) return;
    _cursor = index;
    _asked = _trail[index];
    notifyListeners();
  }

  /// The place a [step] asked for, once: the view goes there.
  SuperTabPlace? takeStep() {
    final asked = _asked;
    _asked = null;
    return asked;
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    super.dispose();
  }
}

/// ⌘[ and ⌘] in a Swarm tab (task #2996): its places first. True when
/// [controller]'s places stepped [direction]; false leaves the step to the
/// tabs and panes, as everywhere else.
bool stepSwarmPlaces(SuperTabController? controller, int direction) {
  if (controller == null) return false;
  final places = SuperTabPlaces.of(controller);
  if (direction < 0 ? !places.canGoBack : !places.canGoForward) return false;
  places.step(direction);
  return true;
}

/// Whether ⌘[ (direction -1) or ⌘] (1) has a place to go in [controller]'s
/// Swarm.
bool canStepSwarmPlaces(SuperTabController? controller, int direction) {
  if (controller == null) return false;
  final places = SuperTabPlaces.of(controller);
  return direction < 0 ? places.canGoBack : places.canGoForward;
}
