import { useState, useEffect } from 'react';
import { useTheme } from '@/src/store/theme';
import { Moon, Sun, CheckCircle, AlertCircle } from 'lucide-react';
import { GoogleSheetsIntegration } from '../components/GoogleSheetsIntegration';

export default function Settings() {
  const { theme, setTheme } = useTheme();
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');
  const [playwrightUrl, setPlaywrightUrl] = useState('');
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'idle', message: string }>({ type: 'idle', message: '' });

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data) {
          if (data.geminiModel) setGeminiModel(data.geminiModel);
          if (data.playwrightUrl) setPlaywrightUrl(data.playwrightUrl);
        }
      })
      .catch(err => console.error("Error loading settings:", err));
  }, []);

  const handleSavePreferences = async () => {
    setSaveStatus({ type: 'idle', message: '' });
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiModel, playwrightUrl })
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
                <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">Playwright Target Base URL</label>
              <input 
                type="url" 
                value={playwrightUrl}
                onChange={(e) => setPlaywrightUrl(e.target.value)}
                placeholder="https://staging.myapp.com" 
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)] relative" 
              />
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
