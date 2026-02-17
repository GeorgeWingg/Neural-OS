import { describe, expect, it } from 'vitest';
import { applyRenderOutputEvent, createRenderOutputClientState, resolveCanonicalHtml } from '../services/renderOutputClient';

describe('render output client state', () => {
  it('prefers latest render_output content over fallback text', () => {
    const initial = createRenderOutputClientState();
    expect(resolveCanonicalHtml(initial, '<div>fallback</div>')).toBe('<div>fallback</div>');

    const firstRender = applyRenderOutputEvent(initial, {
      type: 'render_output',
      revision: 1,
      html: '<div>render 1</div>',
    });
    expect(resolveCanonicalHtml(firstRender, '<div>fallback</div>')).toBe('<div>render 1</div>');

    const secondRender = applyRenderOutputEvent(firstRender, {
      type: 'render_output',
      revision: 2,
      html: '<div>render 2</div>',
    });
    expect(resolveCanonicalHtml(secondRender, '<div>fallback</div>')).toBe('<div>render 2</div>');
  });
});
