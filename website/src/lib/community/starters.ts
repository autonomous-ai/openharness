import featured from './featured.json';
import type { HarnessSummary, ConversationTurn } from './types';

const entries = [
  ['pocket-film', 'Pocket launch film', 'A small app, a little motion, and a launch worth watching.', 'Motion', 'Turn a small budgeting app into a short launch film. Use lavender, confident typography, and a simple phone mockup.', 'Make it playable and scrubbable. Keep the final frame on screen long enough to read.'],
  ['moonlight', 'One more jump', 'A tiny moonlit platformer. Take the long way to the last star.', 'Games', 'Build a playable platformer in a moonlit forest. Use forgiving jumps and a warm yellow character.', 'Add keyboard and touch controls, a restart button, and stars to collect.'],
  ['sales-story', 'The quarter in focus', 'A sales report that makes the important changes easy to see.', 'Data', 'Turn a sample sales dataset into a clean, interactive report with a green palette.', 'Let me compare regions. Make clear that the data is illustrative.'],
  ['pleat', 'Pleat, a study in light', 'A parametric shade. Change its silhouette and make a new form.', 'Design', 'Create a parametric pleated lampshade study with a warm material palette.', 'Add controls for the width, height, and pleats, plus an SVG export of the design.'],
  ['sunday', 'A little room to breathe', 'A quiet weekly planner that makes space for the work and the rest.', 'Apps', 'Build a warm, simple weekly planner. Use a paper-like surface and restrained serif typography.', 'Make tasks editable, let me tick them off, and add new tasks to any day.'],
  ['orbit', 'A little perspective', 'An orbital playground. Slow it down and watch the paths unfold.', 'Experiments', 'Build an interactive orbital model with a dark navy background and softly colored planets.', 'Add pause, speed, and orbit-trail controls. Say that distances and periods are illustrative.'],
  ['blue-hour', 'Blue hour', 'An eight-step instrument for finding your next small melody.', 'Music', 'Create an eight-step music sequencer in electric blue and warm cream.', 'Let me change the notes and tempo. Sound should start only when I press Play.'],
  ['field-notes', 'On paying attention', 'A small typeset book. Edit a thought, then take it to paper.', 'Documents', 'Design a short book of field notes with a rust-colored cover and generous margins.', 'Let me edit the text and print a clean version without the controls.'],
  ['make-space', 'Make some space', 'A typographic playground with room for your own words.', 'Design', 'Create an expressive poster with oversized serif type, warm orange, and a simple circle.', 'Let me change the words, switch the palette, and export the result as an SVG.'],
] as const;

const basicHarnesses: HarnessSummary[] = entries.map(([slug, title, description, category]) => ({
  id: `starter-${slug}`, title, description, category, engine: 'Codex',
  authorId: 'harness', authorName: 'Harness', example: true,
  cover: `/open-harnesses/${slug}/cover.svg`, createdAt: '2026-10-05T00:00:00.000Z',
}));


const specialized = [...featured,
  { slug: 'harness-keynote', title: 'Go make something', description: 'The existing Harness Store keynote. Seven slides and a place for your own story.', category: 'Documents', harnessId: 'autonomous/marp', harnessName: 'Marp', cover: 'cover.svg', prompt: 'Create a keynote introducing the Harness Store: why it exists, what a harness includes, and a few things people can make.', result: 'Reused from the existing Marp project: deck.md, its generated artwork, and speaker notes. The preview is rendered from that Markdown; the fork opens the Marp viewer with Codex.' }
];
export const starterHarnesses: HarnessSummary[] = [
  ...specialized.map(({ slug, title, description, category, harnessId, harnessName, cover, ...extra }) => ({ id: `starter-${slug}`, title, description, category, harnessId, harnessName, ...('recording' in extra ? { recording: extra.recording as string } : {}), engine: 'Codex', authorId: 'harness', authorName: 'Harness', example: true, cover: `/open-harnesses/${slug}/${cover}`, createdAt: '2026-10-05T00:00:00.000Z' })),
  ...basicHarnesses,
];

export function starterConversation(id: string): ConversationTurn[] {
  const existing = specialized.find(item => `starter-${item.slug}` === id);
  if (existing) return [{ role: 'user', text: existing.prompt }, { role: 'assistant', text: existing.result }];
  const entry = entries.find(([slug]) => `starter-${slug}` === id);
  if (!entry) return [];
  return [
    { role: 'user', text: entry[4] },
    { role: 'assistant', text: 'Build a self-contained HTML project. Keep the styles and interaction code editable, and use no external services or credentials.' },
    { role: 'user', text: entry[5] },
    { role: 'assistant', text: 'The included index.html is the working result. Fork it to keep the files and this example brief, then ask your agent for the next change.' },
  ];
}

export function starterSlug(id: string): string | undefined {
  return starterHarnesses.some(item => item.id === id) ? id.slice('starter-'.length) : undefined;
}
