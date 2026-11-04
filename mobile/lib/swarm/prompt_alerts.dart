import 'model.dart';

/// The "waiting at a prompt" notes of [messages] that no longer say anything,
/// by id: each agent's but its newest, and that one too once [agent] no longer
/// alerts about a prompt, or is gone. The backend stores one note per prompt
/// and has no way to take it back, so Scholes's Buddy showed one long after it
/// was answered, and a new one under every message after it (10-29). Desktop
/// hides the same notes (desktop/lib/super_tabs/prompt_alerts.dart).
Set<String> answeredPromptAlerts(
  Iterable<SuperTabMessage> messages,
  SuperTabAgent? Function(String id) agent,
) {
  final answered = <String>{}, newest = <String>{};
  for (final message in messages.toList().reversed) {
    final agentId = message.promptAlertAgentId;
    if (agentId == null) continue;
    final waiting = agent(agentId)?.alerting.contains('prompt') ?? false;
    if (!waiting || !newest.add(agentId)) answered.add(message.id);
  }
  return answered;
}
