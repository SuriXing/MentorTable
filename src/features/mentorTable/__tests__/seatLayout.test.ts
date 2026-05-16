import { describe, expect, it } from 'vitest';
import { floatingCardPlacement, seatPoint, seatStyle } from '../seatLayout';

describe('seatLayout', () => {
  it('single mentor sits at the fixed apex seat', () => {
    expect(seatPoint(0, 1)).toEqual({ x: 50, y: 34 });
  });

  it('x progresses monotonically across the arc for any table size', () => {
    for (let total = 2; total <= 10; total += 1) {
      const xs = Array.from({ length: total }, (_, i) => seatPoint(i, total).x);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i]).toBeGreaterThan(xs[i - 1]);
      }
    }
  });

  it('seatStyle emits percent coordinates', () => {
    const style = seatStyle(2, 7);
    expect(style.left).toMatch(/%$/);
    expect(style.top).toMatch(/%$/);
  });

  it('floatingCardPlacement stays valid for every table size 1..10', () => {
    for (let total = 1; total <= 10; total += 1) {
      for (let i = 0; i < total; i += 1) {
        const placement = floatingCardPlacement(i, total) as Record<string, string>;
        const left = parseFloat(placement['--mentor-card-left']);
        const top = parseFloat(placement['--mentor-card-top']);
        const width = parseFloat(placement['--mentor-card-width']);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(100);
        expect(top).toBeGreaterThanOrEqual(10);
        expect(top).toBeLessThanOrEqual(16.5);
        expect(width).toBeGreaterThanOrEqual(8.5);
        expect(width).toBeLessThanOrEqual(22);
      }
    }
  });

  it('clamps out-of-range mentor index instead of throwing', () => {
    expect(floatingCardPlacement(-3, 4)).toBeDefined();
    expect(floatingCardPlacement(99, 4)).toBeDefined();
  });
});
