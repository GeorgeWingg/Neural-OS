import { describe, expect, it } from 'vitest';
import {
  applyEmitScreen,
  createRenderOutputState,
  validateEmitScreenArgs,
} from '../services/renderOutputTool.mjs';

describe('render output tool helpers', () => {
  it('validateEmitScreenArgs rejects empty html', () => {
    const result = validateEmitScreenArgs({ html: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected validation failure');
    }
    expect(result.error).toContain('non-empty html');
  });

  it('applyEmitScreen emits incrementing revisions and tracks latest html', () => {
    const firstValidation = validateEmitScreenArgs({ html: '<div>first</div>', isFinal: false });
    const secondValidation = validateEmitScreenArgs({ html: '<div>second</div>', isFinal: true });
    if (!firstValidation.ok || !secondValidation.ok) {
      throw new Error('validation unexpectedly failed');
    }

    const first = applyEmitScreen(createRenderOutputState(), firstValidation.value, {
      toolName: 'emit_screen',
      toolCallId: 'call_1',
    });
    expect(first.streamEvent.type).toBe('render_output');
    expect(first.streamEvent.revision).toBe(1);
    expect(first.nextState.latestHtml).toBe('<div>first</div>');

    const second = applyEmitScreen(first.nextState, secondValidation.value, {
      toolName: 'emit_screen',
      toolCallId: 'call_2',
    });
    expect(second.streamEvent.revision).toBe(2);
    expect(second.streamEvent.isFinal).toBe(true);
    expect(second.nextState.latestHtml).toBe('<div>second</div>');
  });
});
