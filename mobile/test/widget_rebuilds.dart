import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Counts, from now until the test ends, every widget rebuilt at or under a
/// [T] — whether a listener marked it dirty or a parent handed it a new
/// widget. Read the count with the function returned.
///
/// Through the framework's own debug hook, which every rebuilt element passes
/// (`Element.rebuild`), so nothing in the app is instrumented for it.
int Function() countRebuildsUnder<T extends Widget>() => _count(
  (element) =>
      element.widget is T || element.findAncestorWidgetOfExactType<T>() != null,
);

/// Counts every rebuild of a widget whose type is one of [types].
int Function() countRebuildsOf(Set<Type> types) =>
    _count((element) => types.contains(element.widget.runtimeType));

int Function() _count(bool Function(Element element) counts) {
  var rebuilt = 0;
  final previous = debugOnRebuildDirtyWidget;
  debugOnRebuildDirtyWidget = (element, builtOnce) {
    previous?.call(element, builtOnce);
    if (counts(element)) rebuilt++;
  };
  addTearDown(() => debugOnRebuildDirtyWidget = previous);
  return () => rebuilt;
}
