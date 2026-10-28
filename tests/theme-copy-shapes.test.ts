import { describe, expect, it } from 'vitest';
import { slotCopyFixture } from './theme-copy-fixture.js';
import { copyThemeComponent } from '../src/plugin/theme-copy.js';

const cases = [
  { type: 'ELLIPSE', field: 'arcData', before: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 }, after: { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0.7 } },
  { type: 'POLYGON', field: 'pointCount', before: 3, after: 6 },
  { type: 'STAR', field: 'innerRadius', before: 0.4, after: 0.8 },
  { type: 'BOOLEAN_OPERATION', field: 'booleanOperation', before: 'UNION', after: 'SUBTRACT' },
];

describe('theme copy shape content snapshots', () => {
  it.each(cases)('rejects a changed $type result on replay', async ({ type, field, before, after }) => {
    const f = slotCopyFixture();
    const shape = f.make('custom-shape', type, { [field]: before }); f.attach(f.slot, shape);
    const preview = await copyThemeComponent(f.api, f.input);
    const args = { ...f.input, dryRun: false, expectedState: preview.expectedState };
    const result = await copyThemeComponent(f.api, args);
    const copied = f.nodes.get(result.nodeMap![shape.id])!;
    expect(copied[field]).toEqual(before);
    copied[field] = after;
    await expect(copyThemeComponent(f.api, args)).rejects.toThrow('OPERATION_RESULT_CHANGED');
  });

  it.each(cases)('rolls back $type content loss during transfer', async ({ type, field, before, after }) => {
    const f = slotCopyFixture();
    const shape = f.make('custom-shape', type, { [field]: before }); f.attach(f.slot, shape);
    const preview = await copyThemeComponent(f.api, f.input);
    f.api.loadFontAsync.mockImplementation(async () => {
      const copy = f.page.children.find((n: any) => n.type === 'INSTANCE' && n !== f.source);
      copy.children[0].children.find((n: any) => n.type === type)[field] = after;
    });
    await expect(copyThemeComponent(f.api, { ...f.input, dryRun: false, expectedState: preview.expectedState })).rejects.toThrow('TRANSFER_VALIDATION_FAILED');
    expect(shape[field]).toEqual(before);
    expect(f.page.children).toEqual([f.source]);
  });
});
