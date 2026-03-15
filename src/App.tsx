import React, { useState, useEffect, useRef } from 'react';
import { 
  Globe, 
  Target, 
  Play, 
  Loader2, 
  History, 
  CheckCircle2, 
  AlertCircle, 
  ChevronRight,
  Eye,
  Terminal,
  Square
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";

interface NavigationResult {
  status: string;
  history: string[];
  lastScreenshot?: string;
  error?: string;
}

interface Action {
  action: "click" | "type" | "wait" | "finished" | "confirm";
  x?: number;
  y?: number;
  text?: string;
  reason?: string;
}

const SYSTEM_PROMPT = `
You are a 'Visual Hands' agent. You see a screenshot and output the next mechanical action.
COORDINATE SYSTEM: You must use a 0-1000 scale for both X and Y.
(0,0) is top-left, (1000,1000) is bottom-right.

AVAILABLE ACTIONS:
- CLICK: {"action": "click", "x": 500, "y": 500}
- TYPE: {"action": "type", "x": 500, "y": 500, "text": "hello"}
- WAIT: {"action": "wait"} (Use if page is loading or animations are playing)
- FINISHED: {"action": "finished"} (Goal achieved)

SENSITIVE ACTIONS: If you need to click 'Pay', 'Delete', or 'Submit' on a form, 
ask for confirmation by outputting {"action": "confirm", "reason": "description"}.

Return ONLY a valid JSON object.
`;

export default function App() {
  const [url, setUrl] = useState('https://www.wikipedia.org');
  const [goal, setGoal] = useState('Find the article about "Artificial Intelligence" and tell me the first sentence.');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<NavigationResult | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev, `> ${msg}`]);
  };

  const capture_and_decide = async (sessionId: string, history: string[], goal: string, prevScreenshot: string | null): Promise<Action> => {
    addLog('Capturing perception...');
    const screenRes = await fetch('/api/browser/screenshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });

    if (!screenRes.ok) {
      const errData = await screenRes.json().catch(() => ({}));
      throw new Error(errData.error || `Screenshot capture failed (${screenRes.status})`);
    }

    const screenData = await screenRes.json();
    if (screenData.error) throw new Error(screenData.error);
    
    setCurrentScreenshot(screenData.screenshot);

    // Logic to detect minimal changes (loading or stuck state)
    if (prevScreenshot && screenData.screenshot === prevScreenshot) {
      addLog('Detected no visual change. Waiting for content to load...');
      return { action: "wait", reason: "Static state detected" };
    }

    addLog('Analyzing visual state...');
    const genAI = new GoogleGenAI({ apiKey: (process.env as any).GEMINI_API_KEY });
    const prompt = `User Goal: ${goal}\nCurrent URL: ${screenData.url}\nAction History: ${history.join(", ")}\n
    IMPORTANT: If you see a loading spinner, a progress bar, or if the page content is clearly still loading, output {"action": "wait"}.
    What is the next step?`;
    
    const geminiResult = await genAI.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        { role: 'user', parts: [
          { text: SYSTEM_PROMPT },
          { inlineData: { data: screenData.screenshot, mimeType: "image/png" } },
          { text: prompt }
        ]}
      ],
      config: {
        responseMimeType: "application/json",
      }
    });

    try {
      return JSON.parse(geminiResult.text || "{}");
    } catch (e) {
      addLog('Failed to parse agent decision. Retrying...');
      return { action: "wait" };
    }
  };

  const runAgent = async () => {
    // Validation
    setValidationError(null);
    
    if (!goal.trim()) {
      setValidationError("Please enter a mission objective to proceed.");
      return;
    }

    if (!url.trim()) {
      setValidationError("Target URL cannot be empty.");
      return;
    }

    const urlPattern = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/i;
    if (!urlPattern.test(url)) {
      setValidationError("Please enter a valid web address (e.g., https://example.com).");
      return;
    }

    setIsLoading(true);
    setResult(null);
    setLogs([]);
    setCurrentScreenshot(null);
    abortControllerRef.current = new AbortController();

    let sessionId = "";
    const history: string[] = [];
    let lastScreenshot: string | null = null;

    try {
      addLog('Initializing browser session...');
      const initRes = await fetch('/api/browser/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      
      if (!initRes.ok) {
        const errData = await initRes.json().catch(() => ({}));
        throw new Error(errData.error || `Session initialization failed (${initRes.status})`);
      }
      
      const initData = await initRes.json();
      if (initData.error) throw new Error(initData.error);
      sessionId = initData.sessionId;

      for (let step = 0; step < 15; step++) {
        if (abortControllerRef.current?.signal.aborted) break;

        addLog(`Step ${step + 1}: Starting cycle...`);
        const decision = await capture_and_decide(sessionId, history, goal, lastScreenshot);
        
        if (decision.action === "finished") {
          addLog('Goal achieved. Finishing mission.');
          setResult({ status: 'Complete', history, lastScreenshot: currentScreenshot || undefined });
          break;
        }

        if (decision.action === "confirm") {
          addLog(`PAUSED: ${decision.reason}`);
          setResult({ status: 'Requires Approval', history, lastScreenshot: currentScreenshot || undefined });
          break;
        }

        if (decision.action === "wait") {
          addLog('Action: WAIT (3s) - Allowing page to stabilize...');
          await new Promise(resolve => setTimeout(resolve, 3000));
          // We don't record 'wait' in history to keep it clean, or we can if desired
          continue;
        }

        addLog(`Executing: ${decision.action} ${decision.x ? `at ${decision.x},${decision.y}` : ''}`);
        const actionRes = await fetch('/api/browser/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, ...decision }),
        });

        if (!actionRes.ok) {
          const errData = await actionRes.json().catch(() => ({}));
          throw new Error(errData.error || `Action execution failed (${actionRes.status})`);
        }

        const actionData = await actionRes.json();
        if (actionData.error) throw new Error(actionData.error);

        history.push(`${decision.action}${decision.x ? ` (${decision.x},${decision.y})` : ''}${decision.text ? `: "${decision.text}"` : ''}`);
        lastScreenshot = currentScreenshot;
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

    } catch (error: any) {
      addLog(`Error: ${error.message}`);
      setResult({ status: 'Error', history, error: error.message });
    } finally {
      if (sessionId) {
        await fetch('/api/browser/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      }
      setIsLoading(false);
    }
  };

  const stopAgent = () => {
    abortControllerRef.current?.abort();
    addLog('Agent termination requested.');
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-white/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#141414] rounded-full flex items-center justify-center">
            <Globe className="text-[#E4E3E0] w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase">Universal Web Navigator</h1>
            <p className="text-[10px] font-mono opacity-50 uppercase tracking-widest">Vertex AI Powered / v2.0.0</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isLoading ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
            <span className="text-[10px] font-mono uppercase tracking-widest opacity-70">
              {isLoading ? 'Agent Active' : 'System Ready'}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Controls Panel */}
        <div className="lg:col-span-4 space-y-6">
          <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <div className="flex items-center gap-2 mb-6">
              <Target className="w-5 h-5" />
              <h2 className="font-serif italic text-lg">Mission Parameters</h2>
            </div>

            <div className="space-y-4">
              <AnimatePresence>
                {validationError && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-3 bg-rose-100 border border-rose-200 text-rose-800 text-xs flex items-center gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {validationError}
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label className="block text-[11px] font-mono uppercase opacity-50 mb-1">Target URL</label>
                <input 
                  type="text" 
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="w-full bg-[#F5F5F5] border border-[#141414] p-3 text-sm focus:outline-none focus:ring-1 focus:ring-[#141414]"
                  placeholder="https://example.com"
                />
              </div>

              <div>
                <label className="block text-[11px] font-mono uppercase opacity-50 mb-1">Objective</label>
                <textarea 
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  className="w-full bg-[#F5F5F5] border border-[#141414] p-3 text-sm h-32 resize-none focus:outline-none focus:ring-1 focus:ring-[#141414]"
                  placeholder="Describe what the agent should do..."
                />
              </div>

              <div className="flex gap-2">
                <button 
                  onClick={runAgent}
                  disabled={isLoading}
                  className="flex-1 bg-[#141414] text-[#E4E3E0] p-4 flex items-center justify-center gap-2 hover:bg-[#2A2A2A] transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
                >
                  {isLoading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Play className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  )}
                  <span className="font-bold uppercase tracking-widest text-sm">Deploy Agent</span>
                </button>
                {isLoading && (
                  <button 
                    onClick={stopAgent}
                    className="bg-rose-600 text-white p-4 hover:bg-rose-700 transition-colors"
                    title="Stop Agent"
                  >
                    <Square className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Logs Panel */}
          <section className="bg-[#141414] text-[#E4E3E0] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,0.2)] h-[400px] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-500" />
                <h2 className="text-[10px] font-mono uppercase tracking-widest">Execution Logs</h2>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto font-mono text-[11px] space-y-2 custom-scrollbar">
              {logs.length === 0 ? (
                <p className="opacity-30 italic">Waiting for deployment...</p>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="opacity-30">[{new Date().toLocaleTimeString([], { hour12: false })}]</span>
                    <span className={log.includes('Error') ? 'text-rose-400' : ''}>{log}</span>
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </section>
        </div>

        {/* Visual Stream Panel */}
        <div className="lg:col-span-8 space-y-6">
          <section className="bg-white border border-[#141414] p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] min-h-[600px] flex flex-col">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Eye className="w-5 h-5" />
                <h2 className="font-serif italic text-lg">Visual Stream</h2>
              </div>
              {(result || isLoading) && (
                <div className={`flex items-center gap-2 px-3 py-1 border border-[#141414] text-[10px] font-mono uppercase tracking-widest ${
                  result?.status === 'Complete' ? 'bg-emerald-100 text-emerald-800' : 
                  isLoading ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                }`}>
                  {result?.status === 'Complete' ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                  {isLoading ? 'Processing' : result?.status}
                </div>
              )}
            </div>

            <div className="flex-1 bg-[#F5F5F5] border border-[#141414] relative overflow-hidden flex items-center justify-center group">
              {currentScreenshot ? (
                <img 
                  src={`data:image/png;base64,${currentScreenshot}`} 
                  alt="Agent View" 
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                />
              ) : isLoading ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="relative">
                    <div className="w-16 h-16 border-4 border-[#141414] border-t-transparent rounded-full animate-spin" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Globe className="w-6 h-6 animate-pulse" />
                    </div>
                  </div>
                  <p className="text-[10px] font-mono uppercase tracking-widest opacity-50">Capturing Perception...</p>
                </div>
              ) : (
                <div className="text-center space-y-4 opacity-20 group-hover:opacity-40 transition-opacity">
                  <Globe className="w-24 h-24 mx-auto" />
                  <p className="font-serif italic text-xl">No active stream</p>
                </div>
              )}
              
              {/* Overlay for actions */}
              <AnimatePresence>
                {isLoading && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-0 pointer-events-none border-4 border-amber-500/20"
                  >
                    <div className="absolute top-4 right-4 bg-amber-500 text-white text-[10px] font-mono px-2 py-1 uppercase tracking-widest animate-pulse">
                      Live Processing
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {result?.history && result.history.length > 0 && (
              <div className="mt-6 border-t border-[#141414] pt-6">
                <h3 className="text-[11px] font-mono uppercase opacity-50 mb-4 flex items-center gap-2">
                  <History className="w-3 h-3" />
                  Action History
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {result.history.map((item, i) => (
                    <div key={i} className="flex items-center gap-3 p-3 bg-[#F5F5F5] border border-[#141414] text-xs">
                      <span className="w-6 h-6 bg-[#141414] text-[#E4E3E0] rounded-full flex items-center justify-center text-[10px] font-bold">
                        {i + 1}
                      </span>
                      <span className="flex-1">{item}</span>
                      <ChevronRight className="w-4 h-4 opacity-30" />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(228, 227, 224, 0.2);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(228, 227, 224, 0.4);
        }
      `}} />
    </div>
  );
}
