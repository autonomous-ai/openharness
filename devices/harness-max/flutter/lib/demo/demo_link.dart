// The scripted demo: a computer with three apps and their agents, inside the program (port of
// devices/harness-max/firmware/main/demo/max_demo.c's story).
import '../link/bar_link.dart';
import '../link/mic.dart';
import '../model/bar_model.dart';

class DemoLink implements BarLink {
  DemoLink(this.model, {this.mic});
  final BarModel model;
  final Mic? mic;

  @override
  Future<void> start() => throw UnimplementedError();
  @override
  Future<void> stop() => throw UnimplementedError();
  @override
  void openAgent(String agentId) => throw UnimplementedError();
  @override
  void pickApp(String appId) => throw UnimplementedError();
  @override
  void answer(String agentId, String requestId, Map<String, String> answers) => throw UnimplementedError();
  @override
  void questionRead(String agentId, String requestId, String fetch) => throw UnimplementedError();
  @override
  void answerReviewed(String agentId, String token, String fetch, List<int> choices) => throw UnimplementedError();
  @override
  void startTalk(String agentId) => throw UnimplementedError();
  @override
  void sendTalk() => throw UnimplementedError();
  @override
  void cancelTalk() => throw UnimplementedError();
  @override
  void newHarness() => throw UnimplementedError();
}
