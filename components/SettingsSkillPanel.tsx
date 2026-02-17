/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/* tslint:disable */
import React, { useEffect, useMemo, useState } from 'react';
import {
  LLMConfig,
  SettingsFieldSchema,
  SettingsSkillSchema,
  StyleConfig,
} from '../types';

export interface ModelCatalogEntry {
  id: string;
  name: string;
}

export interface ProviderCatalogEntry {
  providerId: string;
  models: ModelCatalogEntry[];
}

interface SettingsSkillPanelProps {
  schema: SettingsSkillSchema | null;
  isLoading: boolean;
  styleConfig: StyleConfig;
  llmConfig: LLMConfig;
  providers: ProviderCatalogEntry[];
  onSave: (nextStyle: StyleConfig, nextLlm: LLMConfig, providerApiKey?: string) => Promise<void> | void;
  onRefreshSchema: () => void;
  statusMessage?: string;
  errorMessage?: string | null;
}

function defaultOptionsForField(
  field: SettingsFieldSchema,
  providers: ProviderCatalogEntry[],
  currentProviderId: string,
): { label: string; value: string }[] {
  if (field.key === 'loadingUiMode') {
    const defaultLoadingModeOptions = [
      { label: 'Code (Legacy Stream)', value: 'code' },
      { label: 'Immersive (Live Preview + Skeleton)', value: 'immersive' },
    ];
    if (field.options && field.options.length) {
      const filtered = field.options.filter(
        (option) => option.value === 'code' || option.value === 'immersive',
      );
      return filtered.length ? filtered : defaultLoadingModeOptions;
    }
    return defaultLoadingModeOptions;
  }

  if (field.key === 'contextMemoryMode') {
    return [
      { label: 'Compacted Memory (Recommended)', value: 'compacted' },
      { label: 'Legacy Interaction History', value: 'legacy' },
    ];
  }

  if (field.options && field.options.length) return field.options;

  if (field.key === 'colorTheme') {
    return [
      { label: 'System', value: 'system' },
      { label: 'Light', value: 'light' },
      { label: 'Dark', value: 'dark' },
      { label: 'Colorful', value: 'colorful' },
    ];
  }
  if (field.key === 'toolTier') {
    return [
      { label: 'None (No tools)', value: 'none' },
      { label: 'Standard (Search + safe app tools)', value: 'standard' },
      { label: 'Experimental (future advanced tools)', value: 'experimental' },
    ];
  }
  if (field.key === 'providerId') {
    return providers.map((provider) => ({ label: provider.providerId, value: provider.providerId }));
  }
  if (field.key === 'modelId') {
    const selectedProvider = providers.find((provider) => provider.providerId === currentProviderId);
    return (selectedProvider?.models || []).map((model) => ({ label: model.name || model.id, value: model.id }));
  }
  return [];
}

export const SettingsSkillPanel: React.FC<SettingsSkillPanelProps> = ({
  schema,
  isLoading,
  styleConfig,
  llmConfig,
  providers,
  onSave,
  onRefreshSchema,
  statusMessage,
  errorMessage,
}) => {
  const [localStyle, setLocalStyle] = useState<StyleConfig>(styleConfig);
  const [localLlm, setLocalLlm] = useState<LLMConfig>(llmConfig);
  const [providerApiKey, setProviderApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setLocalStyle(styleConfig);
  }, [styleConfig]);

  useEffect(() => {
    setLocalLlm(llmConfig);
  }, [llmConfig]);

  const selectedProviderModels = useMemo(() => {
    return providers.find((provider) => provider.providerId === localLlm.providerId)?.models || [];
  }, [providers, localLlm.providerId]);

  useEffect(() => {
    if (!selectedProviderModels.length) return;
    if (!selectedProviderModels.find((model) => model.id === localLlm.modelId)) {
      setLocalLlm((prev) => ({ ...prev, modelId: selectedProviderModels[0].id }));
    }
  }, [selectedProviderModels, localLlm.modelId]);

  const updateField = (key: string, rawValue: unknown) => {
    if (key in localStyle) {
      const value = rawValue as any;
      setLocalStyle((prev) => ({ ...prev, [key]: value }));
      return;
    }
    if (key in localLlm) {
      const value = rawValue as any;
      setLocalLlm((prev) => ({ ...prev, [key]: value }));
    }
  };

  const renderField = (field: SettingsFieldSchema) => {
    const value = (field.key in localStyle
      ? (localStyle as any)[field.key]
      : (localLlm as any)[field.key]) ?? '';

    const options = defaultOptionsForField(field, providers, localLlm.providerId);

    if (field.control === 'toggle') {
      return (
        <label className="flex items-center gap-3 text-sm text-gray-200">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => updateField(field.key, event.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    }

    if (field.control === 'select') {
      return (
        <label className="flex flex-col gap-1 text-sm text-gray-200">
          <span>{field.label}</span>
          <select
            value={String(value)}
            onChange={(event) => updateField(field.key, event.target.value)}
            className="bg-black border border-gray-700 rounded px-2 py-1 text-sm"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {field.description && <span className="text-xs text-gray-500">{field.description}</span>}
        </label>
      );
    }

    if (field.control === 'textarea') {
      return (
        <label className="flex flex-col gap-1 text-sm text-gray-200">
          <span>{field.label}</span>
          <textarea
            value={String(value)}
            onChange={(event) => updateField(field.key, event.target.value)}
            className="bg-black border border-gray-700 rounded px-2 py-2 text-sm min-h-[160px]"
            placeholder={field.placeholder}
          />
          {field.description && <span className="text-xs text-gray-500">{field.description}</span>}
        </label>
      );
    }

    const inputType = field.control === 'password' ? 'password' : field.control === 'number' ? 'number' : 'text';

    return (
      <label className="flex flex-col gap-1 text-sm text-gray-200">
        <span>{field.label}</span>
        <input
          type={inputType}
          value={String(value)}
          onChange={(event) => {
            if (field.control === 'number') {
              updateField(field.key, Number(event.target.value));
            } else {
              updateField(field.key, event.target.value);
            }
          }}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={field.placeholder}
          className="bg-black border border-gray-700 rounded px-2 py-1 text-sm"
        />
        {field.description && <span className="text-xs text-gray-500">{field.description}</span>}
      </label>
    );
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(localStyle, localLlm, providerApiKey.trim() || undefined);
      setProviderApiKey('');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[#050505] text-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">{schema?.title || 'System Settings'}</h2>
          <p className="text-xs text-gray-400">{schema?.description || 'Model-generated settings skill output'}</p>
          <p className="text-[10px] text-gray-600 mt-1">Generated by: {schema?.generatedBy || 'loading'}</p>
        </div>
        <button
          onClick={onRefreshSchema}
          disabled={isLoading}
          className="px-3 py-1 text-xs border border-blue-700 rounded hover:bg-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Refreshing...' : 'Refresh Skill Layout'}
        </button>
      </div>

      {isLoading && <div className="text-sm text-blue-300 mb-3">Generating settings schema...</div>}
      {errorMessage && <div className="text-sm text-red-300 mb-3">{errorMessage}</div>}
      {statusMessage && <div className="text-sm text-green-300 mb-3">{statusMessage}</div>}

      <div className="space-y-5">
        {(schema?.sections || []).map((section) => (
          <section key={section.id} className="border border-gray-800 rounded p-4 space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-blue-300">{section.title}</h3>
              {section.description && <p className="text-xs text-gray-500">{section.description}</p>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {section.fields.map((field) => (
                <div key={`${section.id}_${field.key}`} className={field.control === 'textarea' ? 'md:col-span-2' : ''}>
                  {renderField(field)}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <section className="border border-gray-800 rounded p-4 mt-5 space-y-3">
        <h3 className="text-sm font-semibold text-blue-300">Provider Credentials</h3>
        <p className="text-xs text-gray-500">
          API key is stored in server session memory for this browser session and never injected into the client bundle.
        </p>
        <label className="flex flex-col gap-1 text-sm text-gray-200">
          <span>API Key for provider: {localLlm.providerId}</span>
          <input
            type="password"
            value={providerApiKey}
            onChange={(event) => setProviderApiKey(event.target.value)}
            placeholder="Paste provider API key"
            className="bg-black border border-gray-700 rounded px-2 py-1 text-sm"
          />
        </label>
      </section>

      <div className="mt-5 flex gap-2">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-4 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  );
};
