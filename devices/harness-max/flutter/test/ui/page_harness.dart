// A model that records the intents the pages call, filled from the mockup's fixture, and the pumping the pages' tests
// share (images decoded before a golden is taken).
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/dev/fixtures.dart';
import 'package:harness_max_bar/model/bar_model.dart';
import 'package:harness_max_bar/model/types.dart';
import 'package:harness_max_bar/ui/bar_frame.dart';

import '../support/bar_test.dart';

/// The fixture's model with every intent recorded instead of acted on.
class RecordingModel extends BarModel {
  RecordingModel.from(BarModel m) : super(clock: m.now) {
    connected = m.connected;
    computer = m.computer;
    offersNew = m.offersNew;
    page = m.page;
    mood = m.mood;
    agents.addAll(m.agents);
    apps.addAll(m.apps);
    shownApp = m.shownApp;
    appsKnown = m.appsKnown;
    cellPage = m.cellPage;
    selectedId = m.selectedId;
    attention = m.attention;
    asks.addAll(m.asks);
    inbox.addAll(m.inbox);
    talk = m.talk;
    toast = m.toast;
  }

  /// The mockup's data ([mockupModel]) as a recording model.
  factory RecordingModel.mockup({String app = 'orca'}) => RecordingModel.from(mockupModel(app: app));

  final List<String> calls = [];

  @override
  void touched() {}
  @override
  void choose(int option) => calls.add('choose $option');
  @override
  void allow() => calls.add('allow');
  @override
  void deny() => calls.add('deny');
  @override
  void sayIt() => calls.add('sayIt');
  @override
  void away() => calls.add('away');
  @override
  void tapNotice(Notice notice) => calls.add('tapNotice ${notice.name}');
  @override
  void closeList() => calls.add('closeList');
  @override
  void pickApp(String appId) => calls.add('pickApp $appId');
  @override
  void newHarness() => calls.add('newHarness');
  @override
  void wake() => calls.add('wake');
  @override
  void tapToast() => calls.add('tapToast');
}

/// Pumps [child] on the bar's glass and decodes the images on it (app icons), so a golden shows them.
Future<void> pumpPage(WidgetTester tester, Widget child) async {
  await pumpOnBar(tester, child);
  await tester.runAsync(() async {
    for (final e in find.byType(Image).evaluate().toList()) {
      await precacheImage((e.widget as Image).image, e);
    }
  });
  await tester.pump();
}

/// Matches the whole glass against [golden] with the mockup's glows drawn. flutter_test paints a BoxShadow unblurred
/// ([debugDisableShadows]) and checks the switch is back when the test ends, so the blur is on only while the frame the
/// golden takes is painted.
Future<void> expectGlass(WidgetTester tester, String golden) async {
  debugDisableShadows = false;
  try {
    void repaint(RenderObject o) {
      o.markNeedsPaint();
      o.visitChildren(repaint);
    }

    tester.binding.renderViews.forEach(repaint);
    await tester.pump();
    await expectLater(find.byType(BarFrame), matchesGoldenFile(golden));
  } finally {
    debugDisableShadows = true;
  }
}
