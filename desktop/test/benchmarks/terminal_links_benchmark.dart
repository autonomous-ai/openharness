import 'package:flutter_test/flutter_test.dart';

import '../../tool/terminal_links_benchmark.dart' as benchmark;

void main() {
  test('terminal link hit-testing benchmark', benchmark.runLinkBenchmark);
}
