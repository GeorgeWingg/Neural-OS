/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */
import React, { useEffect, useRef, useState } from 'react';
import {
  ColorTheme,
  ContextMemoryDebugSnapshot,
  DebugTurnRecord,
  GenerationTimelineFrame,
  StyleConfig,
} from '../types';

interface WindowProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  isAppOpen: boolean;
  appId?: string | null;
  styleConfig: StyleConfig;
  onStyleConfigChange: (updates: Partial<StyleConfig>) => void;
  onOpenSettings: () => void;
  debugRecords: DebugTurnRecord[];
  generationTimelineFrames: GenerationTimelineFrame[];
  contextMemoryDebug: ContextMemoryDebugSnapshot | null;
  contextMemoryDebugError: string | null;
  onClearDebugRecords: () => void;
  onExitToDesktop: () => void;
  onGlobalPrompt?: (prompt: string) => void;
  feedbackAvailable: boolean;
  feedbackFailureContext: boolean;
  feedbackScore: number | null;
  feedbackComment: string;
  feedbackStatusMessage: string | null;
  onFeedbackScoreSelect: (score: number) => void;
  onFeedbackCommentChange: (comment: string) => void;
  onFeedbackSubmit: () => void;
}

type MenuName = 'feedback' | 'settings' | 'debug' | null;
type DebugLayer = {
  id: string;
  title: string;
  preview: string;
  fullText: string;
  tokens: number;
  color: string;
  label: string;
};

type TimelineEventStyle = {
  pillBg: string;
  pillText: string;
  titleText: string;
};

const FEEDBACK_SCORE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const dropdownStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  backgroundColor: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.12)',
  minWidth: '200px',
  zIndex: 100,
  padding: '4px 0',
  marginTop: '2px',
};

const separatorStyle: React.CSSProperties = {
  height: '1px',
  backgroundColor: '#e5e7eb',
  margin: '4px 0',
};

const headerStyle: React.CSSProperties = {
  padding: '8px 16px 4px',
  fontSize: '11px',
  color: '#6b7280',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const SKILL_CONTEXT_MARKER = '\n\nSkill Context (retrieved runtime skills, highest priority first):';
const COMPACTED_MEMORY_HINT_PATTERN = /Server Context Memory Mode:\s*compacted[^\n]*/gi;
const TIMELINE_EVENT_STYLES: Record<string, TimelineEventStyle> = {
  start: { pillBg: '#0f172a', pillText: '#e2e8f0', titleText: '#e2e8f0' },
  stream: { pillBg: '#1e3a8a', pillText: '#dbeafe', titleText: '#bfdbfe' },
  render_output: { pillBg: '#065f46', pillText: '#d1fae5', titleText: '#a7f3d0' },
  thought: { pillBg: '#6d28d9', pillText: '#ede9fe', titleText: '#ddd6fe' },
  tool_call_start: { pillBg: '#7c2d12', pillText: '#ffedd5', titleText: '#fed7aa' },
  tool_call_result: { pillBg: '#0f766e', pillText: '#ccfbf1', titleText: '#99f6e4' },
  retry: { pillBg: '#78350f', pillText: '#fef3c7', titleText: '#fde68a' },
  done: { pillBg: '#14532d', pillText: '#dcfce7', titleText: '#bbf7d0' },
  error: { pillBg: '#7f1d1d', pillText: '#fee2e2', titleText: '#fecaca' },
};

function formatTs(value?: number): string {
  if (!value) return 'n/a';
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return 'n/a';
  }
}

function formatTsPrecise(value?: number): string {
  if (!value) return 'n/a';
  try {
    const date = new Date(value);
    const base = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  } catch {
    return 'n/a';
  }
}

function formatTimelineType(type: string): string {
  return type.replace(/_/g, ' ');
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / 4));
}

function clipText(value: string, maxChars: number = 120): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function splitSystemPrompt(systemPrompt: string): { base: string; skillOverlay: string } {
  const index = systemPrompt.indexOf(SKILL_CONTEXT_MARKER);
  if (index < 0) return { base: systemPrompt.trim(), skillOverlay: '' };
  return {
    base: systemPrompt.slice(0, index).trim(),
    skillOverlay: systemPrompt.slice(index + SKILL_CONTEXT_MARKER.length).trim(),
  };
}

function extractLegacyHistorySegment(userMessage: string): string {
  const start = userMessage.indexOf('Previous User Interactions');
  if (start < 0) return '';
  const end = userMessage.indexOf('Runtime Viewport Context', start);
  if (end < 0) return userMessage.slice(start).trim();
  return userMessage.slice(start, end).trim();
}

function removeMemoryHintsFromUserMessage(userMessage: string): string {
  return userMessage
    .replace(COMPACTED_MEMORY_HINT_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDebugLayers(
  record: DebugTurnRecord,
  contextMemoryDebug: ContextMemoryDebugSnapshot | null,
): DebugLayer[] {
  const { base: basePrompt, skillOverlay } = splitSystemPrompt(record.systemPrompt || '');
  const legacyHistory = extractLegacyHistorySegment(record.userMessage || '');
  const userMessageWithoutHistory = legacyHistory
    ? (record.userMessage || '').replace(legacyHistory, '').trim()
    : (record.userMessage || '').trim();
  const userPayload = removeMemoryHintsFromUserMessage(userMessageWithoutHistory);

  const layers: DebugLayer[] = [
    {
      id: 'system',
      title: 'System',
      preview: clipText(basePrompt || '(missing)'),
      fullText: (basePrompt || '(missing)').trim(),
      tokens: estimateTokens(basePrompt),
      color: '#0ea5e9',
      label: 'SYS',
    },
  ];

  if (skillOverlay || record.selectedSkills.length > 0) {
    const skillSummary = skillOverlay
      ? skillOverlay
      : record.selectedSkills
          .map((skill) => `${skill.title} (${skill.status}, ${skill.scope}, ${skill.score.toFixed(2)})`)
          .join(' | ');
    layers.push({
      id: 'skills',
      title: 'Skills',
      preview: clipText(skillSummary || '(none)'),
      fullText: (skillSummary || '(none)').trim(),
      tokens: estimateTokens(skillSummary),
      color: '#8b5cf6',
      label: 'SKL',
    });
  }

  if (record.contextMemoryMode === 'compacted') {
    const memoryPreview = contextMemoryDebug
      ? `lane ${contextMemoryDebug.laneKey} | ${formatTokens(contextMemoryDebug.tokens)}/${formatTokens(contextMemoryDebug.contextWindow)} tk | turns ${contextMemoryDebug.recentTurnCount}`
      : 'compacted mode enabled; lane snapshot unavailable';
    layers.push({
      id: 'memory',
      title: 'Memory',
      preview: clipText(memoryPreview),
      fullText: memoryPreview.trim(),
      tokens: Math.max(1, contextMemoryDebug?.tokens || estimateTokens(memoryPreview)),
      color: '#f59e0b',
      label: 'MEM',
    });
  } else if (legacyHistory) {
    layers.push({
      id: 'history',
      title: 'History',
      preview: clipText(legacyHistory),
      fullText: legacyHistory.trim(),
      tokens: estimateTokens(legacyHistory),
      color: '#f59e0b',
      label: 'HIS',
    });
  }

  layers.push({
    id: 'turn',
    title: 'Turn',
    preview: clipText(userPayload || '(missing)'),
    fullText: (userPayload || '(missing)').trim(),
    tokens: estimateTokens(userPayload),
    color: '#22c55e',
    label: 'TRN',
  });

  return layers.filter((layer) => layer.tokens > 0);
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window;
}

function getTauriTitleInsets(): { left: string; top: string } {
  if (!isTauriRuntime()) {
    return { left: '0px', top: '0px' };
  }
  // Keep text clear of macOS traffic lights and account for fullscreen/notch safe area.
  return {
    left: 'calc(72px + env(safe-area-inset-left, 0px))',
    top: 'env(safe-area-inset-top, 0px)',
  };
}

export const Window: React.FC<WindowProps> = ({
  title,
  children,
  onClose,
  isAppOpen,
  styleConfig,
  onStyleConfigChange,
  onOpenSettings,
  debugRecords,
  generationTimelineFrames,
  contextMemoryDebug,
  contextMemoryDebugError,
  onClearDebugRecords,
  onExitToDesktop,
  onGlobalPrompt,
  feedbackAvailable,
  feedbackFailureContext,
  feedbackScore,
  feedbackComment,
  feedbackStatusMessage,
  onFeedbackScoreSelect,
  onFeedbackCommentChange,
  onFeedbackSubmit,
}) => {
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const [searchValue, setSearchValue] = useState('');
  const [debugRecordOffset, setDebugRecordOffset] = useState(0);
  const [expandedLayerIds, setExpandedLayerIds] = useState<string[]>([]);
  const [contextStackExpanded, setContextStackExpanded] = useState(true);
  const [timelineExpanded, setTimelineExpanded] = useState(true);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const titleInsets = getTauriTitleInsets();
  const hasDebugData = debugRecords.length > 0;
  const selectedDebugRecord = hasDebugData
    ? debugRecords[Math.max(0, Math.min(debugRecordOffset, debugRecords.length - 1))]
    : null;
  const debugLayers = selectedDebugRecord ? buildDebugLayers(selectedDebugRecord, contextMemoryDebug) : [];
  const debugLayerTotalTokens = debugLayers.reduce((sum, layer) => sum + layer.tokens, 0);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!debugRecords.length) {
      setDebugRecordOffset(0);
      return;
    }
    setDebugRecordOffset((prev) => Math.max(0, Math.min(prev, debugRecords.length - 1)));
  }, [debugRecords.length]);

  useEffect(() => {
    setExpandedLayerIds([]);
  }, [selectedDebugRecord?.id]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchValue.trim() && onGlobalPrompt) {
      onGlobalPrompt(searchValue.trim());
      setSearchValue('');
    }
  };

  const toggleMenu = (menu: MenuName) => {
    setOpenMenu((prev) => {
      const next = prev === menu ? null : menu;
      if (next === 'debug') {
        setDebugRecordOffset(0);
      }
      return next;
    });
  };

  const handleSettingsItemClick = (action: () => void) => {
    action();
    setOpenMenu(null);
  };

  const toggleLayerExpanded = (layerId: string) => {
    setExpandedLayerIds((previous) =>
      previous.includes(layerId)
        ? previous.filter((id) => id !== layerId)
        : [...previous, layerId],
    );
  };

  const colorThemes: { value: ColorTheme; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'colorful', label: 'Colorful' },
  ];

  return (
    <div className="w-full h-full bg-white/95 border border-gray-300 flex flex-col relative overflow-hidden font-sans">
      {/* Title Bar */}
      <div
        className="bg-gray-800/95 text-white px-4 font-semibold text-sm flex items-center select-none cursor-default flex-shrink-0 border-b border-gray-700"
        style={{
          minHeight: `calc(40px + ${titleInsets.top})`,
          paddingTop: titleInsets.top,
        }}
      >
        <div
          data-tauri-drag-region
          className="flex items-center gap-2 w-[320px] max-w-[65vw] flex-none overflow-hidden"
          style={{ paddingLeft: titleInsets.left }}
        >
          <span data-tauri-drag-region className="tracking-wide uppercase text-xs truncate">
            {title}
          </span>
        </div>
        <div data-tauri-drag-region className="flex-1" />

        <div className="flex items-center gap-3 pl-2">
          {isAppOpen && (
            <button
              onClick={onExitToDesktop}
              className="bg-white/5 hover:bg-white/15 text-gray-100 hover:text-white border border-white/20 rounded px-2 py-0.5 text-[11px] transition-colors flex items-center gap-1"
              title="Exit to Desktop"
            >
              <span className="font-bold">✕</span>
              <span className="uppercase tracking-tight">Exit</span>
            </button>
          )}
        </div>
      </div>

      {/* Menu Bar */}
      <div
        ref={menuBarRef}
        className="bg-gray-100/95 py-1.5 px-3 border-b border-gray-200 select-none flex items-center flex-shrink-0 text-sm text-gray-700"
        style={{ position: 'relative' }}>
        {/* Feedback Menu */}
        <div style={{ position: 'relative' }}>
          <span
            className="cursor-pointer hover:text-gray-900 px-2 py-1 rounded transition-colors"
            style={openMenu === 'feedback' ? { backgroundColor: '#e5e7eb', color: '#111827' } : {}}
            onClick={() => toggleMenu('feedback')}
            role="button"
            tabIndex={0}>
            Feedback ▾
          </span>
          {openMenu === 'feedback' && (
            <div style={{ ...dropdownStyle, minWidth: '332px', backgroundColor: '#ffffff', borderColor: '#d1d5db' }}>
              <div style={{ ...headerStyle, color: '#4b5563' }}>Rate Current Screen (1-10)</div>
              {!feedbackAvailable ? (
                <div className="px-4 py-2 text-xs text-gray-500">
                  Generate a screen first to enable feedback.
                </div>
              ) : (
                <>
                  {feedbackFailureContext && (
                    <div className="mx-3 my-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                      Last render entered fallback mode.
                    </div>
                  )}
                  <div className="px-3 pt-2 pb-1">
                    <div className="grid grid-cols-5 gap-1.5">
                      {FEEDBACK_SCORE_OPTIONS.map((score) => (
                        <button
                          key={score}
                          onClick={() => onFeedbackScoreSelect(score)}
                          className={`h-8 rounded border text-xs font-semibold transition-colors ${
                            feedbackScore === score
                              ? 'bg-gray-800 border-gray-800 text-white'
                              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
                          }`}
                          aria-label={`Rate ${score} out of 10`}
                        >
                          {score}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
                  <div style={{ ...headerStyle, color: '#4b5563', paddingTop: '6px' }}>Comment</div>
                  <div className="px-3 pb-3 pt-1">
                    <textarea
                      value={feedbackComment}
                      onChange={(event) => onFeedbackCommentChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          onFeedbackSubmit();
                        }
                      }}
                      placeholder="Add details, then press Enter to submit."
                      className="w-full min-h-[84px] resize-y rounded border border-gray-300 px-2 py-1.5 text-xs text-gray-700 focus:border-gray-500 focus:outline-none"
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="text-[10px] text-gray-500">Enter submits. Shift+Enter adds a new line.</div>
                      <button
                        onClick={onFeedbackSubmit}
                        className="h-7 rounded border border-gray-700 bg-gray-800 px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-gray-700"
                      >
                        Submit
                      </button>
                    </div>
                    {feedbackStatusMessage && (
                      <div
                        className={`mt-1 text-[11px] ${
                          feedbackStatusMessage.toLowerCase().includes('pick a score')
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }`}
                      >
                        {feedbackStatusMessage}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Settings Menu */}
        <div style={{ position: 'relative', marginLeft: '4px' }}>
          <span
            className="cursor-pointer hover:text-gray-900 px-2 py-1 rounded transition-colors"
            style={openMenu === 'settings' ? { backgroundColor: '#e5e7eb', color: '#111827' } : {}}
            onClick={() => toggleMenu('settings')}
            role="button"
            tabIndex={0}>
            Settings ▾
          </span>
          {openMenu === 'settings' && (
            <div style={{ ...dropdownStyle, backgroundColor: '#ffffff', borderColor: '#d1d5db' }}>
              <div style={{ ...headerStyle, color: '#4b5563' }}>Color Theme</div>
              {colorThemes.map((t) => (
                <div
                  key={t.value}
                  className="px-4 py-1.5 cursor-pointer hover:bg-gray-100 text-xs text-gray-700 transition-colors"
                  onClick={() => handleSettingsItemClick(() => onStyleConfigChange({ colorTheme: t.value }))}
                >
                  {styleConfig.colorTheme === t.value ? '● ' : '○ '} {t.label}
                </div>
              ))}

              <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
              <div
                className="px-4 py-1.5 cursor-pointer hover:bg-gray-100 text-xs text-gray-700 transition-colors font-semibold"
                onClick={() => handleSettingsItemClick(onOpenSettings)}
              >
                Advanced Settings...
              </div>
            </div>
          )}
        </div>

        {/* Debug Menu */}
        <div style={{ position: 'relative', marginLeft: '4px' }}>
          <span
            className="cursor-pointer hover:text-gray-900 px-2 py-1 rounded transition-colors"
            style={openMenu === 'debug' ? { backgroundColor: '#e5e7eb', color: '#111827' } : {}}
            onClick={() => toggleMenu('debug')}
            role="button"
            tabIndex={0}>
            Debug ▾
          </span>
          {openMenu === 'debug' && (
            <div style={{ ...dropdownStyle, minWidth: '540px', maxWidth: 'min(92vw, 680px)', backgroundColor: '#0b1220', borderColor: '#1f2937', color: '#e2e8f0' }}>
              <div style={{ ...headerStyle, color: '#93c5fd' }}>Instrumentation</div>
              {!hasDebugData ? (
                <div className="px-4 py-4 text-xs text-slate-400">
                  No captured turns yet. Generate a screen to populate the context stack.
                </div>
              ) : (
                <div className="px-3 pb-3 space-y-2 text-xs">
                  <div className="rounded border border-slate-700 bg-slate-900/70 p-2">
                    <button
                      className="w-full flex items-center justify-between gap-2 text-left"
                      onClick={() => setContextStackExpanded((previous) => !previous)}
                    >
                      <div className="font-semibold text-slate-100">Model Context Stack</div>
                      <div className="text-[11px] text-slate-300 whitespace-nowrap">
                        {formatTokens(debugLayerTotalTokens)} tk total {contextStackExpanded ? '▴' : '▾'}
                      </div>
                    </button>
                    {contextStackExpanded && (
                      <>
                        <div className="mt-2 h-8 rounded border border-slate-700 overflow-hidden flex">
                          {debugLayers.map((layer) => {
                            const pct = debugLayerTotalTokens > 0 ? (layer.tokens / debugLayerTotalTokens) * 100 : 0;
                            return (
                              <div
                                key={`stack_${layer.id}`}
                                className="h-full flex items-center justify-center text-[10px] font-semibold text-slate-900 border-r border-white/20 last:border-r-0"
                                style={{
                                  backgroundColor: layer.color,
                                  width: `${Math.max(12, pct)}%`,
                                }}
                                title={`${layer.title}: ${formatTokens(layer.tokens)} tk`}
                              >
                                {layer.label}
                              </div>
                            );
                          })}
                        </div>
                        <div className="mt-2 grid grid-cols-1 gap-1.5">
                          {debugLayers.map((layer) => {
                            const pct = debugLayerTotalTokens > 0 ? (layer.tokens / debugLayerTotalTokens) * 100 : 0;
                            const expanded = expandedLayerIds.includes(layer.id);
                            return (
                              <div key={layer.id} className="rounded border border-slate-700 bg-slate-950/70 px-2 py-1.5">
                                <button
                                  className="w-full flex items-center justify-between gap-2 text-left"
                                  onClick={() => toggleLayerExpanded(layer.id)}
                                >
                                  <span className="text-[11px] font-semibold text-slate-100">{layer.title}</span>
                                  <span className="text-[10px] text-slate-300 whitespace-nowrap">
                                    {formatTokens(layer.tokens)} tk ({pct.toFixed(1)}%) {expanded ? '▴' : '▾'}
                                  </span>
                                </button>
                                {expanded ? (
                                  <pre className="text-[10px] leading-4 text-slate-300 mt-1 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                                    {layer.fullText}
                                  </pre>
                                ) : (
                                  <div className="text-[10px] text-slate-400 mt-0.5">{layer.preview}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="rounded border border-slate-700 bg-slate-900/70 p-2">
                    <button
                      className="w-full flex items-center justify-between gap-2 text-left"
                      onClick={() => setTimelineExpanded((previous) => !previous)}
                    >
                      <div className="font-semibold text-slate-100">Generation Chronology</div>
                      <div className="text-[11px] text-slate-300 whitespace-nowrap">
                        {generationTimelineFrames.length} events {timelineExpanded ? '▴' : '▾'}
                      </div>
                    </button>
                    {timelineExpanded && (
                      <>
                        {generationTimelineFrames.length === 0 ? (
                          <div className="mt-2 text-[11px] text-slate-400">
                            No timeline events captured yet for this generation.
                          </div>
                        ) : (
                          <div className="mt-2">
                            <div className="text-[10px] text-slate-400 mb-1">
                              earliest → latest
                            </div>
                            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
                              {generationTimelineFrames.map((frame, index) => {
                                const style = TIMELINE_EVENT_STYLES[frame.type] || TIMELINE_EVENT_STYLES.stream;
                                return (
                                  <div key={frame.id} className="rounded border border-slate-700 bg-slate-950/60 px-2 py-1.5">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                          <span
                                            className="inline-flex h-4 min-w-[18px] items-center justify-center rounded px-1 text-[9px] font-semibold"
                                            style={{ backgroundColor: style.pillBg, color: style.pillText }}
                                          >
                                            {index + 1}
                                          </span>
                                          <span className="text-[11px] font-semibold truncate" style={{ color: style.titleText }}>
                                            {frame.label}
                                          </span>
                                        </div>
                                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-slate-400">
                                          <span className="uppercase tracking-wide">{formatTimelineType(frame.type)}</span>
                                          {frame.toolName && <span>• {frame.toolName}</span>}
                                          {frame.toolCallId && <span>• {frame.toolCallId}</span>}
                                        </div>
                                      </div>
                                      <span className="text-[10px] text-slate-400 whitespace-nowrap">
                                        {formatTsPrecise(frame.createdAt)}
                                      </span>
                                    </div>
                                    {frame.detail && (
                                      <div className="mt-1 text-[10px] text-slate-300 break-words">
                                        {frame.detail}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="rounded border border-slate-700 bg-slate-900/70 p-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-200 font-semibold">Selected Turn</span>
                      <span className="text-slate-400">
                        {debugRecordOffset + 1} / {debugRecords.length}
                      </span>
                    </div>
                    {selectedDebugRecord && (
                      <div className="mt-1 text-[10px] text-slate-300 space-y-0.5">
                        <div>{selectedDebugRecord.appContext} • {selectedDebugRecord.llmConfig.providerId}/{selectedDebugRecord.llmConfig.modelId}</div>
                        <div>{selectedDebugRecord.interaction.type} on {selectedDebugRecord.interaction.elementText || selectedDebugRecord.interaction.id}</div>
                        <div>{formatTs(selectedDebugRecord.createdAt)} • q={Math.round(selectedDebugRecord.qualityScore * 100)}% • {selectedDebugRecord.qualityGatePass ? 'pass' : 'fail'}</div>
                        <div>
                          ctx mode: {selectedDebugRecord.contextMemoryMode}
                          {contextMemoryDebug
                            ? ` • lane ${contextMemoryDebug.fillPercent.toFixed(1)}% (${formatTokens(contextMemoryDebug.tokens)}/${formatTokens(contextMemoryDebug.contextWindow)} tk)`
                            : contextMemoryDebugError
                            ? ` • lane err ${contextMemoryDebugError}`
                            : ''}
                        </div>
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        className="px-2 py-1 rounded border border-slate-600 text-[10px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                        onClick={() => setDebugRecordOffset((prev) => Math.min(debugRecords.length - 1, prev + 1))}
                        disabled={debugRecordOffset >= debugRecords.length - 1}
                      >
                        Older
                      </button>
                      <button
                        className="px-2 py-1 rounded border border-slate-600 text-[10px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                        onClick={() => setDebugRecordOffset((prev) => Math.max(0, prev - 1))}
                        disabled={debugRecordOffset <= 0}
                      >
                        Newer
                      </button>
                      <div className="flex-1" />
                      <button
                        className="px-2 py-1 rounded border border-slate-600 text-[10px] text-slate-200 hover:bg-slate-800"
                        onClick={() => handleSettingsItemClick(onClearDebugRecords)}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Search / Global Prompt */}
        <form onSubmit={handleSearchSubmit} className="ml-4 flex-grow max-w-md relative">
          <input
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Command the system or search..."
            className="w-full bg-white border border-gray-300 rounded-full px-4 py-1 text-xs text-gray-800 focus:outline-none focus:border-gray-500 transition-all placeholder:text-gray-500"
          />
          <button type="submit" className="hidden" />
        </form>
      </div>

      {/* Content */}
      <div className="flex-grow min-h-0 overflow-visible bg-white">{children}</div>
    </div>
  );
};
