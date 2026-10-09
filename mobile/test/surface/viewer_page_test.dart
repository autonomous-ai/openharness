import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/viewer_page.dart';

void main() {
  testWidgets('the Viewer page shows the stream and its name, and closes the surface on leave', (tester) async {
    final requests = <Map<String, dynamic>>[];
    Future<Map<String, dynamic>> request(Map<String, dynamic> payload) {
      requests.add(payload);
      if (payload['op'] == 'close') return Future.value({'closed': true});
      if (payload.containsKey('after')) return Completer<Map<String, dynamic>>().future;
      return Future.value({'data': base64Encode([1, 2, 3]), 'mime': 'image/jpeg', 'width': 390, 'height': 700, 'seq': 1});
    }
    await tester.pumpWidget(MaterialApp(home: ViewerPage.withRequest(title: 'Model viewer', request: request)));
    await tester.pump(const Duration(milliseconds: 1));
    expect(find.text('Model viewer'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    expect(requests.last['op'], 'close');
  });
}
