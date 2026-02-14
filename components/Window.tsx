/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/* tslint:disable */
import React, { useEffect, useRef, useState } from 'react';
import { ColorTheme, EpisodeRating, SpeedMode, StyleConfig, UIDetailLevel } from '../types';

interface WindowProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  isAppOpen: boolean;
  appId?: string | null;
  styleConfig: StyleConfig;
  onStyleConfigChange: (updates: Partial<StyleConfig>) => void;
  onOpenSettings: () => void;
  onExitToDesktop: () => void;
  onGlobalPrompt?: (prompt: string) => void;
  feedbackAvailable: boolean;
  feedbackFailureContext: boolean;
  feedbackRating: EpisodeRating | null;
  feedbackReasons: string[];
  onFeedbackRate: (rating: EpisodeRating) => void;
  onToggleFeedbackReason: (reason: string) => void;
}

type MenuName = 'feedback' | 'settings' | null;

const FEEDBACK_REASON_TAGS = ['Layout', 'Readability', 'Navigation', 'Visual Style', 'Too Sparse', 'Too Noisy'];

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

export const Window: React.FC<WindowProps> = ({
  title,
  children,
  onClose,
  isAppOpen,
  styleConfig,
  onStyleConfigChange,
  onOpenSettings,
  onExitToDesktop,
  onGlobalPrompt,
  feedbackAvailable,
  feedbackFailureContext,
  feedbackRating,
  feedbackReasons,
  onFeedbackRate,
  onToggleFeedbackReason,
}) => {
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const [searchValue, setSearchValue] = useState('');
  const menuBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchValue.trim() && onGlobalPrompt) {
      onGlobalPrompt(searchValue.trim());
      setSearchValue('');
    }
  };

  const toggleMenu = (menu: MenuName) => {
    setOpenMenu((prev) => (prev === menu ? null : menu));
  };

  const handleSettingsItemClick = (action: () => void) => {
    action();
    setOpenMenu(null);
  };

  const detailLevels: { value: UIDetailLevel; label: string }[] = [
    { value: 'minimal', label: 'Minimal' },
    { value: 'standard', label: 'Standard' },
    { value: 'rich', label: 'Rich' },
  ];

  const colorThemes: { value: ColorTheme; label: string }[] = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'colorful', label: 'Colorful' },
  ];

  const speedModes: { value: SpeedMode; label: string }[] = [
    { value: 'fast', label: 'Fast' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'quality', label: 'Quality' },
  ];

  const historyOptions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  return (
    <div className="w-full h-full bg-white/95 border border-gray-300 flex flex-col relative overflow-hidden font-sans">
      {/* Title Bar */}
      <div className="bg-gray-800/95 text-white py-2 px-4 font-semibold text-sm flex justify-between items-center select-none cursor-default flex-shrink-0 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="tracking-wide uppercase text-xs">{title}</span>
        </div>

        <div className="flex items-center gap-3">
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
            <div style={{ ...dropdownStyle, minWidth: '292px', backgroundColor: '#ffffff', borderColor: '#d1d5db' }}>
              <div style={{ ...headerStyle, color: '#4b5563' }}>Rate Current Screen</div>
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
                  <div className="px-3 py-2 flex gap-2">
                    {([
                      { label: 'Good', value: 'good' },
                      { label: 'Okay', value: 'okay' },
                      { label: 'Bad', value: 'bad' },
                    ] as const).map((item) => (
                      <button
                        key={item.value}
                        onClick={() => onFeedbackRate(item.value)}
                        className={`px-2 py-1 rounded text-xs border transition-colors ${
                          feedbackRating === item.value
                            ? 'bg-gray-700 border-gray-700 text-white'
                            : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
                  <div style={{ ...headerStyle, color: '#4b5563', paddingTop: '6px' }}>Reasons</div>
                  <div className="px-3 pb-3 pt-1 flex flex-wrap gap-1.5">
                    {FEEDBACK_REASON_TAGS.map((reason) => {
                      const selected = feedbackReasons.includes(reason);
                      return (
                        <button
                          key={reason}
                          onClick={() => onToggleFeedbackReason(reason)}
                          className={`px-2 py-1 rounded text-[10px] border transition-colors ${
                            selected
                              ? 'bg-gray-700 border-gray-700 text-white'
                              : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          {reason}
                        </button>
                      );
                    })}
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
              <div style={{ ...headerStyle, color: '#4b5563' }}>Detail Level</div>
              {detailLevels.map((d) => (
                <div
                  key={d.value}
                  className="px-4 py-1.5 cursor-pointer hover:bg-gray-100 text-xs text-gray-700 transition-colors"
                  onClick={() => handleSettingsItemClick(() => onStyleConfigChange({ detailLevel: d.value }))}
                >
                  {styleConfig.detailLevel === d.value ? '● ' : '○ '} {d.label}
                </div>
              ))}

              <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
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
              <div style={{ ...headerStyle, color: '#4b5563' }}>Speed Mode</div>
              {speedModes.map((s) => (
                <div
                  key={s.value}
                  className="px-4 py-1.5 cursor-pointer hover:bg-gray-100 text-xs text-gray-700 transition-colors"
                  onClick={() => handleSettingsItemClick(() => onStyleConfigChange({ speedMode: s.value }))}
                >
                  {styleConfig.speedMode === s.value ? '● ' : '○ '} {s.label}
                </div>
              ))}

              <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
              <div style={{ ...headerStyle, color: '#4b5563' }}>History ({styleConfig.maxHistoryLength})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', padding: '4px 12px', gap: '4px' }}>
                {historyOptions.map((n) => (
                  <span
                    key={n}
                    onClick={() => handleSettingsItemClick(() => onStyleConfigChange({ maxHistoryLength: n }))}
                    className={`px-1.5 py-0.5 rounded cursor-pointer text-[10px] transition-colors ${
                      styleConfig.maxHistoryLength === n
                        ? 'bg-gray-700 text-white'
                        : 'hover:bg-gray-100 text-gray-600'
                    }`}
                  >
                    {n}
                  </span>
                ))}
              </div>

              <div style={{ ...separatorStyle, backgroundColor: '#e5e7eb' }} />
              <div
                className="px-4 py-1.5 cursor-pointer hover:bg-gray-100 text-xs text-gray-700 transition-colors flex items-center justify-between"
                onClick={() =>
                  handleSettingsItemClick(() =>
                    onStyleConfigChange({ isStatefulnessEnabled: !styleConfig.isStatefulnessEnabled }),
                  )
                }
              >
                <span>Statefulness</span>
                <span>{styleConfig.isStatefulnessEnabled ? 'ON' : 'OFF'}</span>
              </div>

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
      <div className="flex-grow min-h-0 overflow-y-auto bg-white">{children}</div>
    </div>
  );
};
