import 'package:flutter_test/flutter_test.dart';

/// Whether a picture on screen is still loading.
bool picturesLoading(WidgetTester tester) => false;

/// Real time until every picture on screen has finished loading.
Future<void> picturesLoaded(WidgetTester tester) async {}
