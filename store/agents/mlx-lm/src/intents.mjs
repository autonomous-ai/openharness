import { CATALOG, DEFAULT_MODEL } from './catalog.mjs';
import { validateModel } from './ollama.mjs';

export const HELP = 'Try “run a lightweight model”, “find a model for coding”, “benchmark it”, “ask it: explain unified memory”, or “free up memory”. You can also name any local Ollama model, such as qwen3:0.6b.';

// Only explicit operational requests enter the executor. Model replies are text,
// never instructions. There is no shell-command generation or eval here.
export function resolveIntent(input, { models = [], selectedModel, profile = {} } = {}) {
  const catalog = profile.catalog || CATALOG;
  const defaultModel = profile.defaultModel || DEFAULT_MODEL;
  const normalize = profile.validateModel || validateModel;
  const help = profile.help || HELP;
  if (typeof input !== 'string' || !input.trim() || input.length > 4000) throw new Error('Enter a request between 1 and 4,000 characters.');
  const text = input.trim();
  const lower = text.toLowerCase();
  const selected = selectedModel ? normalize(selectedModel) : null;
  const preferred = selected || models.find(m => m.running)?.id || models[0]?.id;
  const action = (type, props = {}) => ({ kind: 'action', action: { type, ...props } });
  const reply = message => ({ kind: 'reply', message });
  const choose = () => reply('Which model? Select one in the model map, or include its name in your request.');
  // Prompt contents must never be parsed as commands or model identifiers.
  const ask = text.match(/^(?:(?:please |can you )?)(?:ask|tell|chat with)\s+(.+?)\s*:\s*([\s\S]+)$/i);
  if (ask) {
    const target = /^(it|me|us|the model|my model)$/i.test(ask[1]) ? preferred : normalize(ask[1].trim());
    return target ? action('chat', { model: target, prompt: ask[2] }) : choose();
  }
  const names = [...new Set([...models.map(m => m.id), ...catalog.map(m => m.id)])];
  const mentioned = names.filter(name => lower.includes(name.toLowerCase()));
  for (const match of text.matchAll(profile.modelPattern || /\b(?:[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*\b/g)) {
    if (!mentioned.includes(match[0]) && !/^\d+:\d+$/.test(match[0])) mentioned.push(normalize(match[0]));
  }
  const modelForTask = /cod(?:e|ing)|programming/.test(lower) ? catalog[1].id : /writing|summari[sz]|rewrite/.test(lower) ? catalog[2].id : defaultModel;
  const lead = lower.replace(/^(?:please\s+|(?:can|could|would) you\s+|i(?:'d| would) like (?:you )?to\s+|i want (?:you )?to\s+)+/, '');
  if (/\b(don['’]?t|do not|never|not yet|cancel|abort)\b/.test(lower) && /\b(run|load|download|deploy|start|stop|unload|benchmark|compare|cancel|abort)\b/.test(lower)) return reply('I haven’t started an action. Use the Cancel button on an active job to stop it.');
  if (/^(how (?:do|would|can|should)|what (?:if|happens)|why|explain|help)\b/.test(lead)) return reply(help);
  if (/^(show|list|what|which|check|status|refresh)\b/.test(lead) && /models?|running|loaded|status|memory|installed/.test(lead) || /^(status|models|refresh)[.!?]?$/.test(lead)) return { kind: 'inventory' };
  if (/^(find|recommend|suggest|pick|choose|what['’]?s|what is)\b/.test(lead) && /model|coding|writing/.test(lead)) return { kind: 'catalog', message: 'Start small, then choose a larger model once you have a baseline. These downloads run locally on this Mac.', models: /coding|code|programming/.test(lower) ? [catalog[1]] : /writing|summari[sz]/.test(lower) ? [catalog[2]] : catalog };
  if (/^(delete|remove|erase)\b/.test(lead)) return reply('This pilot keeps downloaded models on disk. To release their memory, say “unload it” or “free up memory”.');
  if (/^(free (?:up )?(?:my |the )?memory|unload all(?: models)?|stop all(?: models)?|release (?:all )?memory)[.!?]?$/.test(lead)) return action('unload_all');
  if (/^(start|launch|open) (?:the )?(?:ollama|mlx(?:-lm)?|runtime|server)[.!?]?$/.test(lead)) return action('start');

  const operation = lead.match(/^(run|deploy|load|start|download|pull|install|unload|stop|benchmark|test|measure|compare)\b/);
  if (operation) {
    if (/\b(?:and then|then|after that)\b/.test(lead) || /\band\s+(run|deploy|download|stop|unload|benchmark|ask)\b/.test(lead)) return reply('Let’s do one operation at a time. Start with the first request, then ask for the next step when it finishes.');
    const verb = operation[1];
    const rest = lead.slice(verb.length).trim().replace(/[.!?]+$/, '');
    let model = mentioned[0];
    if (!model && /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/.test(rest) && !/^(it|this|that|model|ollama|speed|performance|all)$/.test(rest)) {
      model = names.find(name => name.split(':')[0] === rest) || normalize(rest);
    }
    if (!model && /\b(it|this model|that model|my model|the model|the running model)\b/.test(rest)) model = preferred;
    if (['benchmark', 'test', 'measure', 'compare'].includes(verb)) {
      if (verb === 'compare' && /\ball\b/.test(rest)) return models.length > 4 ? reply('This pilot compares up to four models at a time. Name the models to compare.') : models.length ? action('benchmark', { models: models.map(m => m.id) }) : choose();
      const targets = mentioned.length ? mentioned : model ? [model] : preferred ? [preferred] : [];
      if (verb === 'compare' && targets.length < 2) return reply('Name two models from this framework to compare. Each gets the same prompt and settings.');
      return targets.length ? action('benchmark', { models: targets }) : choose();
    }
    if (['unload', 'stop'].includes(verb)) return model ? action('unload', { model }) : choose();
    if (!model && /\b(lightweight|small|tiny|fast|coding|writing|starter|first)\b/.test(rest)) model = modelForTask;
    if (!model) return reply('Name the model you want, or say “run a lightweight model” and I’ll use Qwen 3 0.6B.');
    return action(['download', 'pull', 'install'].includes(verb) ? 'download' : 'deploy', { model });
  }
  if (/\b(benchmark|speed|fast|tokens per second|performance)\b/.test(lower) && /^(how|test|measure)\b/.test(lead)) return preferred ? action('benchmark', { models: [preferred] }) : choose();
  if (/^(chat|talk)(?: with| to)?(?: it| the model)?[.!?]?$/.test(lead)) return preferred ? reply(`${preferred} is selected. Ask a question below, or say “ask it: …”.`) : choose();
  if (/^(run|deploy|download|load|start|stop|unload|benchmark|compare|install|delete|remove)\b/.test(lead) || /\b(shell|terminal|sudo|rm -rf)\b/.test(lower)) return reply(help);
  return preferred ? action('chat', { model: preferred, prompt: text }) : reply(help);
}

export function validateAction(input, normalize = validateModel) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provide a model action.');
  const { type } = input;
  if (!['start', 'download', 'deploy', 'unload', 'unload_all', 'benchmark', 'chat'].includes(type)) throw new Error('That action is not supported by this pilot.');
  const action = { type };
  if (['download', 'deploy', 'unload', 'chat'].includes(type)) action.model = normalize(input.model);
  if (type === 'benchmark') {
    if (!Array.isArray(input.models) || !input.models.length || input.models.length > 4) throw new Error('Benchmark between one and four models at a time.');
    action.models = [...new Set(input.models.map(normalize))];
  }
  if (type === 'chat') {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw new Error('Enter a prompt between 1 and 4,000 characters.');
    action.prompt = input.prompt.trim();
    action.history = [];
    if (Array.isArray(input.history)) {
      action.history = input.history.slice(-6).map(m => {
        if (!['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 6000) throw new Error('Invalid chat history.');
        return { role: m.role, content: m.content };
      });
    }
  }
  return action;
}
