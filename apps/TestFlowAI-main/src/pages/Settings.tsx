import { useState, useEffect } from 'react';
import { useTheme } from '@/src/store/theme';
import { Moon, Sun, CheckCircle, AlertCircle, Plus, Trash2 } from 'lucide-react';
import { GoogleSheetsIntegration } from '../components/GoogleSheetsIntegration';

type SiteCredential = {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  isPlaywrightTarget?: boolean;
};

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');
  const [siteCredentials, setSiteCredentials] = useState<SiteCredential[]>([]);
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'idle', message: string }>({ type: 'idle', message: '' });

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data) {
          if (data.geminiModel) setGeminiModel(data.geminiModel);
          if (Array.isArray(data.siteCredentials)) {
            setSiteCredentials(data.siteCredentials.map((item: any) => ({
              id: item.id || crypto.randomUUID(),
              name: item.name || '',
              url: item.url || '',
              username: item.username || '',
              password: item.password || '',
              isPlaywrightTarget: Boolean(item.isPlaywrightTarget),
            })));
          }
        }
      })
      .catch(err => console.error("Error loading settings:", err));
  }, []);

  const addSiteCredential = () => {
    setSiteCredentials([
      ...siteCredentials,
      { id: crypto.randomUUID(), name: '', url: '', username: '', password: '', isPlaywrightTarget: siteCredentials.length === 0 }
    ]);
  };

  const updateSiteCredential = (id: string, updates: Partial<SiteCredential>) => {
    setSiteCredentials(siteCredentials.map((item) => {
      if (updates.isPlaywrightTarget) {
        return item.id === id ? { ...item, ...updates } : { ...item, isPlaywrightTarget: false };
      }
      return item.id === id ? { ...item, ...updates } : item;
    }));
  };

  const removeSiteCredential = (id: string) => {
    const remaining = siteCredentials.filter((item) => item.id !== id);
    if (!remaining.some((item) => item.isPlaywrightTarget) && remaining[0]) {
      remaining[0] = { ...remaining[0], isPlaywrightTarget: true };
    }
    setSiteCredentials(remaining);
  };

  const handleSavePreferences = async () => {
    setSaveStatus({ type: 'idle', message: '' });
    try {
      const selectedTargetId = siteCredentials.find((item) => item.isPlaywrightTarget)?.id || siteCredentials[0]?.id || '';
      const cleanedCredentials = siteCredentials
        .map((item) => ({
          id: item.id,
          name: item.name.trim(),
          url: item.url.trim(),
          username: item.username.trim(),
          password: item.password.trim(),
          isPlaywrightTarget: item.id === selectedTargetId,
        }))
        .filter((item) => item.url && item.username && item.password);

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiModel, siteCredentials: cleanedCredentials })
      });
      if (res.ok) {
        setSaveStatus({ type: 'success', message: 'Preferences saved successfully!' });
        setTimeout(() => setSaveStatus({ type: 'idle', message: '' }), 3000);
      } else {
        throw new Error('Failed to save settings on server');
      }
    } catch (err: any) {
      setSaveStatus({ type: 'error', message: err.message || 'Error saving preferences' });
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">Manage your platform preferences and integrations.</p>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden shadow-sm">
        <GoogleSheetsIntegration />
        <div className="p-6 border-b border-[var(--border)]">
          <h2 className="text-lg font-medium">Appearance</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">Customize how TestFlowAI looks on your device.</p>
          
          <div className="flex items-center gap-4 mt-6">
            <button
              onClick={() => setTheme('light')}
              className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${theme === 'light' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--text-muted)]'}`}
            >
              <div className="p-3 bg-white text-slate-800 rounded-full shadow-sm border border-slate-200">
                <Sun className="w-6 h-6 text-amber-500" />
              </div>
              <span className="text-sm font-medium">Light</span>
            </button>
            <button
              onClick={() => setTheme('dark')}
              className={`flex flex-col items-center gap-3 p-4 rounded-xl border-2 transition-all ${theme === 'dark' ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)] hover:border-[var(--text-muted)]'}`}
            >
              <div className="p-3 bg-slate-900 text-slate-100 rounded-full shadow-sm border border-slate-700">
                <Moon className="w-6 h-6 text-blue-400" />
              </div>
              <span className="text-sm font-medium">Dark</span>
            </button>
          </div>
        </div>
        
        <div className="p-6">
          <h2 className="text-lg font-medium">AI & Integrations</h2>
          <p className="text-sm text-[var(--text-muted)] mt-1">Configure your AI providers and external tools.</p>
          
          <div className="mt-4 space-y-4 max-w-lg">
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Gemini Model Preset</label>
              <select 
                value={geminiModel} 
                onChange={(e) => setGeminiModel(e.target.value)}
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
              >
                <option value="gemini-2.5-flash">gemini-2.5-flash</option>
                <option value="gemini-3.5-flash">gemini-3.5-flash</option>
                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              </select>
            </div>
          </div>

          <div className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-medium">Website Credentials</h3>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                  Save login credentials per website. Mention the website name in chat, or select a row for Playwright.
                </p>
              </div>
              <button
                type="button"
                onClick={addSiteCredential}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm font-medium text-[var(--text-primary)] hover:border-[var(--accent)]"
              >
                <Plus className="h-4 w-4" />
                Add Website
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {siteCredentials.length === 0 && (
                <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-5 text-sm text-[var(--text-muted)]">
                  No website credentials saved yet.
                </div>
              )}

              {siteCredentials.map((credential) => (
                <div key={credential.id} className="grid grid-cols-1 gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-3 xl:grid-cols-[1fr_1.25fr_1fr_1fr_132px_auto]">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">Website Name</label>
                    <input
                      type="text"
                      value={credential.name}
                      onChange={(e) => updateSiteCredential(credential.id, { name: e.target.value })}
                      placeholder="Keystone Admin"
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">Website URL</label>
                    <input
                      type="url"
                      value={credential.url}
                      onChange={(e) => updateSiteCredential(credential.id, { url: e.target.value })}
                      placeholder="http://54.205.160.97:5002/"
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">Username / Email</label>
                    <input
                      type="text"
                      value={credential.username}
                      onChange={(e) => updateSiteCredential(credential.id, { username: e.target.value })}
                      placeholder="admin acc"
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">Password</label>
                    <input
                      type="password"
                      value={credential.password}
                      onChange={(e) => updateSiteCredential(credential.id, { password: e.target.value })}
                      placeholder="Password"
                      className="w-full bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                    />
                  </div>
                  <label className="mt-5 flex h-10 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-xs font-medium text-[var(--text-muted)]">
                    <input
                      type="radio"
                      name="playwrightTargetCredential"
                      checked={Boolean(credential.isPlaywrightTarget)}
                      onChange={() => updateSiteCredential(credential.id, { isPlaywrightTarget: true })}
                      className="accent-[var(--accent)]"
                    />
                    Use for Playwright
                  </label>
                  <button
                    type="button"
                    onClick={() => removeSiteCredential(credential.id)}
                    className="mt-5 inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] hover:border-red-400 hover:text-red-400 lg:mt-5"
                    aria-label="Remove website credentials"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {saveStatus.type !== 'idle' && (
            <div className={`mt-4 p-3 rounded-md text-sm flex items-center gap-2 max-w-lg ${saveStatus.type === 'success' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-red-500/10 text-red-500 border border-red-500/20'}`}>
              {saveStatus.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
              <span>{saveStatus.message}</span>
            </div>
          )}

          <button 
            onClick={handleSavePreferences}
            className="mt-6 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
          >
            Save Preferences
          </button>
        </div>
      </div>
    </div>
  );
}
