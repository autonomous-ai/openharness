import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Whether focus is on the element [control] finds, or on something inside it.
bool focusIsIn(Finder control) {
  final focus = FocusManager.instance.primaryFocus;
  if (focus == null || focus is FocusScopeNode || focus.context == null) {
    return false;
  }
  final element = control.evaluate().first;
  var inside = focus.context == element;
  focus.context!.visitAncestorElements((e) {
    inside = inside || e == element;
    return !inside;
  });
  return inside;
}
