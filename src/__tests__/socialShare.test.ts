import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * F156 regression guard: the social share card must be a real PNG that
 * crawlers (WeChat/X/Facebook) accept, referenced with absolute URLs, and
 * index.html must keep its canonical + og:url pair. The old state shipped an
 * SVG og:image, which every major crawler silently ignores — blank share
 * cards on the primary growth surface.
 *
 * These checks live next to the source files so drift fails CI, not a
 * quarterly "why is our share card blank" hunt.
 */
describe('social share card (F156)', () => {
  const root = resolve(__dirname, '../..');
  const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

  it('og-image.png exists and is a real 1200x630 PNG (not the old SVG)', () => {
    const pngPath = resolve(root, 'public/og-image.png');
    expect(existsSync(pngPath)).toBe(true);
    const buf = readFileSync(pngPath);
    // PNG magic number + IHDR dimensions (big-endian width/height at bytes 16-23).
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  });

  it('index.html references the PNG with absolute crawler-safe URLs', () => {
    expect(indexHtml).toContain('content="https://mentor-table.vercel.app/og-image.png"');
    expect(indexHtml).not.toContain('/og-image.svg');
    expect(indexHtml).not.toContain('content="/og-image.png"');
  });

  it('index.html keeps canonical and og:url in sync', () => {
    expect(indexHtml).toContain('rel="canonical" href="https://mentor-table.vercel.app/"');
    expect(indexHtml).toContain('property="og:url" content="https://mentor-table.vercel.app/"');
  });

  it('robots.txt exists, allows crawling, and disallows the API', () => {
    const robots = readFileSync(resolve(root, 'public/robots.txt'), 'utf8');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Disallow: /api/');
  });
});
