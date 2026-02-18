/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLatestReasoningPreview } from '../services/loadingPlaceholderPolicy';
import { shouldUseScriptStrippedPreview } from '../services/streamingUiPolicy';
import { ColorTheme, GenerationTimelineFrame, InteractionData, LoadingUiMode } from '../types';

interface LoadingTheme {
  bg: string;
  text: string;
  textMuted: string;
  codeBg: string;
  codeText: string;
  progressBg: string;
  progressFill: string;
  skeletonBase: string;
  skeletonShine: string;
  statusBorder: string;
  statusText: string;
  reasoningBg: string;
  reasoningBorder: string;
  reasoningLabel: string;
}

interface IframeBaseTheme {
  bg: string;
  text: string;
  controlSurface: string;
  controlBorder: string;
  placeholder: string;
  buttonHover: string;
}

function getLoadingTheme(colorTheme: ColorTheme): LoadingTheme {
  if (colorTheme === 'dark') {
    return {
      bg: '#1e1e2e',
      text: '#cdd6f4',
      textMuted: '#a6adc8',
      codeBg: '#1e1e2e',
      codeText: '#cdd6f4',
      progressBg: '#313244',
      progressFill: 'linear-gradient(90deg, #89b4fa, #b4befe, #cba6f7)',
      skeletonBase: 'linear-gradient(90deg, #313244 25%, #45475a 50%, #313244 75%)',
      skeletonShine: '#45475a',
      statusBorder: '#313244',
      statusText: '#585b70',
      reasoningBg: '#313244',
      reasoningBorder: '#cba6f7',
      reasoningLabel: '#cba6f7',
    };
  }
  if (colorTheme === 'colorful') {
    return {
      bg: 'linear-gradient(135deg, #1a1333 0%, #1e1e4e 40%, #2a1a3e 100%)',
      text: '#e0d6ff',
      textMuted: '#b8a9e0',
      codeBg: 'rgba(30, 20, 60, 0.6)',
      codeText: '#e0d6ff',
      progressBg: 'rgba(255,255,255,0.1)',
      progressFill: 'linear-gradient(90deg, #ff6ec7, #a855f7, #6366f1, #38bdf8)',
      skeletonBase: 'linear-gradient(90deg, rgba(168,85,247,0.15) 25%, rgba(99,102,241,0.25) 50%, rgba(168,85,247,0.15) 75%)',
      skeletonShine: 'rgba(168,85,247,0.3)',
      statusBorder: 'rgba(168,85,247,0.3)',
      statusText: '#b8a9e0',
      reasoningBg: 'rgba(168,85,247,0.12)',
      reasoningBorder: '#a855f7',
      reasoningLabel: '#c084fc',
    };
  }
  // light or system
  return {
    bg: '#f8f9fa',
    text: '#1e1e2e',
    textMuted: '#6b7280',
    codeBg: '#ffffff',
    codeText: '#1e1e2e',
    progressBg: '#e5e7eb',
    progressFill: 'linear-gradient(90deg, #3b82f6, #6366f1, #8b5cf6)',
    skeletonBase: 'linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%)',
    skeletonShine: '#f3f4f6',
    statusBorder: '#e5e7eb',
    statusText: '#9ca3af',
    reasoningBg: '#f3f4f6',
    reasoningBorder: '#8b5cf6',
    reasoningLabel: '#7c3aed',
  };
}

function getIframeBaseTheme(colorTheme: ColorTheme): IframeBaseTheme {
  if (colorTheme === 'dark') {
    return {
      bg: 'radial-gradient(140% 100% at 50% 0%, #17263c 0%, #0d1627 60%, #0a1220 100%)',
      text: '#e5ecff',
      controlSurface: 'rgba(15, 23, 42, 0.78)',
      controlBorder: 'rgba(148, 163, 184, 0.35)',
      placeholder: 'rgba(203, 213, 225, 0.8)',
      buttonHover: 'rgba(59, 130, 246, 0.28)',
    };
  }
  if (colorTheme === 'colorful') {
    return {
      bg: 'radial-gradient(140% 100% at 50% 0%, #1d4ed8 0%, #3730a3 55%, #312e81 100%)',
      text: '#eef2ff',
      controlSurface: 'rgba(30, 41, 59, 0.74)',
      controlBorder: 'rgba(165, 180, 252, 0.45)',
      placeholder: 'rgba(224, 231, 255, 0.85)',
      buttonHover: 'rgba(129, 140, 248, 0.35)',
    };
  }
  return {
    bg: 'radial-gradient(160% 120% at 50% 0%, #e2e8f0 0%, #dbeafe 46%, #c7d2fe 100%)',
    text: '#0f172a',
    controlSurface: 'rgba(255, 255, 255, 0.76)',
    controlBorder: 'rgba(59, 130, 246, 0.28)',
    placeholder: 'rgba(30, 41, 59, 0.55)',
    buttonHover: 'rgba(59, 130, 246, 0.16)',
  };
}

function highlightSyntaxForTheme(escaped: string, colorTheme: ColorTheme): string {
  if (colorTheme === 'light' || colorTheme === 'system') {
    return escaped
      .replace(/(\/\/.*)/g, '<span style="color:#6a737d">$1</span>')
      .replace(/(&lt;\/?[a-zA-Z][a-zA-Z0-9-]*)/g, '<span style="color:#d73a49">$1</span>')
      .replace(/(\/?&gt;)/g, '<span style="color:#d73a49">$1</span>')
      .replace(
        /\b([a-zA-Z-]+)(=)(&quot;)/g,
        '<span style="color:#22863a">$1</span><span style="color:#444">$2</span><span style="color:#032f62">$3</span>'
      )
      .replace(/(&quot;[^&]*?&quot;)/g, '<span style="color:#032f62">$1</span>')
      .replace(/\b([a-zA-Z-]+)\s*:/g, '<span style="color:#005cc5">$1</span>:')
      .replace(
        /\b(function|const|let|var|if|else|return|for|while|new|this|class|import|export|async|await|true|false|null|undefined|document|window)\b/g,
        '<span style="color:#6f42c1">$1</span>'
      )
      .replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#005cc5">$1</span>');
  }
  return escaped
    .replace(/(\/\/.*)/g, '<span style="color:#6272a4">$1</span>')
    .replace(/(&lt;\/?[a-zA-Z][a-zA-Z0-9-]*)/g, '<span style="color:#ff79c6">$1</span>')
    .replace(/(\/?&gt;)/g, '<span style="color:#ff79c6">$1</span>')
    .replace(
      /\b([a-zA-Z-]+)(=)(&quot;)/g,
      '<span style="color:#50fa7b">$1</span><span style="color:#ccc">$2</span><span style="color:#f1fa8c">$3</span>'
    )
    .replace(/(&quot;[^&]*?&quot;)/g, '<span style="color:#f1fa8c">$1</span>')
    .replace(/\b([a-zA-Z-]+)\s*:/g, '<span style="color:#8be9fd">$1</span>:')
    .replace(
      /\b(function|const|let|var|if|else|return|for|while|new|this|class|import|export|async|await|true|false|null|undefined|document|window)\b/g,
      '<span style="color:#bd93f9">$1</span>'
    )
    .replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#bd93f9">$1</span>');
}

interface GeneratedContentProps {
  htmlContent: string;
  onInteract: (data: InteractionData) => void;
  appContext: string | null;
  isLoading: boolean;
  generationTimelineFrames?: GenerationTimelineFrame[];
  appName?: string;
  appIcon?: string;
  colorTheme?: ColorTheme;
  loadingUiMode?: LoadingUiMode;
  traceId?: string;
  uiSessionId?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function estimateProgress(content: string, isLoading: boolean): number {
  if (!isLoading) return 100;
  if (!content) return 2;

  let progress = 5;

  // Use content length as early signal
  if (content.length > 100) progress = Math.max(progress, 10);
  if (content.length > 500) progress = Math.max(progress, 15);
  if (content.length > 1000) progress = Math.max(progress, 20);

  const firstTagIndex = content.search(/<[a-zA-Z]/);
  if (firstTagIndex === -1) {
    return Math.min(25, progress + Math.min(content.length / 50, 10));
  }

  progress = Math.max(progress, 28);

  // Style phase
  const styleStart = content.search(/<style/i);
  if (styleStart !== -1) {
    progress = Math.max(progress, 35);
    const styleEnd = content.search(/<\/style>/i);
    if (styleEnd === -1) {
      // Still inside style tag - estimate by content after <style
      const styleContent = content.substring(styleStart);
      if (styleContent.length > 200) progress = Math.max(progress, 40);
      if (styleContent.length > 600) progress = Math.max(progress, 45);
    } else {
      progress = Math.max(progress, 50);
    }
  }

  // Body element markers
  const divCount = (content.match(/<div[\s>]/gi) || []).length;
  const buttonCount = (content.match(/<button[\s>]/gi) || []).length;
  const interactiveCount = divCount + buttonCount;
  if (interactiveCount > 2) progress = Math.max(progress, 55);
  if (interactiveCount > 5) progress = Math.max(progress, 60);
  if (interactiveCount > 10) progress = Math.max(progress, 65);

  // Script phase
  const scriptStart = content.search(/<script/i);
  if (scriptStart !== -1) {
    progress = Math.max(progress, 72);
    const scriptContent = content.substring(scriptStart);
    if (/function\s/.test(scriptContent)) progress = Math.max(progress, 76);
    if (/addEventListener|querySelector/.test(scriptContent)) progress = Math.max(progress, 80);
    if (/\.style\.|\.classList|innerHTML/.test(scriptContent)) progress = Math.max(progress, 84);
    if (scriptContent.length > 800) progress = Math.max(progress, 88);

    if (/<\/script>/i.test(content)) {
      progress = Math.max(progress, 93);
      // Content after closing script tag
      const afterScript = content.substring(content.search(/<\/script>/i) + 9);
      if (afterScript.trim().length > 10) progress = Math.max(progress, 96);
    }
  }

  return progress;
}

function stripScriptsForPreview(markup: string): string {
  const withoutClosedScripts = markup.replace(/<script[\s\S]*?<\/script>/gi, '');
  return withoutClosedScripts.replace(/<script[\s\S]*$/gi, '');
}

function parseStreamedContent(streamedContent: string): { contentWithoutThoughts: string; reasoning: string; code: string } {
  const thoughtRegex = /<!--THOUGHT-->([\s\S]*?)<!--\/THOUGHT-->/g;
  let reasoning = '';
  let match;
  while ((match = thoughtRegex.exec(streamedContent)) !== null) {
    reasoning += match[1];
  }

  const contentWithoutThoughts = streamedContent.replace(thoughtRegex, '');
  const firstTagIndex = contentWithoutThoughts.search(/<[a-zA-Z]/);
  const code = firstTagIndex >= 0 ? contentWithoutThoughts.substring(firstTagIndex) : '';

  if (!reasoning) {
    reasoning = firstTagIndex > 0
      ? contentWithoutThoughts.substring(0, firstTagIndex).trim()
      : firstTagIndex === -1
        ? contentWithoutThoughts.trim()
        : '';
  }

  return { contentWithoutThoughts, reasoning, code };
}

function buildBridgeScript(uiSessionId: string, bridgeToken: string): string {
  return `
  (function() {
    var sessionId = ${JSON.stringify(uiSessionId)};
    var token = ${JSON.stringify(bridgeToken)};
	    function post(payload) {
	      window.parent.postMessage({
	        type: 'neural-computer-interaction',
	        uiSessionId: sessionId,
	        bridgeToken: token,
	        payload: payload
	      }, '*');
    }
    try {
      post({ type: 'bridge_ready' });
      document.addEventListener('click', function(e) {
        var target = e.target;
        while (target && target !== document.body) {
          if (target.getAttribute && target.getAttribute('data-interaction-id')) {
            var id = target.getAttribute('data-interaction-id');
            var interactionType = target.getAttribute('data-interaction-type') || '';
            var valueFrom = target.getAttribute('data-value-from');
            var value = target.getAttribute('data-interaction-value') || '';
            if (valueFrom) {
              var inputEl = document.getElementById(valueFrom);
              if (inputEl) value = inputEl.value || inputEl.innerText || '';
            }
            post({
              id: id,
              interactionType: interactionType,
              value: value,
              elementType: target.tagName.toLowerCase(),
              elementText: (target.innerText || '').substring(0, 75)
            });
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          target = target.parentElement;
        }
      }, true);
    } catch (err) {
      post({ type: 'bridge_error', message: String(err) });
    }
  })();
  `;
}

const CSS_KEYFRAMES = `
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
`;

export const GeneratedContent: React.FC<GeneratedContentProps> = ({
  htmlContent,
  onInteract,
  appContext,
  isLoading,
  generationTimelineFrames = [],
  appName,
  appIcon,
  colorTheme: rawColorTheme = 'dark',
  loadingUiMode: rawLoadingUiMode = 'code',
  traceId,
  uiSessionId = 'session_unknown',
}) => {
  const [displayProgress, setDisplayProgress] = useState(0);
  const [timelineScrubIndex, setTimelineScrubIndex] = useState(0);
  const [timelinePinnedToLive, setTimelinePinnedToLive] = useState(true);
  const [bridgeToken, setBridgeToken] = useState(() => `bridge_${Math.random().toString(36).slice(2)}`);
  const ambientRef = useRef(0);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const immersiveIframeRef = useRef<HTMLIFrameElement>(null);
  const lastImmersiveMarkupRef = useRef('');
  const lastExecutedMarkupRef = useRef('');
  const previousHtmlContentRef = useRef(htmlContent);
  const eventSeqRef = useRef(0);
  const prevDisplayProgressRef = useRef(0);

  const effectiveColorTheme = rawColorTheme as ColorTheme;
  const loadingUiMode = rawLoadingUiMode === 'immersive' ? 'immersive' : 'code';
  const theme = getLoadingTheme(effectiveColorTheme);
  const timelineFrameCount = generationTimelineFrames.length;
  const timelineMaxIndex = Math.max(0, timelineFrameCount - 1);
  const safeTimelineIndex = Math.min(Math.max(timelineScrubIndex, 0), timelineMaxIndex);
  const selectedTimelineFrame = timelineFrameCount ? generationTimelineFrames[safeTimelineIndex] : null;
  const replayActive = Boolean(selectedTimelineFrame) && safeTimelineIndex < timelineMaxIndex;
  const activeHtmlContent = replayActive && selectedTimelineFrame ? selectedTimelineFrame.htmlSnapshot : htmlContent;
  const htmlChangedThisRender = htmlContent !== previousHtmlContentRef.current;
  const rawProgress = estimateProgress(htmlContent, isLoading);
  const liveProgressBarFillPercent = !isLoading && timelineFrameCount > 0 ? 100 : displayProgress;
  const timelineDotPercent = timelineFrameCount > 1
    ? (safeTimelineIndex / Math.max(1, timelineMaxIndex)) * 100
    : liveProgressBarFillPercent;
  const timelineDotInsetPx = 5;
  const timelineDotLeft = `clamp(${timelineDotInsetPx}px, ${timelineDotPercent}%, calc(100% - ${timelineDotInsetPx}px))`;
  const showTimelineScrubber = !isLoading && Boolean(htmlContent) && timelineFrameCount > 1;
  const progressBarFillWidth = showTimelineScrubber
    ? safeTimelineIndex <= 0
      ? `${timelineDotInsetPx}px`
      : safeTimelineIndex >= timelineMaxIndex
        ? `calc(100% - ${timelineDotInsetPx}px)`
        : `${timelineDotPercent}%`
    : `${liveProgressBarFillPercent}%`;
  const [isTimelineDragging, setIsTimelineDragging] = useState(false);

  useEffect(() => {
    if (!timelineFrameCount) {
      setTimelineScrubIndex(0);
      setTimelinePinnedToLive(true);
      return;
    }
    if (isLoading || timelinePinnedToLive) {
      setTimelineScrubIndex(timelineMaxIndex);
      return;
    }
    setTimelineScrubIndex((previous) => Math.min(previous, timelineMaxIndex));
  }, [isLoading, timelineFrameCount, timelineMaxIndex, timelinePinnedToLive]);

  // Reset state when appContext changes (new app opened)
  useEffect(() => {
    setDisplayProgress(0);
    setTimelineScrubIndex(0);
    setTimelinePinnedToLive(true);
    ambientRef.current = 0;
    lastImmersiveMarkupRef.current = '';
    lastExecutedMarkupRef.current = '';
    eventSeqRef.current = 0;
    setBridgeToken(`bridge_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`);
  }, [appContext]);

  // Ensure progress snaps to full once loading ends and content exists.
  useEffect(() => {
    if (htmlContent && !isLoading) {
      setDisplayProgress(100);
      return;
    }
    if (!htmlContent) setDisplayProgress(0);
  }, [isLoading, htmlContent]);

  // Ambient progress nudge — 0.5% every 500ms, cap 3% above last marker
  useEffect(() => {
    if (!isLoading) return;
    const interval = setInterval(() => {
      ambientRef.current += 0.5;
      setDisplayProgress((prev) => {
        const target = Math.min(rawProgress + ambientRef.current, rawProgress + 3, 98);
        return Math.max(prev, target);
      });
    }, 500);
    return () => clearInterval(interval);
  }, [isLoading, rawProgress]);

  // Update display progress when raw progress jumps
  useEffect(() => {
    ambientRef.current = 0;
    setDisplayProgress((prev) => Math.max(prev, rawProgress));
  }, [rawProgress]);

  useEffect(() => {
    prevDisplayProgressRef.current = displayProgress;
  }, [displayProgress]);

  useEffect(() => {
    previousHtmlContentRef.current = htmlContent;
  }, [htmlContent]);

  useEffect(() => {
    if (!isTimelineDragging) return;
    const endDrag = () => setIsTimelineDragging(false);
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('touchend', endDrag);
    return () => {
      window.removeEventListener('mouseup', endDrag);
      window.removeEventListener('touchend', endDrag);
    };
  }, [isTimelineDragging]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (scrollAnchorRef.current && isLoading && htmlContent) {
      scrollAnchorRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [htmlContent, isLoading]);

  // postMessage listener for iframe interactions
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'neural-computer-interaction') return;
      if (event.source !== immersiveIframeRef.current?.contentWindow) return;
      if (event.data?.uiSessionId !== uiSessionId) return;
      if (event.data?.bridgeToken !== bridgeToken) return;

      const p = event.data.payload || {};
      if (!p.id || typeof p.id !== 'string') return;

      eventSeqRef.current += 1;
      onInteract({
        id: p.id,
        type: p.interactionType || 'generic_click',
        value: p.value || undefined,
        elementType: p.elementType || 'unknown',
        elementText: p.elementText || p.id,
        appContext: appContext,
        traceId,
        uiSessionId,
        eventSeq: eventSeqRef.current,
        source: 'iframe',
        validationState: 'accepted',
      });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onInteract, appContext, uiSessionId, bridgeToken, traceId]);

  const { contentWithoutThoughts, reasoning, code } = useMemo(
    () => parseStreamedContent(activeHtmlContent),
    [activeHtmlContent],
  );
  const immersiveMarkup = useMemo(() => {
    if (!contentWithoutThoughts.trim()) return '';
    if (!/<[a-zA-Z]/.test(contentWithoutThoughts)) {
      return `
        <div style="
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.6;
          color: #6b7280;
          background: rgba(255,255,255,0.55);
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          white-space: pre-wrap;
        ">${escapeHtml(contentWithoutThoughts.trim())}</div>
      `;
    }
    if (
      shouldUseScriptStrippedPreview({
        isLoading,
        replayActive,
        htmlChangedThisRender,
      })
    ) {
      return stripScriptsForPreview(contentWithoutThoughts);
    }
    return contentWithoutThoughts;
  }, [contentWithoutThoughts, htmlChangedThisRender, isLoading, replayActive]);

  const immersiveFrameDoc = useMemo(() => {
    const iframeTheme = getIframeBaseTheme(effectiveColorTheme);
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>
  :root { color-scheme: ${effectiveColorTheme === 'dark' ? 'dark' : 'light'}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; min-height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow-y: auto;
    background: ${iframeTheme.bg};
    color: ${iframeTheme.text};
  }
  #gemini-immersive-root { width: 100%; min-height: 100%; }
</style>
<script>${buildBridgeScript(uiSessionId, bridgeToken)}<\/script>
</head>
<body><div id="gemini-immersive-root"></div></body></html>`;
  }, [effectiveColorTheme, uiSessionId, bridgeToken]);

  const syncImmersiveFrame = useCallback(() => {
    const iframe = immersiveIframeRef.current;
    if (!iframe) return;
    const root = iframe.contentDocument?.getElementById('gemini-immersive-root');
    if (!root) return;
    if (lastImmersiveMarkupRef.current !== immersiveMarkup) {
      root.innerHTML = immersiveMarkup;
      lastImmersiveMarkupRef.current = immersiveMarkup;
    }
    if (isLoading || replayActive) return;
    if (lastExecutedMarkupRef.current === immersiveMarkup) return;
    const doc = iframe.contentDocument;
    if (!doc) return;
    const scripts = Array.from(root.querySelectorAll('script')) as HTMLScriptElement[];
    for (const oldScript of scripts) {
      const nextScript = doc.createElement('script');
      for (const attribute of Array.from(oldScript.attributes) as Attr[]) {
        nextScript.setAttribute(attribute.name, attribute.value);
      }
      if (oldScript.src) {
        nextScript.src = oldScript.src;
      } else {
        nextScript.textContent = oldScript.textContent || '';
      }
      oldScript.replaceWith(nextScript);
    }
    lastExecutedMarkupRef.current = immersiveMarkup;
  }, [immersiveMarkup, isLoading, replayActive]);

  useEffect(() => {
    if (loadingUiMode === 'code') return;
    if (!activeHtmlContent) return;
    syncImmersiveFrame();
  }, [activeHtmlContent, syncImmersiveFrame, loadingUiMode]);

  const handleTimelineScrub = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!showTimelineScrubber) return;
      const nextIndex = Number(event.target.value);
      if (!Number.isFinite(nextIndex)) return;
      const bounded = Math.max(0, Math.min(timelineMaxIndex, Math.round(nextIndex)));
      setTimelineScrubIndex(bounded);
      setTimelinePinnedToLive(bounded >= timelineMaxIndex);
    },
    [showTimelineScrubber, timelineMaxIndex],
  );

  const latestReasoningPreview = useMemo(
    () => getLatestReasoningPreview(generationTimelineFrames, 320),
    [generationTimelineFrames],
  );

  // No content and not loading
  if (!isLoading && !htmlContent && timelineFrameCount === 0) {
    return null;
  }

  const isGradientBg = effectiveColorTheme === 'colorful';
  const cursorColor = effectiveColorTheme === 'light' || effectiveColorTheme === 'system' ? '#3b82f6' : '#89b4fa';
  const progressTransition =
    showTimelineScrubber
      ? 'none'
      : displayProgress < prevDisplayProgressRef.current
      ? 'none'
      : 'width 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
  // Phase 1 & 2: Loading / Streaming view
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'visible',
        ...(isGradientBg ? { background: theme.bg } : { background: theme.bg }),
        color: theme.text,
        fontFamily:
          "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
      }}
    >
      <style>{CSS_KEYFRAMES}</style>

      {/* Progress bar */}
      <div
        style={{
          height: '3px',
          background: theme.progressBg,
          flexShrink: 0,
          position: 'relative',
          overflow: 'visible',
          zIndex: 6,
        }}
      >
        <div
          style={{
            height: '3px',
            width: progressBarFillWidth,
            background: theme.progressFill,
            transition: progressTransition,
            borderRadius: '0 2px 2px 0',
          }}
        />
        {showTimelineScrubber && (
          <>
            <input
              type="range"
              min={0}
              max={timelineMaxIndex}
              value={safeTimelineIndex}
              onChange={handleTimelineScrub}
              onMouseDown={() => setIsTimelineDragging(true)}
              onTouchStart={() => setIsTimelineDragging(true)}
              onBlur={() => setIsTimelineDragging(false)}
              aria-label="Generation timeline scrubber"
              style={{
                position: 'absolute',
                top: '-10px',
                left: 0,
                right: 0,
                height: '23px',
                opacity: 0,
                cursor: isTimelineDragging ? 'grabbing' : 'grab',
              }}
            />
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: timelineDotLeft,
                transform: 'translate(-50%, -50%)',
                width: '8px',
                height: '8px',
                borderRadius: '999px',
                background: '#3b82f6',
                border: '1px solid rgba(255,255,255,0.85)',
                boxShadow: isTimelineDragging
                  ? '0 0 0 2px rgba(59,130,246,0.34)'
                  : '0 0 0 1px rgba(59,130,246,0.28)',
                transition: 'box-shadow 120ms ease',
                pointerEvents: 'none',
                zIndex: 7,
              }}
            />
          </>
        )}
      </div>

      {/* Content area */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          fontSize: '13px',
          lineHeight: '1.6',
        }}
      >
        {!activeHtmlContent ? (
          /* Phase 1: Initial loading - centered icon + skeleton */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: '16px',
            }}
          >
            <img
              src="/logo-mark.svg"
              alt="Neural Computer"
              style={{
                width: '78px',
                height: '78px',
                objectFit: 'contain',
                opacity: 0.94,
                filter: effectiveColorTheme === 'dark' ? 'drop-shadow(0 6px 20px rgba(15,23,42,0.45))' : 'none',
              }}
            />
            <div
              style={{
                color: theme.textMuted,
                fontSize: '14px',
                fontFamily:
                  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
              }}
            >
              {timelineFrameCount > 0 && !isLoading ? 'Start of generation' : 'Connecting...'}
            </div>
            {latestReasoningPreview ? (
              <div
                style={{
                  width: '68%',
                  maxWidth: '520px',
                  minHeight: '96px',
                  marginTop: '18px',
                  borderRadius: '12px',
                  border: `1px solid ${theme.statusBorder}`,
                  background:
                    effectiveColorTheme === 'light' || effectiveColorTheme === 'system'
                      ? 'rgba(255,255,255,0.62)'
                      : 'rgba(15,23,42,0.34)',
                  color: theme.statusText,
                  fontFamily:
                    "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, monospace",
                  fontSize: '12px',
                  lineHeight: 1.55,
                  padding: '12px 14px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflow: 'hidden',
                }}
              >
                {latestReasoningPreview}
                {isLoading && (
                  <span style={{ animation: 'blink 1s infinite', marginLeft: 2, color: '#3b82f6' }}>&#9610;</span>
                )}
              </div>
            ) : (
              <div
                style={{
                  width: '60%',
                  maxWidth: '300px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  marginTop: '20px',
                }}
              >
                {[80, 100, 60, 90].map((w, i) => (
                  <div
                    key={i}
                    style={{
                      width: `${w}%`,
                      height: '12px',
                      borderRadius: '6px',
                      background: theme.skeletonBase,
                      backgroundSize: '200% 100%',
                      animation: 'shimmer 1.5s infinite',
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          /* Phase 2: Streaming content */
          loadingUiMode === 'code' ? (
            <div style={{ padding: '14px 16px 18px' }}>
              {reasoning && (
                <div style={{ marginBottom: code ? '16px' : 0 }}>
                  <div
                    style={{
                      fontSize: '11px',
                      color: theme.statusText,
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
                    }}
                  >
                    Reasoning
                  </div>
                  <div
                    dangerouslySetInnerHTML={{
                      __html:
                        escapeHtml(reasoning) +
                        (isLoading && !replayActive && !code
                          ? `<span style="animation:blink 1s infinite;color:${cursorColor}">&#9610;</span>`
                          : ''),
                    }}
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  />
                </div>
              )}
              {code && (
                <div>
                  <div
                    style={{
                      fontSize: '11px',
                      color: theme.statusText,
                      marginBottom: '8px',
                      textTransform: 'uppercase',
                      letterSpacing: '1px',
                    }}
                  >
                    Generated Code
                  </div>
                  <div
                    dangerouslySetInnerHTML={{
                      __html:
                        highlightSyntaxForTheme(escapeHtml(code), effectiveColorTheme) +
                        (isLoading && !replayActive
                          ? `<span style="animation:blink 1s infinite;color:${cursorColor}">&#9610;</span>`
                          : ''),
                    }}
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  />
                </div>
              )}
              <div ref={scrollAnchorRef} />
            </div>
          ) : (
            <>
              <div style={{ height: '100%', padding: '10px' }}>
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: '10px',
                    overflow: 'hidden',
                    border: `1px solid ${theme.statusBorder}`,
                    background: effectiveColorTheme === 'light' || effectiveColorTheme === 'system'
                      ? 'rgba(255, 255, 255, 0.75)'
                      : 'rgba(15, 23, 42, 0.28)',
                  }}
                >
                  <iframe
                    ref={immersiveIframeRef}
                    srcDoc={immersiveFrameDoc}
                    onLoad={syncImmersiveFrame}
                    style={{
                      width: '100%',
                      height: '100%',
                      border: 'none',
                      pointerEvents: replayActive ? 'none' : 'auto',
                    }}
                    sandbox="allow-scripts allow-forms allow-same-origin"
                    title={appName || 'App Content'}
                    referrerPolicy="no-referrer"
                  />
                </div>
              </div>
              {/* Scroll anchor */}
              <div ref={scrollAnchorRef} />
            </>
          )
        )}
      </div>
    </div>
  );
};
