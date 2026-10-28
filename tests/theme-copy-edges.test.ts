import { describe, expect, it } from 'vitest';
import { copyFixture, slotCopyFixture } from './theme-copy-fixture.js';
import { copyThemeComponent as copy } from '../src/plugin/theme-copy.js';

describe('theme copy preservation boundaries', () => {
  it('native SLOT.clone becomes FRAME while containing INSTANCE.clone preserves SLOT', () => {
    const f = slotCopyFixture();
    expect(f.slot.clone().type).toBe('FRAME');
    expect(f.source.clone().children[0].type).toBe('SLOT');
  });
  it('rejects unsupported native nodes inside SLOT before any cloning', async () => {
    const f = slotCopyFixture(); f.attach(f.slot, f.make('widget', 'WIDGET', { widgetSyncedState: { secret: 'uncovered state' } }));
    await expect(copy(f.api, f.input)).rejects.toThrow('TRANSFER_UNSUPPORTED');
    expect(f.source.clone).not.toHaveBeenCalled();
  });
  it('rejects slot vector geometry loss and actual native slot violations', async () => {
    for (const kind of ['vector', 'limits']) {
      const f = slotCopyFixture(), p = await copy(f.api, f.input);
      f.api.loadFontAsync.mockImplementation(async () => {
        const result = f.page.children.find((n: any) => n.type === 'INSTANCE' && n !== f.source);
        if (kind === 'vector') result.children[0].children[0].vectorPaths = [];
        else result.children[0].limitViolations = ['ABOVE_MAX'];
      });
      await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('TRANSFER_VALIDATION_FAILED');
      expect(f.page.children).toEqual([f.source]);
    }
  });
  it('rejects changed result during final inventory instead of adopting new baseline', async () => {
    const f = copyFixture(), p = await copy(f.api, f.input);
    const get = f.api.getNodeByIdAsync.getMockImplementation()!;
    f.api.getNodeByIdAsync.mockImplementation(async (id: string) => {
      const n = await get(id);
      if (n?.type === 'INSTANCE' && n !== f.source) n.width = 999;
      return n;
    });
    await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.page.children).toEqual([f.source]);
  });
  it('rejects result main changed during final source capture', async () => {
    const f = copyFixture(), p = await copy(f.api, f.input);
    let inventoried = false;
    const get = f.api.getNodeByIdAsync.getMockImplementation()!;
    f.api.getNodeByIdAsync.mockImplementation(async (id: string) => {
      const n = await get(id); if (n?.type === 'INSTANCE' && n !== f.source) inventoried = true; return n;
    });
    f.source.getMainComponentAsync.mockImplementation(async () => {
      const result = f.page.children.find((n: any) => n !== f.source);
      if (inventoried && result?.getMainComponentAsync.mock.calls.length >= 4) result.main = f.dark;
      return f.dark;
    });
    await expect(copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.page.children).toEqual([f.source]);
  });
  it('rechecks source links after final output main reads even when masters are empty', async () => {
    const f = copyFixture();
    f.text.remove(); f.darkText.remove(); f.lightText.remove();
    f.dark.componentPropertyDefinitions = {}; f.light.componentPropertyDefinitions = {}; f.source.componentProperties = {};
    const alternate = f.make('alternate-main', 'COMPONENT'); f.attach(f.kit, alternate);
    const input = { ...f.input, mappings: [{ sourceId: 'dark', targetId: 'light' }], layerMap: {} }, p = await copy(f.api, input);
    const clone = f.source.clone.getMockImplementation()!;
    f.source.clone.mockImplementation(() => {
      const result = clone();
      result.getMainComponentAsync.mockImplementation(async () => {
        if (result.getMainComponentAsync.mock.calls.length >= 5) f.source.main = alternate;
        return result.main;
      });
      return result;
    });
    await expect(copy(f.api, { ...input, dryRun: false, expectedState: p.expectedState })).rejects.toThrow('SOURCE_CHANGED');
    expect(f.page.children).toEqual([f.source]);
  });
  it('does not cascade-delete an unrelated node moved into copied SLOT during await', async () => {
    const f = slotCopyFixture(), unrelated = f.make('unrelated', 'RECTANGLE'); f.attach(f.page, unrelated);
    const p = await copy(f.api, f.input);
    f.api.loadFontAsync.mockImplementation(async () => {
      const result = f.page.children.find((n: any) => n.type === 'INSTANCE' && n !== f.source);
      f.attach(result.children[0], unrelated); throw new Error('Concurrent scene edit');
    });
    let error: any; try { await copy(f.api, { ...f.input, dryRun: false, expectedState: p.expectedState }); } catch (e) { error = e; }
    expect(error.code).toBe('ROLLBACK_INCOMPLETE'); expect(error.details.blockingUnownedNodeIds).toContain(unrelated.id);
    expect(unrelated.removed).toBe(false); expect(unrelated.parent.type).toBe('SLOT');
  });
  it('rejects reversed mapped children before clone', async () => {
    const f = copyFixture(), sourceB = f.make('source-b', 'RECTANGLE'), targetB = f.make('target-b', 'RECTANGLE');
    f.attach(f.source, sourceB); f.attach(f.light, targetB); f.light.children.reverse();
    const input = { ...f.input, layerMap: { ...f.input.layerMap, [sourceB.id]: targetB.id } };
    await expect(copy(f.api, input)).rejects.toThrow('TRANSFER_MAPPING_REQUIRED'); expect(f.source.clone).not.toHaveBeenCalled();
  });
});
