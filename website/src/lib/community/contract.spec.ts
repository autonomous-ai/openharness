// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as backend from '../../../../backend/src/lib/communityContract';
import { communityCategories, communityEngines, communityHarnesses, communityLimits, missingMarker } from './contract';
import { starterHarnesses } from './starters';
import { feedSorts } from './feed';
import { reportReasons } from './reports';

/** The words a backend list names, read rather than imported: those modules bring their environment and database client. */
async function listedIn(file: string, name: string): Promise<string[] | undefined> {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL(`../../../../backend/src/lib/${file}`, import.meta.url), 'utf8');
  return source.match(new RegExp(`${name} = \\[([^\\]]+)\\]`))?.[1].match(/'([a-z_]+)'/g)?.map(word => word.slice(1, -1));
}

describe('the Hub contract', () => {
  it('matches what the backend accepts', () => {
    expect(Object.fromEntries(Object.entries(communityHarnesses).map(([id, { marker }]) => [id, marker]))).toEqual(backend.communityHarnessMarkers);
    expect(communityCategories).toEqual(backend.communityCategories);
    expect(communityEngines).toEqual(backend.communityEngines);
    for (const key of ['files', 'fileChars', 'snapshotBytes', 'turns', 'turnChars'] as const)
      expect(communityLimits[key], key).toBe(backend.communityLimits[key]);
  });
  it('offers the feed orders the backend reads', async () => {
    expect([...feedSorts]).toEqual(await listedIn('communityFeed.ts', 'feedSorts'));
  });
  it('lists the same starters the backend serves', async () => {
    const { communityStarters } = await import('../../../../backend/src/lib/communityAccess');
    // In order: a popular feed keeps the backend's order among starters with as many likes.
    expect(starterHarnesses.map(item => item.id)).toEqual([...communityStarters]);
  });
  it('offers the report reasons the backend accepts', async () => {
    expect(reportReasons.map(([reason]) => reason)).toEqual(await listedIn('communityReports.ts', 'communityReportReasons'));
  });
  it('names a missing harness source', () => {
    expect(missingMarker('autonomous/blender', ['index.html'])).toBe('scenes/hello.py');
    expect(missingMarker('autonomous/blender', ['index.html', 'scenes/hello.py'])).toBeNull();
    expect(missingMarker(undefined, [])).toBeNull();
  });
});
