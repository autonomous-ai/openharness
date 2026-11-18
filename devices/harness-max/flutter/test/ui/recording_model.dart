// A BarModel that records the intents the pages call, and the image loading the pages' goldens need.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_max_bar/model/bar_model.dart';

/// The model [from] (the mockup's fixture, tweaked), recording each intent a page calls instead of acting on it.
class RecordingModel extends BarModel {
  RecordingModel(BarModel from) : super(clock: from.now) {
    connected = from.connected;
    computer = from.computer;
    offersNew = from.offersNew;
    page = from.page;
    mood = from.mood;
    agents.addAll(from.agents);
    apps.addAll(from.apps);
    shownApp = from.shownApp;
    appsKnown = from.appsKnown;
    cellPage = from.cellPage;
    selectedId = from.selectedId;
    asks.addAll(from.asks);
    inbox.addAll(from.inbox);
    talk = from.talk;
    talkStarted = from.talkStarted;
    heard = from.heard;
    quiet = from.quiet;
    levels.addAll(from.levels);
  }

  final List<String> calls = [];

  @override
  void touched() => calls.add('touched');
  @override
  void tapCell(String agentId) => calls.add('tapCell $agentId');
  @override
  void swipeCells(int dir) => calls.add('swipeCells $dir');
  @override
  void openApps() => calls.add('openApps');
  @override
  void openInbox() => calls.add('openInbox');
  @override
  void back() => calls.add('back');
  @override
  void tapSegment(String agentId) => calls.add('tapSegment $agentId');
  @override
  void swipeAgent(int dir) => calls.add('swipeAgent $dir');
  @override
  void tapBody() => calls.add('tapBody');
  @override
  void cancelTalk() => calls.add('cancelTalk');
}

/// Decodes every Image on the glass (the app icons) for real, then draws again: flutter test's fake clock never lets
/// an asset image finish on its own.
Future<void> settleImages(WidgetTester tester) async {
  await tester.runAsync(() async {
    for (final e in find.byType(Image).evaluate()) {
      await precacheImage((e.widget as Image).image, e);
    }
  });
  await tester.pump();
}
