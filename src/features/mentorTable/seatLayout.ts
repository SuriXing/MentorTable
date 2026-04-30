/**
 * Table seat geometry, in one home. The page used to carry seatPoint,
 * seatStyle, and floatingCardPlacement inline — pure layout math with zero
 * React dependencies, testable without rendering anything.
 */

import type { CSSProperties } from 'react';

export interface SeatPoint {
  x: number;
  y: number;
}

/** Arc position (percent coordinates) for mentor `index` of `total`. */
export const seatPoint = (index: number, total: number): SeatPoint => {
  if (total <= 1) return { x: 50, y: 34 };
  const angleStart = 200;
  const angleEnd = 340;
  const angle = angleStart + ((angleEnd - angleStart) * index) / Math.max(total - 1, 1);
  const rad = (angle * Math.PI) / 180;
  const rX = total > 6 ? 42 : 38;
  const rY = total > 6 ? 13 : 11;
  const x = 50 + rX * Math.cos(rad);
  const y = 48 + rY * Math.sin(rad);
  return { x, y };
};

export const seatStyle = (index: number, total: number): CSSProperties => {
  const { x, y } = seatPoint(index, total);
  return { left: `${x}%`, top: `${y}%` };
};

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Placement for a mentor's floating suggestion card: width from the
 * nearest neighbor gap, clamped into the seat lane, kept above the name
 * plate zone.
 */
export const floatingCardPlacement = (
  mentorIndex: number,
  totalMentors: number
): CSSProperties => {
  const safeTotal = Math.max(totalMentors, 1);
  const safeIndex = Math.min(Math.max(mentorIndex, 0), safeTotal - 1);
  const lanePoints = Array.from({ length: safeTotal }, (_, idx) => seatPoint(idx, safeTotal));
  // lanePoints has exactly safeTotal entries and safeIndex is clamped to
  // [0, safeTotal-1], so lanePoints[safeIndex] is always defined.
  const lane = lanePoints[safeIndex];
  const prevLane = safeIndex > 0 ? lanePoints[safeIndex - 1] : null;
  const nextLane = safeIndex < safeTotal - 1 ? lanePoints[safeIndex + 1] : null;
  const leftGap = prevLane ? Math.abs(lane.x - prevLane.x) : Number.POSITIVE_INFINITY;
  const rightGap = nextLane ? Math.abs(nextLane.x - lane.x) : Number.POSITIVE_INFINITY;
  const nearestGap = Math.min(leftGap, rightGap);
  const widthPercent = Number.isFinite(nearestGap) ? clampNumber(nearestGap * 0.82, 8.5, 22) : 22;
  const widthCapPx = safeTotal <= 2 ? 250 : safeTotal <= 4 ? 210 : safeTotal <= 6 ? 170 : safeTotal <= 8 ? 150 : 130;
  const safeInset = widthPercent / 2 + 1.25;
  const left = clampNumber(lane.x, safeInset, 100 - safeInset);
  // Keep notes above the mentor name plate zone.
  const top = clampNumber(lane.y - 26.5, 10, 16.5);

  return {
    ['--mentor-card-left' as string]: `${left}%`,
    ['--mentor-card-top' as string]: `${top}%`,
    ['--mentor-card-rotate' as string]: '0deg',
    ['--mentor-card-width' as string]: `${widthPercent}%`,
    ['--mentor-card-max' as string]: `${widthCapPx}px`
  };
};
