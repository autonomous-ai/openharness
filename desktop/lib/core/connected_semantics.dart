import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import '../logging/app_log.dart';

/// Flutter 3.47 can serialize dirty semantics nodes from hidden subtrees, even
/// though they are not reachable from the view's semantics root. The desktop
/// AX bridge rejects that update after partially changing its tree; a later
/// reparent then dereferences a null parent and terminates the process.
///
/// Filter at Flutter's public builder seam, before the native update is made.
/// Derive connectivity from the current framework tree. Keep immutable copies
/// of node updates while their paint nodes exist: a clean hidden portal may
/// reconnect without Flutter serializing it again. Replay its latest data when
/// it reconnects, and discard snapshots when nodes leave the framework tree.
/// https://github.com/flutter/flutter/issues/193410
mixin ConnectedSemanticsBinding on RendererBinding {
  bool _reportedDisconnectedSemantics = false;
  final _updates = <int, _NodeUpdate>{};
  final _previousConnected = <int>{};

  @protected
  ui.SemanticsUpdateBuilder createPlatformSemanticsUpdateBuilder() =>
      super.createSemanticsUpdateBuilder();

  @override
  ui.SemanticsUpdateBuilder createSemanticsUpdateBuilder() {
    final delegate = createPlatformSemanticsUpdateBuilder();
    if (kIsWeb ||
        (defaultTargetPlatform != TargetPlatform.macOS &&
            defaultTargetPlatform != TargetPlatform.windows)) {
      return delegate;
    }
    final connected = <int>{};
    final attached = <int>{};
    for (final view in renderViews) {
      final root = view.owner?.semanticsOwner?.rootSemanticsNode;
      if (root == null) continue;
      // OverlayPortal has different paint and accessibility parents. In the
      // failing Slider/IndexedStack case the hidden portal's child is still
      // in paint order, but its traversal parent is no longer in the tree.
      final portals = <Object, List<SemanticsNode>>{};
      void collect(SemanticsNode node) {
        attached.add(node.id);
        final identifier = node.traversalChildIdentifier;
        if (node.traversalParentIdentifier == null && identifier != null) {
          portals.putIfAbsent(identifier, () => []).add(node);
        }
        node.visitChildren((child) {
          collect(child);
          return true;
        });
      }

      collect(root);
      final visited = <SemanticsNode>{};
      void visit(SemanticsNode node) {
        if (!visited.add(node)) return;
        connected.add(node.id);
        if (!node.mergeAllDescendantsIntoThisNode) {
          node.visitChildren((child) {
            if (child.traversalChildIdentifier == null ||
                node.traversalParentIdentifier != null) {
              visit(child);
            }
            return true;
          });
        }
        for (final child
            in portals[node.traversalParentIdentifier] ??
                const <SemanticsNode>[]) {
          if (child.attached) visit(child);
        }
      }

      visit(root);
    }
    _updates.removeWhere((id, _) => !attached.contains(id));
    return _ConnectedSemanticsUpdateBuilder(
      delegate,
      connected: connected,
      updates: _updates,
      previousConnected: _previousConnected,
      onDiscard: (id) {
        if (_reportedDisconnectedSemantics) return;
        _reportedDisconnectedSemantics = true;
        appLog.warn(
          'accessibility',
          'Filtered disconnected semantics node $id before the native update',
        );
      },
    );
  }
}

/// Used by the production entry point; native/widget fixtures mix the same
/// protection into their test binding so they exercise the real boundary.
class HarnessWidgetsBinding extends WidgetsFlutterBinding
    with ConnectedSemanticsBinding {}

typedef _NodeUpdate = void Function(ui.SemanticsUpdateBuilder, Set<int>);

class _ConnectedSemanticsUpdateBuilder implements ui.SemanticsUpdateBuilder {
  _ConnectedSemanticsUpdateBuilder(
    this._delegate, {
    required this.connected,
    required this.updates,
    required this.previousConnected,
    this.onDiscard,
  });

  final Map<int, _NodeUpdate> updates;
  final Set<int> previousConnected;
  final _changed = <int>{};
  final ui.SemanticsUpdateBuilder _delegate;
  final Set<int> connected;
  final void Function(int id)? onDiscard;

  // Root 0 can never be another node's child. Leave traversal/hit-test order
  // otherwise intact: OverlayPortal legitimately uses different lists.
  static Int32List _children(Int32List ids, Set<int> connected) {
    if (ids.every((id) => id != 0 && connected.contains(id))) return ids;
    return Int32List.fromList(
      ids.where((id) => id != 0 && connected.contains(id)).toList(),
    );
  }

  // The web engine's dart:ui declares `textDirection` optional and `linkUrl`
  // as `String?`; accept both shapes so the shared entry point compiles there.
  @override
  void updateNode({
    required int id,
    required ui.SemanticsFlags flags,
    required int actions,
    required int maxValueLength,
    required int currentValueLength,
    required int textSelectionBase,
    required int textSelectionExtent,
    required int platformViewId,
    required int scrollChildren,
    required int scrollIndex,
    required int traversalParent,
    required double scrollPosition,
    required double scrollExtentMax,
    required double scrollExtentMin,
    required ui.Rect rect,
    required String identifier,
    required String label,
    required List<ui.StringAttribute> labelAttributes,
    required String value,
    required List<ui.StringAttribute> valueAttributes,
    required String increasedValue,
    required List<ui.StringAttribute> increasedValueAttributes,
    required String decreasedValue,
    required List<ui.StringAttribute> decreasedValueAttributes,
    required String hint,
    required List<ui.StringAttribute> hintAttributes,
    required String tooltip,
    ui.TextDirection? textDirection,
    required Float64List transform,
    required Float64List hitTestTransform,
    required Int32List childrenInTraversalOrder,
    required Int32List childrenInHitTestOrder,
    required Int32List additionalActions,
    int headingLevel = 0,
    String? linkUrl,
    ui.SemanticsRole role = ui.SemanticsRole.none,
    required List<String>? controlsNodes,
    ui.SemanticsValidationResult validationResult =
        ui.SemanticsValidationResult.none,
    ui.SemanticsHitTestBehavior hitTestBehavior =
        ui.SemanticsHitTestBehavior.defer,
    required ui.SemanticsInputType inputType,
    required ui.Locale? locale,
    required String minValue,
    required String maxValue,
  }) {
    if (!connected.contains(id)) onDiscard?.call(id);
    // Framework matrices and typed arrays can be reused and mutated after this
    // batch. Own the data that may be replayed when a hidden node reconnects.
    transform = Float64List.fromList(transform);
    hitTestTransform = Float64List.fromList(hitTestTransform);
    childrenInTraversalOrder = Int32List.fromList(childrenInTraversalOrder);
    childrenInHitTestOrder = Int32List.fromList(childrenInHitTestOrder);
    additionalActions = Int32List.fromList(additionalActions);
    labelAttributes = List.of(labelAttributes);
    valueAttributes = List.of(valueAttributes);
    increasedValueAttributes = List.of(increasedValueAttributes);
    decreasedValueAttributes = List.of(decreasedValueAttributes);
    hintAttributes = List.of(hintAttributes);
    controlsNodes = controlsNodes == null ? null : List.of(controlsNodes);
    _changed.add(id);
    updates[id] = (delegate, currentConnected) => delegate.updateNode(
      id: id,
      flags: flags,
      actions: actions,
      maxValueLength: maxValueLength,
      currentValueLength: currentValueLength,
      textSelectionBase: textSelectionBase,
      textSelectionExtent: textSelectionExtent,
      platformViewId: platformViewId,
      scrollChildren: scrollChildren,
      scrollIndex: scrollIndex,
      traversalParent: traversalParent,
      scrollPosition: scrollPosition,
      scrollExtentMax: scrollExtentMax,
      scrollExtentMin: scrollExtentMin,
      rect: rect,
      identifier: identifier,
      label: label,
      labelAttributes: labelAttributes,
      value: value,
      valueAttributes: valueAttributes,
      increasedValue: increasedValue,
      increasedValueAttributes: increasedValueAttributes,
      decreasedValue: decreasedValue,
      decreasedValueAttributes: decreasedValueAttributes,
      hint: hint,
      hintAttributes: hintAttributes,
      tooltip: tooltip,
      textDirection: textDirection,
      transform: transform,
      hitTestTransform: hitTestTransform,
      childrenInTraversalOrder: _children(
        childrenInTraversalOrder,
        currentConnected,
      ),
      childrenInHitTestOrder: _children(
        childrenInHitTestOrder,
        currentConnected,
      ),
      additionalActions: additionalActions,
      headingLevel: headingLevel,
      linkUrl: linkUrl ?? '',
      role: role,
      controlsNodes: controlsNodes,
      validationResult: validationResult,
      hitTestBehavior: hitTestBehavior,
      inputType: inputType,
      locale: locale,
      minValue: minValue,
      maxValue: maxValue,
    );
  }

  @override
  void updateCustomAction({
    required int id,
    String? label,
    String? hint,
    int overrideId = -1,
  }) => _delegate.updateCustomAction(
    id: id,
    label: label,
    hint: hint,
    overrideId: overrideId,
  );

  @override
  ui.SemanticsUpdate build() {
    // Native AX deletes unreachable nodes. A newly reachable node needs its
    // snapshot even when Flutter considers it clean and omits it from this batch.
    final pending = <int>{
      ..._changed,
      ...connected.difference(previousConnected),
    };
    for (final id in pending) {
      if (connected.contains(id)) updates[id]?.call(_delegate, connected);
    }
    previousConnected
      ..clear()
      ..addAll(connected);
    return _delegate.build();
  }
}
