import { useCallback, useEffect, useState } from 'react';
import { Bot, Save, Download, Loader2, Plus, CheckCircle2, Mic, Send } from 'lucide-react';
import { cn } from '@/src/lib/utils';
import { useSpeechToText } from '@/src/lib/useSpeechToText';

const casualGreetingPattern = /^(hi+|h+i+|hlo+|hello+|hey+|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|ok(?:ay)?)\b[\s!.?]*$/i;
const identityQuestionPattern = /\b(who\s+are\s+you|what\s+can\s+you\s+do|help|your\s+purpose)\b/i;
const qaIntentPattern = /\b(test|testing|qa|quality|playwright|selenium|cypress|automation|automate|script|test\s*case|test\s*plan|test\s*suite|scenario|regression|smoke|sanity|bug|defect|application|website|web\s*app|url|api|login|checkout|workflow|flow|requirements?)\b/i;
const abusivePattern = /\b(fuck|shit|asshole|bastard|bitch|stupid|idiot|moron|dumb)\b/i;
const domainPattern = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?)/i;

function extractTargetUrl(message: string) {
  const match = message.match(domainPattern);
  if (!match) return '';
  const rawUrl = match[1].replace(/[),.;!?]+$/, '');
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

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

  if (!qaIntentPattern.test(normalized) && !extractTargetUrl(normalized)) {
    return 'This assistant is scoped to QA and test automation. Please ask about an application, feature, test case, test plan, defect, or automation script.';
  }

  return null;
}

export default function AgentPanel() {
  const [input, setInput] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [runData, setRunData] = useState<any>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isReworkingCase, setIsReworkingCase] = useState(false);
  const [activeTab, setActiveTab] = useState<'cases' | 'code' | 'evidence'>('cases');
  const [testCaseCount, setTestCaseCount] = useState(3);
  const [flowMode, setFlowMode] = useState<'review_cases' | 'complete'>('review_cases');
  const [editingCaseIndex, setEditingCaseIndex] = useState<number | null>(null);
  const [caseFeedback, setCaseFeedback] = useState('');
  
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
    
    const appUrl = extractTargetUrl(userMessage);
    
    setIsGenerating(true);
    setRunData(null);
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_url: appUrl, provider: 'gemini', prompt: userMessage, testCaseCount, flowMode })
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
            if (data.status === 'completed' || data.status === 'failed' || data.status === 'review_required') {
              setIsGenerating(false);
              clearInterval(interval);
              
              if (data.status === 'completed') {
                  setMessages(prev => [...prev, { role: 'agent', content: 'Finished! I have generated the test cases and Playwright scripts. Check the tabs on the right.' }]);
              } else if (data.status === 'review_required') {
                  setActiveTab('cases');
                  setMessages(prev => [...prev, { role: 'agent', content: 'Test cases are ready for review. Edit anything needed, then click Continue Agent Flow.' }]);
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

  const continueAgentFlow = async () => {
    if (!taskId || !runData?.generated_cases?.length || isGenerating) return;
    setIsGenerating(true);
    setRunData((prev: any) => prev ? { ...prev, status: 'running' } : prev);
    setMessages(prev => [...prev, { role: 'system', content: 'Continuing agent flow with reviewed test cases.' }]);

    try {
      const res = await fetch('/api/agent/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, cases: runData.generated_cases }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to continue agent flow');
    } catch (err: any) {
      setIsGenerating(false);
      alert(err.message || 'Failed to continue agent flow.');
    }
  };

  const updateGeneratedCase = (caseIndex: number, updates: any) => {
    setRunData((prev: any) => {
      if (!prev?.generated_cases) return prev;
      const generatedCases = [...prev.generated_cases];
      generatedCases[caseIndex] = { ...generatedCases[caseIndex], ...updates };
      return { ...prev, generated_cases: generatedCases };
    });
  };

  const updateGeneratedCaseStep = (caseIndex: number, stepIndex: number, updates: any) => {
    const currentCase = runData?.generated_cases?.[caseIndex];
    if (!currentCase) return;
    const steps = [...(currentCase.steps || [])];
    steps[stepIndex] = { ...steps[stepIndex], ...updates };
    updateGeneratedCase(caseIndex, { steps });
  };

  const addGeneratedCaseStep = (caseIndex: number) => {
    const currentCase = runData?.generated_cases?.[caseIndex];
    if (!currentCase) return;
    updateGeneratedCase(caseIndex, {
      steps: [...(currentCase.steps || []), { action: '', expected: '' }]
    });
  };

  const removeGeneratedCaseStep = (caseIndex: number, stepIndex: number) => {
    const currentCase = runData?.generated_cases?.[caseIndex];
    if (!currentCase) return;
    updateGeneratedCase(caseIndex, {
      steps: (currentCase.steps || []).filter((_: any, index: number) => index !== stepIndex)
    });
  };

  const reworkGeneratedCase = async (caseIndex: number) => {
    const currentCase = runData?.generated_cases?.[caseIndex];
    if (!currentCase || isReworkingCase) return;

    setIsReworkingCase(true);
    try {
      const res = await fetch('/api/agent/rework-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCase: currentCase,
          feedback: caseFeedback,
          targetUrl: runData?.app_url,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to rework test case');
      updateGeneratedCase(caseIndex, data);
      setCaseFeedback('');
    } catch (err: any) {
      alert(err.message || 'Failed to rework test case.');
    } finally {
      setIsReworkingCase(false);
    }
  };

  const getAgentStatusIcon = (agentName: string) => {
    const msg = runData?.messages?.filter((m: any) => m.agent === agentName).pop();
    if (!msg) return <div className="w-4 h-4 rounded-full border-2 border-[var(--border)]" />;
    if (msg.status === 'running') return <Loader2 className="w-4 h-4 text-[var(--accent)] animate-spin" />;
    if (msg.status === 'completed') return <CheckCircle2 className="w-4 h-4 text-emerald-500" />;
    if (msg.status === 'skipped' || msg.status === 'review_required') return <div className="w-4 h-4 rounded-full bg-slate-500" />;
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
            <div className="mb-3 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
              <div>
                <span>Test cases</span>
                <div className="mt-1 flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
                  {[3, 5, 8].map((count) => (
                    <button
                      key={count}
                      type="button"
                      onClick={() => setTestCaseCount(count)}
                      disabled={isGenerating}
                      className={cn(
                        "px-3 py-1.5 text-xs font-medium transition-colors",
                        testCaseCount === count ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      )}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span>Flow</span>
                <div className="mt-1 flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setFlowMode('review_cases')}
                    disabled={isGenerating}
                    className={cn("px-3 py-1.5 text-xs font-medium transition-colors", flowMode === 'review_cases' ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    onClick={() => setFlowMode('complete')}
                    disabled={isGenerating}
                    className={cn("px-3 py-1.5 text-xs font-medium transition-colors", flowMode === 'complete' ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
                  >
                    Complete
                  </button>
                </div>
              </div>
            </div>
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
              {['ApplicationInspector', 'TestGenerationAgent', 'PlaywrightAgent', 'EvidenceAgent'].map((agent, i) => (
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
             <button 
               onClick={() => setActiveTab('evidence')}
               className={cn("py-4 text-sm font-medium border-b-2 transition-colors", activeTab === 'evidence' ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
             >
               Evidence
             </button>
           </div>
           
           {activeTab === 'cases' && runData?.generated_cases?.length > 0 && (
             <div className="flex items-center gap-2">
               {runData.status === 'review_required' && (
                 <button onClick={continueAgentFlow} disabled={isGenerating} className="flex items-center gap-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50">
                   <Send className="w-4 h-4" /> Continue Agent Flow
                 </button>
               )}
               <button onClick={saveCases} className="flex items-center gap-2 bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--text-primary)] px-3 py-1.5 rounded-md text-sm font-medium transition-colors">
                 <Save className="w-4 h-4" /> Save All
               </button>
             </div>
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
            <div className="grid grid-cols-1 gap-4">
              {runData.generated_cases.map((c: any, i: number) => (
                <div key={i} className="bg-[var(--bg-primary)] border border-[var(--border)] p-4 rounded-lg shadow-sm flex flex-col">
                  <div className="font-semibold text-sm text-[var(--text-primary)] mb-2">{c.title}</div>
                  <div className="text-xs text-[var(--text-muted)] mb-3">{c.description}</div>
                  {c.tags?.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {c.tags.map((tag: string, tagIndex: number) => (
                        <span key={tagIndex} className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                          {tag.startsWith('@') ? tag : `@${tag}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {c.steps?.length > 0 && (
                    <div className="mb-4 overflow-hidden rounded-md border border-[var(--border)]">
                      <div className="grid grid-cols-2 bg-[var(--bg-secondary)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        <div className="px-3 py-2 border-r border-[var(--border)]">Test Steps</div>
                        <div className="px-3 py-2">Expected Result</div>
                      </div>
                      {c.steps.map((step: any, stepIndex: number) => (
                        <div key={stepIndex} className="grid grid-cols-2 text-xs border-t border-[var(--border)]">
                          <div className="px-3 py-2 border-r border-[var(--border)] text-[var(--text-primary)]">
                            {stepIndex + 1}. {step.action}
                          </div>
                          <div className="px-3 py-2 text-[var(--text-muted)]">
                            {stepIndex + 1}. {step.expected}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between mt-auto">
                    <span className="bg-[var(--bg-secondary)] border border-[var(--border)] px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider text-[var(--text-muted)]">
                      {c.priority}
                    </span>
                    <button onClick={() => setEditingCaseIndex(editingCaseIndex === i ? null : i)} className="flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
                      <Plus className="w-3 h-3" /> Edit
                    </button>
                  </div>
                  {editingCaseIndex === i && (
                    <div className="mt-4 pt-4 border-t border-[var(--border)] space-y-3">
                      <input
                        value={c.title || ''}
                        onChange={(e) => updateGeneratedCase(i, { title: e.target.value })}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                        placeholder="Test case title"
                      />
                      <textarea
                        value={c.description || ''}
                        onChange={(e) => updateGeneratedCase(i, { description: e.target.value })}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-20"
                        placeholder="Description"
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={c.priority || 'Medium'}
                          onChange={(e) => updateGeneratedCase(i, { priority: e.target.value })}
                          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                        >
                          <option>Low</option>
                          <option>Medium</option>
                          <option>High</option>
                          <option>Critical</option>
                        </select>
                        <input
                          value={Array.isArray(c.tags) ? c.tags.join(', ') : c.tags || ''}
                          onChange={(e) => updateGeneratedCase(i, { tags: e.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })}
                          className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                          placeholder="Tags"
                        />
                      </div>
                      <div className="space-y-2">
                        {(c.steps || []).map((step: any, stepIndex: number) => (
                          <div key={stepIndex} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                            <input
                              value={step.action || ''}
                              onChange={(e) => updateGeneratedCaseStep(i, stepIndex, { action: e.target.value })}
                              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                              placeholder={`Step ${stepIndex + 1}`}
                            />
                            <input
                              value={step.expected || ''}
                              onChange={(e) => updateGeneratedCaseStep(i, stepIndex, { expected: e.target.value })}
                              className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                              placeholder="Expected result"
                            />
                            <button onClick={() => removeGeneratedCaseStep(i, stepIndex)} className="px-2 text-xs text-red-400 hover:text-red-300">
                              Remove
                            </button>
                          </div>
                        ))}
                        <button onClick={() => addGeneratedCaseStep(i)} className="text-xs text-[var(--accent)] hover:underline">
                          Add step
                        </button>
                      </div>
                      <textarea
                        value={caseFeedback}
                        onChange={(e) => setCaseFeedback(e.target.value)}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md px-3 py-2 text-xs outline-none focus:border-[var(--accent)] text-[var(--text-primary)] h-16"
                        placeholder="Feedback for AI rework, e.g. add negative validation and contact form checks..."
                      />
                      <div className="flex justify-end gap-2">
                        <button onClick={() => setEditingCaseIndex(null)} className="px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                          Done
                        </button>
                        <button
                          onClick={() => reworkGeneratedCase(i)}
                          disabled={isReworkingCase}
                          className="px-3 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium rounded-md disabled:opacity-50"
                        >
                          {isReworkingCase ? 'Reworking...' : 'Rework with AI'}
                        </button>
                      </div>
                    </div>
                  )}
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

          {activeTab === 'evidence' && runData?.evidence_screenshots?.length > 0 && (
            <div className="space-y-4">
              {runData.evidence_screenshots.map((shot: any, i: number) => (
                <div key={i} className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-[var(--border)] flex flex-col gap-1">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{shot.title || 'Playwright screenshot evidence'}</div>
                    <div className="text-xs text-[var(--text-muted)] break-all">{shot.url}</div>
                  </div>
                  <img src={shot.screenshotUrl} alt={shot.title || 'Playwright screenshot evidence'} className="w-full bg-black object-contain" />
                  <div className="px-4 py-2 text-xs text-[var(--text-muted)] border-t border-[var(--border)]">
                    HTTP {shot.status || 'unknown'} captured at {shot.capturedAt ? new Date(shot.capturedAt).toLocaleString() : 'unknown time'}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'evidence' && runData?.status === 'completed' && (!runData?.evidence_screenshots?.length) && (
             <div className="text-sm text-[var(--text-muted)] text-center mt-10">No Playwright evidence screenshots captured. Add a URL in chat or Settings &gt; Playwright Target Base URL.</div>
          )}
        </div>
      </div>
    </div>
  );
}
