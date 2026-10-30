import { expect, it } from 'vitest';
import { modalProbeSchema } from '../src/shared/modal-probe.js';

it('permits only a bounded operation, defaults to read-only, requires preview for apply', () => {
  expect(modalProbeSchema.parse({ operationId: 'probe-1' })).toEqual({ operationId: 'probe-1', dryRun: true });
  for (const bad of [{ operationId: '../x' }, { operationId: 'x', sourceId: 'existing' }, { operationId: 'x', dryRun: false }, { operationId: 'x', expectedState: 'x'.repeat(201) }]) {
    expect(() => modalProbeSchema.parse(bad)).toThrow();
  }
});
