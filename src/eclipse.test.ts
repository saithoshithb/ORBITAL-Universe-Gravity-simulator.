import { describe, expect, it } from 'vitest';
import { MAX_OCC, pickOccluders } from './eclipse';
import { make } from './physics/presets';

describe('eclipse occluder picking', () => {
  it('keeps the apparently largest bodies, largest first, never itself', () => {
    const self = make('gas giant', 'Jove', [0, 0, 0], [0, 0, 0], { radius: 1.4 });
    const moon = make('moon', 'Io', [3, 0, 0], [0, 0, 0], { radius: 0.25 }); // close: looks big
    const star = make('star', 'Sol', [70, 0, 0], [0, 0, 0], { radius: 3 });
    const far = Array.from({ length: 20 }, (_, i) => make('asteroid', `a${i}`, [200 + i, 0, 0], [0, 0, 0], { radius: 0.12 }));
    const out: ReturnType<typeof make>[] = [];
    const n = pickOccluders(self, [self, ...far, star, moon], out);
    expect(n).toBe(MAX_OCC);
    expect(out.slice(0, 2).map((b) => b.name)).toEqual(['Io', 'Sol']); // 0.25/1.6 > 3/68.6
    expect(out.slice(0, n)).not.toContain(self);
    const sizes = out.slice(0, n).map((b) => b.radius / (Math.hypot(...b.pos) - self.radius));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it('handles fewer candidates than slots', () => {
    const self = make('planet', 'P', [0, 0, 0], [0, 0, 0]);
    const out: ReturnType<typeof make>[] = [];
    expect(pickOccluders(self, [self], out)).toBe(0);
    expect(pickOccluders(self, [self, make('moon', 'm', [5, 0, 0], [0, 0, 0])], out)).toBe(1);
  });
});
