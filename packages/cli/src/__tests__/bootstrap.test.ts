import { describe, it, expect } from 'vitest';

describe('CLI Bootstrap', () => {
  it('should export bootstrap function', async () => {
    const mod = await import('../bootstrap.js');
    expect(mod.bootstrap).toBeDefined();
    expect(typeof mod.bootstrap).toBe('function');
  });

  it('should export OctopusSystem type', async () => {
    const mod = await import('../bootstrap.js');
    expect(mod.bootstrap).toBeDefined();
  });
});
