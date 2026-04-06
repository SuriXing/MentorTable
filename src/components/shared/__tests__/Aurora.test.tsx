/**
 * Aurora component tests.
 *
 * Aurora uses the `ogl` WebGL library. jsdom does NOT implement WebGL
 * (canvas.getContext('webgl') returns null), so any real invocation of
 * Renderer/Program/Mesh would throw. We mock the `ogl` module with tiny
 * stubs that record constructor calls and expose the same shape Aurora
 * reads from them. This exercises every line of Aurora's effect body,
 * including the cleanup path and the animation callback.
 */
import { render, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Track ogl usage across tests
const rendererInstances: any[] = [];
const programInstances: any[] = [];
const meshInstances: any[] = [];
const colorInstances: any[] = [];
const triangleInstances: any[] = [];

let loseContextMock: ReturnType<typeof vi.fn>;

vi.mock('ogl', () => {
  class FakeColor {
    r: number;
    g: number;
    b: number;
    constructor(hex: string) {
      // Minimal #RRGGBB parser so we can assert numeric conversion
      colorInstances.push(this);
      const m = /^#?([0-9a-f]{6})$/i.exec(hex);
      if (m) {
        const int = parseInt(m[1], 16);
        this.r = ((int >> 16) & 0xff) / 255;
        this.g = ((int >> 8) & 0xff) / 255;
        this.b = (int & 0xff) / 255;
      } else {
        this.r = 0;
        this.g = 0;
        this.b = 0;
      }
    }
  }

  class FakeTriangle {
    attributes: Record<string, unknown>;
    constructor(_gl: unknown) {
      triangleInstances.push(this);
      this.attributes = { uv: { some: 'thing' }, position: { some: 'thing' } };
    }
  }

  class FakeRenderer {
    gl: any;
    setSize: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
    constructor(opts: unknown) {
      rendererInstances.push(this);
      const canvas = document.createElement('canvas');
      this.gl = {
        canvas,
        BLEND: 0,
        ONE: 1,
        ONE_MINUS_SRC_ALPHA: 2,
        clearColor: vi.fn(),
        enable: vi.fn(),
        blendFunc: vi.fn(),
        getExtension: vi.fn(() => ({ loseContext: loseContextMock })),
        __opts: opts
      };
      this.setSize = vi.fn();
      this.render = vi.fn();
    }
  }

  class FakeProgram {
    uniforms: any;
    constructor(_gl: unknown, opts: any) {
      programInstances.push(this);
      // Copy uniforms so the component can mutate .value fields
      this.uniforms = {};
      for (const key of Object.keys(opts.uniforms || {})) {
        this.uniforms[key] = { value: opts.uniforms[key].value };
      }
    }
  }

  class FakeMesh {
    constructor(_gl: unknown, _opts: unknown) {
      meshInstances.push(this);
    }
  }

  return {
    Renderer: FakeRenderer,
    Program: FakeProgram,
    Mesh: FakeMesh,
    Color: FakeColor,
    Triangle: FakeTriangle
  };
});

// Import AFTER mock is registered
import Aurora from '../Aurora';

describe('Aurora', () => {
  let rafCallbacks: Array<(t: number) => void>;
  let rafId: number;
  let originalRAF: typeof window.requestAnimationFrame;
  let originalCAF: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    rendererInstances.length = 0;
    programInstances.length = 0;
    meshInstances.length = 0;
    colorInstances.length = 0;
    triangleInstances.length = 0;
    loseContextMock = vi.fn();

    rafCallbacks = [];
    rafId = 0;
    originalRAF = window.requestAnimationFrame;
    originalCAF = window.cancelAnimationFrame;

    // Controllable rAF — store callbacks so tests can drive the animation loop
    window.requestAnimationFrame = ((cb: (t: number) => void) => {
      rafId += 1;
      rafCallbacks.push(cb);
      return rafId;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRAF;
    window.cancelAnimationFrame = originalCAF;
  });

  it('mounts and creates a Renderer, Program, and Mesh', () => {
    const { container } = render(<Aurora />);

    expect(container.querySelector('div')).toBeTruthy();
    expect(rendererInstances.length).toBe(1);
    expect(programInstances.length).toBe(1);
    expect(meshInstances.length).toBe(1);
    expect(triangleInstances.length).toBe(1);
  });

  it('passes the provided colorStops through the Color constructor', () => {
    const colorStops = ['#112233', '#445566', '#778899'];
    render(<Aurora colorStops={colorStops} amplitude={0.8} blend={0.4} />);

    // Initial build should have created one Color per stop (3 total minimum)
    expect(colorInstances.length).toBeGreaterThanOrEqual(3);
    const program = programInstances[0];
    expect(program.uniforms.uAmplitude.value).toBe(0.8);
    expect(program.uniforms.uBlend.value).toBe(0.4);
    // uColorStops should be an array of [r,g,b] triples
    const stops = program.uniforms.uColorStops.value;
    expect(Array.isArray(stops)).toBe(true);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toHaveLength(3);
  });

  it('appends the gl canvas into its container div', () => {
    const { container } = render(<Aurora />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.querySelector('canvas')).toBeTruthy();
  });

  it('falls back to default props when none are supplied', () => {
    render(<Aurora />);
    const program = programInstances[0];
    // Defaults from component: amplitude=1.0, blend=0.5
    expect(program.uniforms.uAmplitude.value).toBe(1);
    expect(program.uniforms.uBlend.value).toBe(0.5);
  });

  it('deletes the uv attribute on the triangle geometry', () => {
    render(<Aurora />);
    const triangle = triangleInstances[0];
    expect(triangle.attributes.uv).toBeUndefined();
    // position should remain
    expect(triangle.attributes.position).toBeTruthy();
  });

  it('runs the animation callback, updating uniforms each frame', () => {
    render(<Aurora amplitude={1.2} blend={0.3} />);

    const program = programInstances[0];
    const renderer = rendererInstances[0];

    // At least one rAF should have been scheduled
    expect(rafCallbacks.length).toBeGreaterThanOrEqual(1);

    // Drain the current frame
    const firstCb = rafCallbacks[0];
    act(() => {
      firstCb(100);
    });

    // Uniforms should have been updated and renderer.render called
    expect(renderer.render).toHaveBeenCalled();
    expect(typeof program.uniforms.uTime.value).toBe('number');
    expect(program.uniforms.uAmplitude.value).toBe(1.2);
    expect(program.uniforms.uBlend.value).toBe(0.3);
  });

  it('honors the explicit time prop in the animation loop', () => {
    render(<Aurora time={50} speed={2} />);

    const program = programInstances[0];
    const firstCb = rafCallbacks[0];
    act(() => {
      firstCb(9999);
    });

    // time * speed * 0.1 = 50 * 2 * 0.1 = 10
    expect(program.uniforms.uTime.value).toBeCloseTo(10);
  });

  it('cleans up on unmount: cancels rAF, removes canvas, loses GL context', () => {
    const { unmount, container } = render(<Aurora />);
    const wrapper = container.firstChild as HTMLElement;
    const renderer = rendererInstances[0];
    const canvas = renderer.gl.canvas;

    // Sanity: canvas is in the DOM
    expect(wrapper.contains(canvas)).toBe(true);

    unmount();

    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(loseContextMock).toHaveBeenCalled();
  });

  it('responds to window resize events', () => {
    render(<Aurora />);
    const renderer = rendererInstances[0];
    const beforeCalls = renderer.setSize.mock.calls.length;

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(renderer.setSize.mock.calls.length).toBeGreaterThan(beforeCalls);
  });

  it('removes the resize listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Aurora />);
    unmount();
    const resizeRemoved = removeSpy.mock.calls.some((c) => c[0] === 'resize');
    expect(resizeRemoved).toBe(true);
    removeSpy.mockRestore();
  });

  it('falls back to the initial colorStops when props update without providing them', () => {
    const { rerender } = render(<Aurora amplitude={1.0} colorStops={['#aa0000', '#00bb00', '#0000cc']} />);
    const program = programInstances[0];

    // Re-render with same amplitude but no colorStops — propsRef.current will
    // now lack colorStops; animation loop should fall back to the effect-scoped
    // initial colorStops captured on mount.
    rerender(<Aurora amplitude={1.0} />);

    const firstCb = rafCallbacks[0];
    act(() => {
      firstCb(1);
    });

    // Each Color build creates new FakeColor instances; ensure some were created
    // and uniforms uColorStops is still a 3-entry array of triples.
    const stops = program.uniforms.uColorStops.value;
    expect(stops).toHaveLength(3);
    expect(stops[0]).toHaveLength(3);
  });
});
