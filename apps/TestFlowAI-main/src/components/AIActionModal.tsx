import { useState, useRef, useEffect } from 'react';
import { Mic, Send, Bot, Loader2, Sparkles, Check, X, RefreshCw } from 'lucide-react';
import { Modal } from './Modal';

interface AIActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskType: 'plan' | 'suite' | 'case' | 'run' | 'defect';
  onApprove: (data: any) => void;
  title: string;
}

export function AIActionModal({ isOpen, onClose, taskType, onApprove, title }: AIActionModalProps) {
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedData, setGeneratedData] = useState<any>(null);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = false;
        recognitionRef.current.onresult = (event: any) => {
          const transcript = event.results[event.results.length - 1][0].transcript;
          setInput((prev) => prev + (prev ? ' ' : '') + transcript);
        };
        recognitionRef.current.onend = () => setIsListening(false);
      }
    }
  }, []);

  const toggleListen = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error("Microphone access error:", e);
      }
    }
  };

  const handleGenerate = async () => {
    if (!input.trim() || isGenerating) return;
    setIsGenerating(true);
    try {
      const res = await fetch('/api/agent/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType, prompt: input })
      });
      const data = await res.json();
      if (res.ok) {
        setGeneratedData(data);
      } else {
        alert("Failed to generate: " + data.error);
      }
    } catch (e) {
      console.error(e);
      alert("Error generating action.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReset = () => {
    setGeneratedData(null);
    setInput('');
  }

  const handleClose = () => {
    handleReset();
    onClose();
  }

  const getHelperText = () => {
    switch (taskType) {
      case 'plan': return "Include fields like: Name, Scope, Objectives, Environments, Strategy, Roles.";
      case 'suite': return "Include fields like: Name, Description, Module/Feature, Tags, Priority.";
      case 'case': return "Include fields like: Title, Description (Steps), Priority, Type, Tags.";
      default: return "";
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title}>
      <div className="space-y-4">
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
                  onClick={toggleListen} 
                  disabled={isGenerating}
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
                 <button onClick={() => { onApprove(generatedData); handleClose(); }} className="px-4 py-1.5 bg-[#8b5cf6] text-white text-sm font-medium rounded-md hover:bg-[#7c3aed] flex items-center gap-1 shadow-sm">
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
