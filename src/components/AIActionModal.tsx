import { useCallback, useState } from 'react';
import { Mic, Send, Bot, Loader2, Sparkles, Check, X, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';
import { useSpeechToText } from '@/src/lib/useSpeechToText';
import { showAlert } from '@/src/lib/dialog';
import { FolderSelect } from './FolderSelect';

interface AIActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskType: 'plan' | 'suite' | 'case' | 'run' | 'defect';
  onApprove: (data: any) => void;
  title: string;
}

export function AIActionModal({ isOpen, onClose, taskType, onApprove, title }: AIActionModalProps) {
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedData, setGeneratedData] = useState<any>(null);
  const [folderId, setFolderId] = useState('');
  const requiresFolder = taskType !== 'defect';

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

  const handleGenerate = async () => {
    if (!input.trim() || isGenerating) return;
    stopListening();
    setIsGenerating(true);
    try {
      const res = await fetch('/api/agent/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType, prompt: input })
      });
      const data = await res.json();
      if (res.ok && !data.error) {
        setGeneratedData(data);
      } else {
        void showAlert("Failed to generate: " + (data.error || `HTTP ${res.status}`));
      }
    } catch (e) {
      console.error(e);
      void showAlert("Error generating action.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReset = () => {
    setGeneratedData(null);
    setInput('');
    setFolderId('');
  }

  const handleClose = () => {
    stopListening();
    handleReset();
    onClose();
  }

  const getHelperText = () => {
    switch (taskType) {
      case 'plan': return "Include fields like: Name, Scope, Objectives, Environments, Strategy, Roles.";
      case 'suite': return "Include fields like: Name, Description, Module/Feature, Tags, Priority.";
      case 'case': return "Include title, description, priority, @tags, and ordered test steps with expected results.";
      default: return "";
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div className="space-y-4">
        {requiresFolder && <FolderSelect value={folderId} onChange={setFolderId} includeNone={false} />}
        {!generatedData ? (
          <div>
            <label className="block text-sm font-medium mb-1 text-[var(--text-muted)]">
               Describe what you want to create via voice or text:
            </label>
            <p className="text-xs text-[#8b5cf6] mb-3">{getHelperText()}</p>
            <div className="relative flex items-center">
              <input 
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
                placeholder="Type or speak..."
                className="w-full bg-[var(--bg-secondary)] border border-[var(--border)] rounded-full pl-4 pr-24 py-2.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
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
                  onClick={handleGenerate} 
                  disabled={isGenerating || !input.trim()}
                  className="p-1.5 flex items-center justify-center gap-1 bg-[#8b5cf6] hover:bg-[#7c3aed] text-white rounded-full transition-colors disabled:opacity-50 w-8 h-8"
                >
                  {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {(isListening || interimTranscript || speechError) && (
              <p className={`mt-2 text-xs ${speechError ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                {speechError || (interimTranscript ? `Listening: ${interimTranscript}` : 'Listening...')}
              </p>
            )}
          </div>
        ) : (
          <div className="bg-[var(--bg-secondary)] p-4 rounded-xl border border-[var(--border)]">
             <div className="flex items-center gap-2 mb-3 text-[#8b5cf6]">
               <Bot className="w-5 h-5" />
               <span className="font-semibold text-sm">Review Generated Result</span>
             </div>
             
             <pre className="text-xs text-[var(--text-primary)] bg-[var(--bg-primary)] p-3 rounded-lg border border-[var(--border)] overflow-auto whitespace-pre-wrap max-h-48">
               {JSON.stringify(generatedData, null, 2)}
             </pre>

             <div className="mt-4 flex flex-col gap-3">
               <div>
                 <label className="block text-xs font-medium mb-1 text-[var(--text-muted)]">Reprompt / Adjust (Optional):</label>
                 <div className="flex gap-2">
                   <input 
                     value={input}
                     onChange={(e) => setInput(e.target.value)}
                     className="flex-1 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)] text-[var(--text-primary)]"
                     placeholder="Change the output slightly..."
                     onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
                   />
                   <button onClick={handleGenerate} disabled={isGenerating || !input.trim()} className="px-3 py-1.5 bg-[var(--bg-primary)] border border-[var(--border)] hover:bg-[var(--border)] text-[var(--text-primary)] text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap">
                     {isGenerating ? <Loader2 className="w-3 h-3 animate-spin"/> : <RefreshCw className="w-3 h-3" />} Retry
                   </button>
                 </div>
               </div>
               
               <div className="flex gap-2 justify-end mt-2">
                 <button onClick={() => setGeneratedData(null)} className="px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1 border border-transparent hover:border-[var(--border)] rounded">
                   <X className="w-4 h-4" /> Discard
                 </button>
                 <button onClick={() => {
                   if (requiresFolder && !folderId) { void showAlert('Select a folder or create one first.'); return; }
                   onApprove({ ...generatedData, folderId });
                   handleClose();
                 }} className="px-4 py-1.5 bg-[#8b5cf6] text-white text-sm font-medium rounded-md hover:bg-[#7c3aed] flex items-center gap-1 shadow-sm">
                   <Check className="w-4 h-4" /> Approve & Create
                 </button>
               </div>
             </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
