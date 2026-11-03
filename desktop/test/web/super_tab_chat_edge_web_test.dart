@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';

import '../support/chat_edge.dart';

/// The chat's edge under the Buddy line on the web, the same view as Desktop
/// rendered by the browser (ENGINEERING.md §10).
void main() => chatEdgeTests();
