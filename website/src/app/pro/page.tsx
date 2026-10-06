import type { Metadata } from 'next';
import ProLanding from './ProLanding';

export const metadata: Metadata = {
  metadataBase: new URL('https://harness.autonomous.ai'),
  title: 'Harness Pro — Your whole team. Within reach.',
  description:
    'Meet the larger Harness companion. Explore a touch-first way to direct Claude Code, Codex, Grok, Pi, Hermes, and more across all your machines.',
  openGraph: {
    title: 'Harness Pro — Your whole team. Within reach.',
    description:
      'Voice for your agents. A touch for everything between. Explore a quieter way to direct work in Harness.',
    images: [
      {
        url: '/pro/harness-pro-hero.webp',
        width: 1320,
        height: 1020,
        alt: 'Harness Pro with Tim and a minimal tap-to-talk interface',
      },
    ],
  },
};

export default function ProPage() {
  return <ProLanding />;
}
