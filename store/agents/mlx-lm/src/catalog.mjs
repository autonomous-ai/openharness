export const CATALOG = [
  { id: 'qwen3:0.6b', name: 'Qwen 3 · 0.6B', purpose: 'A lightweight first model', description: 'Quick to download. Good for trying the harness, short answers, and simple tasks.', downloadGB: 0.523, use: 'general', small: true, source: 'https://ollama.com/library/qwen3:0.6b' },
  { id: 'qwen2.5-coder:1.5b', name: 'Qwen 2.5 Coder · 1.5B', purpose: 'Small coding assistant', description: 'A compact model for code snippets, explanations, and simple programming tasks.', downloadGB: 0.986, use: 'coding', small: true, source: 'https://ollama.com/library/qwen2.5-coder:1.5b' },
  { id: 'gemma3:1b', name: 'Gemma 3 · 1B', purpose: 'Everyday text tasks', description: 'A small text-only model for summarizing, rewriting, and everyday questions.', downloadGB: 0.815, use: 'writing', small: true, source: 'https://ollama.com/library/gemma3:1b' },
];
export const DEFAULT_MODEL = CATALOG[0].id;
