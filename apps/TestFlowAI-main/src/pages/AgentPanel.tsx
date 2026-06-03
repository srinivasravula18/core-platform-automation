import { useCallback, useEffect, useState } from 'react';
import { Bot, Save, Download, Loader2, Plus, CheckCircle2, Mic, Send } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useSpeechToText } from '@/src/lib/useSpeechToText';

const casualGreetingPattern = /^(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?)\b[\s!.?]*$/i;
const identityQuestionPattern = /\b(who\s+are\s+you|what\s+can\s+you\s+do|help|your\s+purpose)\b/i;
const qaIntentPattern = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|checkout|workflow|flow|requirements?)\b/i;
const abusivePattern = /\b(fuck|shit|asshole|bastard|bitch|stupid|idiot|moron|dumb)\b/i;

function getGuardrailResponse(message: string) {
  const normalized = message.trim();

  if (abusivePattern.test(normalized)) {
    return 'Please keep the conversation professional. I can help with QA tasks such as test planning, test case generation, and Playwright automation when the request is stated respectfully.';
  }

  if (casualGreetingPattern.test(normalized)) {
    return 'Hello. I am the QA Assistant. Please provide the application URL or describe the feature you want tested, and I will generate the QA workflow.';
  }

  if (identityQuestionPattern.test(normalized)) {
    return 'I am a QA-focused assistant. I can help generate test plans, test cases, suites, and Playwright scripts for application testing workflows.';
  }

  if (!qaIntentPattern.test(normalized) && !/https?:\/\/[^\s]+/i.test(normalized)) {
    return 'This assistant is scoped to QA and test automation. Please ask about an application, feature, test case, test plan, defect, or automation script.';
  }

  return null;
}

export default function AgentPanel() {
  const [input, setInput] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [runData, setRunData] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<'cases' | 'code'>('cases');
  
  const [messages, setMessages] = useState<{role: 'user' | 'agent' | 'system', content: string}[]>([
    { role: 'agent', content: 'Hi! I am the AI Test Agent. I can help you generate test cases and Playwright scripts. Tell me what application you want to test and any specific requirements.' }
  ]);

  const appendSpeechTranscript = useCallback((transcript: string) => {
    setInput((prev) => prev + (prev.trim() ? ' ' : '') + transcript);
  }, []);

  const {
    error: speechError,
    interimTranscript,
    isListening,
    isSupported: isSpeechSupported,
    stopListening,
    toggleListening,
  } = useSpeechToText({ onTranscript: appendSpeechTranscript });

  const sendMessage = async () => {
    if (!input.trim() || isGenerating) return;
    stopListening();
    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    const guardrailResponse = getGuardrailResponse(userMessage);
    if (guardrailResponse) {
      setMessages(prev => [...prev, { role: 'agent', content: guardrailResponse }]);
      return;
    }
    
    // Extract URL if provided
    const urlMatch = userMessage.match(/https?:\/\/[^\s]+/);
    const appUrl = urlMatch ? urlMatch[0] : '';
    
    setIsGenerating(true);
    setRunData(null);
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_url: appUrl, provider: 'gemini', prompt: userMessage })
      });
      const data = await res.json();
      if (data.chat_response) {
        setMessages(prev => [...prev, { role: 'agent', content: data.chat_response }]);
        setIsGenerating(false);
      } else if (data.task_id) {
        setTaskId(data.task_id);
        setMessages(prev => [...prev, { role: 'system', content: `Started Job: ${data.task_id.substring(0,8)}... Orchestrating A2A workflow.` }]);
      } else {
        alert(data.error || 'Failed to start agent');
        setIsGenerating(false);
      }
    } catch (e) {
      console.error(e);
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    let interval: any;
    if (taskId && isGenerating) {
      interval = setInterval(() => {
        fetch(`/api/agent-runs/${taskId}`)
          .then(r => r.json())
          .then(data => {
            setRunData(data);
            if (data.status === 'completed' || data.status === 'failed') {
              setIsGenerating(false);
              clearInterval(interval);
              
              if (data.status === 'completed') {
                  setMessages(prev => [...prev, { role: 'agent', content: 'Finished! I have generated the test cases and Playwright scripts. Check the tabs on the right.' }]);
              } else {
                  const failure = data.messages?.findLast?.((message: any) => message.status === 'failed')?.output;
                  setMessages(prev => [...prev, { role: 'agent', content: failure ? `Task failed: ${failure}` : 'Task failed. Check the server console for details.' }]);
              }
            }
          })
          .catch(console.error);
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [taskId, isGenerating]);

  const saveCases = async () => {
    if (!runData?.generated_cases?.length) return;
    await fetch('/api/agent/save-cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cases: runData.generated_cases })
    });
    alert('Cases saved successfully to Test Cases module!');
  };

  const getAgentStatusIcon = (agentName: string) => {
    const msg = runData?.messages?.filter((m: any) => m.agent === agentName).pop();
    if (!msg) return <div className="w-4 h-4 rounded-full border-2 border-[var(--border)]" />;
    if (msg.status === 'running') return <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />;
    if (msg.status === 'completed') return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    return <div className="w-4 h-4 rounded-full bg-red-500" />;
  };

  return (
    <div className="max-w-7xl mx-auto h-full flex flex-col xl:flex-row gap-6">
      {/* Left Column: Chat and Flow */}
      <div className="w-full xl:w-96 flex flex-col gap-6 flex-shrink-0">
        
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col h-[500px] shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 p-4 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
            <Bot className="w-5 h-5 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold">QA Assistant</h2>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] p-3 rounded-lg text-sm ${m.role === 'user' ? 'bg-[var(--accent)] text-white' : m.role === 'system' ? 'bg-[var(--bg-primary)] border border-dashed border-[var(--border)] text-[var(--text-muted)] w-full text-center' : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)]'}`}>
                  {m.content}
                </div>
              </div>
            ))}
          </div>
          
          <div className="p-3 border-t border-[var(--border)] bg-[var(--bg-primary)]">
            <div className="relative flex items-center">
              <input 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Message or speak..."
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-full pl-4 pr-20 py-2.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                disabled={isGenerating}
              />
              <div className="absolute right-1.5 flex items-center gap-1">
                <button 
                  onClick={toggleListening} 
                  disabled={isGenerating || !isSpeechSupported}
                  title={isSpeechSupported ? (isListening ? 'Stop voice input' : 'Start voice input') : 'Voice input is not supported in this browser'}
                  className={`p-1.5 flex items-center justify-center rounded-full transition-colors ${isListening ? 'bg-red-500/20 text-red-500' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-primary)]'}`}
                >
                  <Mic className="w-4 h-4" />
                </button>
                <button 
                  onClick={sendMessage} 
                  disabled={isGenerating || !input.trim()}
                  className="p-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-full transition-colors disabled:opacity-50"
                >
                  <Send className="w-4 h-4 -ml-0.5" />
                </button>
              </div>
            </div>
            {(isListening || interimTranscript || speechError) && (
              <p className={`mt-2 text-xs ${speechError ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                {speechError || (interimTranscript ? `Listening: ${interimTranscript}` : 'Listening...')}
              </p>
            )}
          </div>
        </div>

        {/* A2A Agent Flow Visualization */}
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-5 shadow-sm flex-1">
           <h3 className="text-xs font-semibold tracking-wider text-[var(--text-muted)] uppercase mb-4">A2A Agent Flow</h3>
           <div className="space-y-4 relative before:absolute before:inset-0 before:ml-2 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-[var(--border)] before:to-transparent">
              {['ApplicationInspector', 'TestGenerationAgent', 'PlaywrightAgent'].map((agent, i) => (
                <div key={agent} className="relative flex items-center gap-3 bg-[var(--bg-secondary)] p-3 rounded-lg border border-[var(--border)] z-10 w-full mb-4">
                   {getAgentStatusIcon(agent)}
                   <span className="text-sm font-medium text-[var(--text-primary)]">{agent}</span>
                </div>
              ))}
           </div>
        </div>
      </div>

      {/* Right Column: Output */}
      <div className="flex-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex flex-col min-h-[600px] shadow-sm overflow-hidden">
        <div className="flex items-center border-b border-[var(--border)] px-4">
           <div className="flex gap-6 flex-1">
             <button 
               onClick={() => setActiveTab('cases')}
               className={cn("py-4 text-sm font-medium border-b-2 transition-colors", activeTab === 'cases' ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
             >
               Generated Test Cases
             </button>
             <button 
               onClick={() => setActiveTab('code')}
               className={cn("py-4 text-sm font-medium border-b-2 transition-colors", activeTab === 'code' ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
             >
               Playwright Scripts
             </button>
           </div>
           
           {activeTab === 'cases' && runData?.generated_cases?.length > 0 && (
             <button onClick={saveCases} className="flex items-center gap-2 bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
               <Save className="w-4 h-4" /> Save All
             </button>
           )}
           {activeTab === 'code' && runData?.playwright_scripts?.length > 0 && (
             <button className="flex items-center gap-2 bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
               <Download className="w-4 h-4" /> Download
             </button>
           )}
        </div>

        <div className="flex-1 overflow-auto p-5 bg-[var(--bg-secondary)]">
          {!runData && !isGenerating && (
            <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)]">
              <Bot className="w-12 h-12 mb-4 opacity-50" />
              <p>Chat with the assistant to generate tests and playwright scripts.</p>
            </div>
          )}

          {isGenerating && (!runData?.generated_cases?.length) && (
            <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)]">
              <Loader2 className="w-10 h-10 mb-4 animate-spin text-[var(--accent)]" />
              <p>Running A2A Agents... This may take a moment.</p>
            </div>
          )}

          {activeTab === 'cases' && runData?.generated_cases?.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {runData.generated_cases.map((c: any, i: number) => (
                <div key={i} className="bg-[var(--bg-primary)] border border-[var(--border)] p-4 rounded-lg shadow-sm flex flex-col">
                  <div className="font-semibold text-sm text-[var(--text-primary)] mb-2">{c.title}</div>
                  <div className="text-xs text-[var(--text-muted)] mb-3 flex-1">{c.description}</div>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="bg-[var(--bg-secondary)] border border-[var(--border)] px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider text-[var(--text-muted)]">
                      {c.priority}
                    </span>
                    <button className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
                      <Plus className="w-3 h-3" /> Edit
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'code' && runData?.playwright_scripts?.map((script: any, i: number) => (
             <div key={i} className="mb-6 rounded-lg overflow-hidden border border-[var(--border)]">
               <div className="bg-[#1e293b] px-4 py-2 flex items-center justify-between text-xs text-slate-300 border-b border-slate-700">
                 <span className="font-mono">{script.filename}</span>
               </div>
               <pre className="custom-scrollbar p-4 bg-[#0f172a] text-slate-300 text-sm overflow-x-auto font-mono">
                 <code>{script.code}</code>
               </pre>
             </div>
          ))}

          {activeTab === 'code' && runData?.status === 'completed' && (!runData?.playwright_scripts?.length) && (
             <div className="text-sm text-[var(--text-muted)] text-center mt-10">No scripts generated.</div>
          )}
        </div>
      </div>
    </div>
  );
}
