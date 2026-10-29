import { describe, expect, it } from 'vitest';
import { alignmentFixture } from './component-alignment-fixture.js';
import { alignComponent } from '../src/plugin/component-alignment.js';

describe('native typography snapshot coverage', () => {
  it('aligns hanging punctuation and list fields without losing target paint', async () => {
    const f = alignmentFixture();
    Object.assign(f.dt, { hangingPunctuation: true, hangingList: true });
    Object.assign(f.lt, { hangingPunctuation: false, hangingList: false });
    const preview = await alignComponent(f.api, f.input);
    const result = await alignComponent(f.api, { ...f.input, dryRun: false, expectedState: preview.expectedState });
    expect(result.status).toBe('applied');
    expect(f.lt.hangingPunctuation).toBe(true);
    expect(f.lt.hangingList).toBe(true);
    expect(f.lt.fillStyleId).toBe('light-paint');
  });
});
