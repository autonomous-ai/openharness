// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as backend from '../../../../backend/src/lib/communityContract';
import { communityCategories, communityEngines, communityHarnesses, communityLimits, missingMarker } from './contract';
import { starterHarnesses } from './starters';

describe('the Hub contract', () => {
  it('matches what the backend accepts', () => {
    expect(Object.fromEntries(Object.entries(communityHarnesses).map(([id, { marker }]) => [id, marker]))).toEqual(backend.communityHarnessMarkers);
    expect(communityCategories).toEqual(backend.communityCategories);
    expect(communityEngines).toEqual(backend.communityEngines);
    for (const key of ['files', 'fileChars', 'snapshotBytes', 'turns', 'turnChars'] as const)
      expect(communityLimits[key], key).toBe(backend.communityLimits[key]);
  });
  it('lists the same starters the backend serves', async () => {
    const { communityStarters } = await import('../../../../backend/src/lib/communityAccess');
    expect(new Set(starterHarnesses.map(item => item.id))).toEqual(communityStarters);
  });
  it('names a missing harness source', () => {
    expect(missingMarker('autonomous/blender', ['index.html'])).toBe('scenes/hello.py');
    expect(missingMarker('autonomous/blender', ['index.html', 'scenes/hello.py'])).toBeNull();
    expect(missingMarker(undefined, [])).toBeNull();
  });
});
