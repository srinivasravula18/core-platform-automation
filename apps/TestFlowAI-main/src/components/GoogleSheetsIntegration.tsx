import { useState, useEffect } from 'react';
import { initAuth, googleSignIn, getAccessToken, logout } from '../lib/googleAuth';
import { User } from 'firebase/auth';

const SCOPES = 'https://www.googleapis.com/auth/sheets';

export function GoogleSheetsIntegration() {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ type: 'success' | 'error' | 'idle', message: string }>({ type: 'idle', message: '' });

  useEffect(() => {
    const unsubscribe = initAuth(
      (u, token) => {
        setUser(u);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
      }
    } catch (err: any) {
      console.error('Login failed:', err);
      if (err?.message !== "Failed to get access token from Firebase Auth") {
        setSyncStatus({ type: 'error', message: 'Sign in failed. Make sure popup is allowed.' });
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setNeedsAuth(true);
    setUser(null);
    setSyncStatus({ type: 'idle', message: '' });
  };

  const handleSyncToSheets = async () => {
    const confirmation = window.confirm('Are you sure you want to push all latest Test Plans, Suites, and Cases to a new Google Sheet? This will help you maintain them on Sheets.');
    if (!confirmation) return;

    setIsSyncing(true);
    setSyncStatus({ type: 'idle', message: '' });
    try {
      const accessToken = await getAccessToken();
      if (!accessToken || accessToken === 'mock_token') {
         // Create mock behavior if auth failed due to fake API Key
         if (accessToken === 'mock_token') {
             setTimeout(() => {
                 setSyncStatus({ type: 'success', message: `Mock mode active: Successfully "synced" to a fake sheet because Firebase API keys are dummy.` });
                 setIsSyncing(false);
             }, 1000);
             return;
         } else {
             throw new Error("No access token available. Please sign in again.");
         }
      }

      // Fetch latest data from backend
      const [plansRes, suitesRes, casesRes] = await Promise.all([
        fetch('/api/plans'),
        fetch('/api/suites'),
        fetch('/api/cases')
      ]);
      
      const plans = await plansRes.json();
      const suites = await suitesRes.json();
      const cases = await casesRes.json();

      // Create a Spreadsheet
      const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            title: `TestFlowAI QA Data - ${new Date().toLocaleDateString()}`
          },
          sheets: [
            { properties: { title: 'Test Plans' } },
            { properties: { title: 'Test Suites' } },
            { properties: { title: 'Test Cases' } }
          ]
        })
      });
      
      if (!createRes.ok) {
        throw new Error('Failed to create Google Sheet');
      }
      
      const spreadsheet = await createRes.json();
      const spreadsheetId = spreadsheet.spreadsheetId;

      // Prepare Update Data
      const updateData = [
         {
             range: 'Test Plans!A1:D1',
             values: [['ID', 'Name', 'Scope', 'Status']]
         },
         {
             range: 'Test Plans!A2:D' + (plans.length + 1),
             values: plans.length > 0 ? plans.map((p: any) => [p.id, p.name, p.scope, p.status || 'Active']) : [['No plans yet']]
         },
         {
             range: 'Test Suites!A1:D1',
             values: [['ID', 'Name', 'Descriptions', 'Status']]
         },
         {
             range: 'Test Suites!A2:D' + (suites.length + 1),
             values: suites.length > 0 ? suites.map((s: any) => [s.id, s.name, s.description, s.status || 'Active']) : [['No suites yet']]
         },
         {
             range: 'Test Cases!A1:E1',
             values: [['ID', 'Title', 'Description', 'Priority', 'Type']]
         },
         {
             range: 'Test Cases!A2:E' + (cases.length + 1),
             values: cases.length > 0 ? cases.map((c: any) => [c.id, c.title, c.description, c.priority, c.type]) : [['No cases yet']]
         }
      ];

      // Update Spreadsheet Values
      const updateRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: updateData
        })
      });
      
      if (!updateRes.ok) {
        throw new Error('Failed to write data to Google Sheet');
      }

      setSyncStatus({ type: 'success', message: `Successfully synced! Open Spreadsheet at google.com/sheets` });
      window.open(`https://docs.google.com/spreadsheets/d/${spreadsheetId}`, '_blank');
      
    } catch (error: any) {
      console.error(error);
      setSyncStatus({ type: 'error', message: error.message || 'Failed to sync to Google Sheets.' });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="p-6 border-b border-[var(--border)]">
      <h2 className="text-lg font-medium">Google Sheets Integration</h2>
      <p className="text-sm text-[var(--text-muted)] mt-1 mb-4">Sync and maintain your Test Plans, Suites, and Cases directly to Google Sheets.</p>
      
      {needsAuth || !user ? (
        <button onClick={handleLogin} disabled={isLoggingIn} className="gsi-material-button">
            <div className="gsi-material-button-state"></div>
            <div className="gsi-material-button-content-wrapper flex items-center justify-center bg-white text-slate-800 border border-slate-300 rounded shadow-sm px-4 py-2 hover:bg-slate-50 transition-colors">
              <div className="mr-2">
                <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="w-5 h-5 block">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"></path>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"></path>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"></path>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"></path>
                  <path fill="none" d="M0 0h48v48H0z"></path>
                </svg>
              </div>
              <span className="text-sm font-medium">{isLoggingIn ? 'Signing in...' : 'Sign in with Google'}</span>
            </div>
        </button>
      ) : (
        <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
           <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-3">
                 <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold">
                    {user.email?.[0]?.toUpperCase() || 'U'}
                 </div>
                 <div>
                    <div className="font-medium text-sm">{user.displayName || 'Authorized User'}</div>
                    <div className="text-xs text-[var(--text-muted)]">{user.email}</div>
                 </div>
              </div>
              <button onClick={handleLogout} className="text-xs text-[var(--text-muted)] hover:text-red-500 transition-colors">
                Sign out
              </button>
           </div>
           
           <button 
             onClick={handleSyncToSheets} 
             disabled={isSyncing}
             className="w-full bg-[#0f9d58] hover:bg-[#0b8043] text-white px-4 py-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
           >
             {isSyncing ? (
               <span className="animate-pulse">Syncing to Sheets...</span>
             ) : (
               <>
                 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="8" y1="13" x2="16" y2="13"></line>
                    <line x1="8" y1="17" x2="16" y2="17"></line>
                 </svg>
                 Export QA Data to New Google Sheet
               </>
             )}
           </button>

           {syncStatus.type !== 'idle' && (
             <div className={`mt-3 p-3 rounded-md text-sm ${syncStatus.type === 'error' ? 'bg-red-500/10 text-red-500 border border-red-500/20' : 'bg-[#0f9d58]/10 text-[#0f9d58] border border-[#0f9d58]/20'}`}>
                {syncStatus.message}
             </div>
           )}
        </div>
      )}
    </div>
  );
}
