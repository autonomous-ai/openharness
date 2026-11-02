import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// A [ListView] whose rows stay safe to hit test while they are kept alive off
/// screen. Every list of rows that can show a [Tooltip] uses it.
///
/// A plain list leaves a kept-alive row out of layout. An [InkWell] keeps its
/// row alive while it is hovered, and a [Tooltip] on that row opens its overlay
/// box in the [Overlay], not in the list. If the row falls past the list's
/// trailing edge in the frame the tooltip opens, the box joins the Overlay and
/// is never laid out. Every later hit test then throws "Cannot hit test a render
/// box that has never been laid out", the mouse tracker never reaches the row's
/// exit, and clicks stay dead until the app restarts.
///
/// A list with an item extent does not need this: its rows are tightly sized,
/// so each one is a relayout boundary that Flutter lays out wherever it is.
class LaidOutListView extends ListView {
  LaidOutListView({
    super.key,
    super.scrollDirection,
    super.reverse,
    super.controller,
    super.primary,
    super.physics,
    super.shrinkWrap,
    super.padding,
    super.scrollCacheExtent,
    super.children,
    super.semanticChildCount,
    super.keyboardDismissBehavior,
    super.restorationId,
    super.clipBehavior,
  });

  LaidOutListView.builder({
    super.key,
    super.scrollDirection,
    super.reverse,
    super.controller,
    super.primary,
    super.physics,
    super.shrinkWrap,
    super.padding,
    required super.itemBuilder,
    super.findChildIndexCallback,
    super.itemCount,
    super.scrollCacheExtent,
    super.semanticChildCount,
    super.keyboardDismissBehavior,
    super.restorationId,
    super.clipBehavior,
  }) : super.builder();

  LaidOutListView.separated({
    super.key,
    super.scrollDirection,
    super.reverse,
    super.controller,
    super.primary,
    super.physics,
    super.shrinkWrap,
    super.padding,
    required super.itemBuilder,
    required super.separatorBuilder,
    required super.itemCount,
    super.findChildIndexCallback,
    super.scrollCacheExtent,
    super.keyboardDismissBehavior,
    super.restorationId,
    super.clipBehavior,
  }) : super.separated();

  @override
  Widget buildChildLayout(BuildContext context) =>
      LaidOutSliverList(delegate: childrenDelegate);
}

/// The sliver of [LaidOutListView], for a [CustomScrollView] of the same rows.
class LaidOutSliverList extends SliverList {
  const LaidOutSliverList({super.key, required super.delegate});

  @override
  RenderSliverList createRenderObject(BuildContext context) =>
      _RenderLaidOutSliverList(
        childManager: context as SliverMultiBoxAdaptorElement,
      );
}

class _RenderLaidOutSliverList extends RenderSliverList {
  _RenderLaidOutSliverList({required super.childManager});

  @override
  void performLayout() {
    super.performLayout();
    // Layout returns at once for a clean row with the same constraints, so
    // this costs only what a kept-alive row actually needs.
    final rowConstraints = constraints.asBoxConstraints();
    visitChildren((child) {
      final row = child as RenderBox;
      final data = row.parentData! as SliverMultiBoxAdaptorParentData;
      if (data.keptAlive) row.layout(rowConstraints, parentUsesSize: true);
    });
  }
}
