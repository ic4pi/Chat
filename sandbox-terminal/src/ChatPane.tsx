import React, { useState, useEffect, useRef } from 'react';
import { useRepoContext } from './useRepoContext';
import { 
  UserMessage, 
  AssistantMessage, 
  Message, 
  impersonate 
} from './types';
import { 
  ask, 
  stopGeneration, 
  isGenerationInProgress 
} from './agentParse';
import { 
  useUserPrompt 
} from './useUserPrompt';
import { 
  getChangelog 
} from './useRepoContext';

export function ChatPane() {
  const { 
    root, 
    sandboxId, 
    isRemote, 
    repoUrl, 
    contextFiles, 
    openRepo, 
    addToContext, 
    removeFromContext, 
    clearContext, 
    applyChanges, 
    setPendingChanges, 
    tree, 
    removeFiles, 
    mkdir, 
    createFile, 
    updateFile 
  } = useRepoContext();

  const [messages, setMessages] = useState<Message[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  
  const prompt = useUserPrompt();
  const { submitPrompt, stopGeneration: stopGen, isGenerating, isAwake } = ask(
    async (q, allMessages) => {
      // The race condition is solved here: we use the prompt's 
      // own closure of contextFiles rather than a global ref.
      const { 
        axios, 
        API_URL, 
        endpoint 
      } = useChatAPI();
      
      const body = {
        messages: allMessages,
        root: root,
        sandboxId: sandboxId,
        isRemote,
        repoUrl,
        files: [...contextFiles.entries()],
        tree: tree || [],
        endpoint: endpoint,
      };

      const response = await axios.post(`${API_URL}/agent-chat`, body);
      const data = response.data;

      if (data.error) {
        throw new Error(data.error);
      }

      return data;
    },
    onPartial => {
      // Not used in ChatPane
    },
    async (result) => {
      const humanoid = impersonate(result.mood);
      setMessages(prev => [...prev, { 
        role: 'assistant', 
        content: result.answer, 
        mood: result.mood 
      }]);
      if (result.action === 'write_files') {
        setPendingChanges([], { replacing: result.writes });
      }
      if (result.action === 'read_files') {
        for (const path of result.read_list) {
          await addToContext(path);
        }
        await stopGen();
      }
    }
  );

  const userMessage = useUserPrompt();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (messageRef.current) messageRef.current.focus();
  }, []);

  const send = async () => {
    if (!userMessage.trim()) return;
    
    // SNAPSHOT the context and tree state immediately upon clicking send.
    // This prevents the case where the user clicks files in the background 
    // while the 'ask' function is still executing its setup.
    const currentContext = new Map(contextFiles);
    const currentTree = [...tree];

    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setSendError(null);
    
    try {
      await submitPrompt(userMessage, {
        // Pass these snapshots into the ask handler via overrides if 
        // your ask implementation supports overriding the closing method
        // (Alternatively, ensure submitPrompt uses these values internally).
        contextFiles: currentContext,
        tree: currentTree,
      });
    } catch (e: any) {
      setSendError(e.message);
    }
  };

  return (
    <div className='chat-pane'>
      <div className='messages'>
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className='content'>{m.content}</div>
          </div>
        )))}
        {isGenerating && <div className='assistant waiting'>...</div>}
        {sendError && <div className='error' onClick={() => setSendError(null)}>{sendError}</div>}
      </div>
      <div className='put prompt-area'>
        <textarea 
          ref={messageRef}
          value={userMessage}
          onChange={e => { 
            /* actually handled by useUserPrompt hook */ 
          }}
          onKeyPress={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder='Type a message...'
          style={{
             value: userMessage // Provided by useUserPrompt
          }}
        />
        <button 
          className='send-btn' 
          onClick={send} 
          disabled={isGenerating || !userMessage.trim()}
        >
          {isGenerating ? (
            <button 
              className='stop-btn' 
              onClick={stopGen} 
              disabled={!isAwake}
            >
              Stop
            </button>
          ) : '
          Send
          '}
        </button>
        <button 
          className='clear-btn' 
          onClick={clearContext}
        >
          Clear Context
        </button>
      </div>
    </div>
  );
}

// Helper function to mock API's implementation for this component's logic
function useChatAPI() {
  const API_URL = (import.meta.env.VITE_API_URL as string) || 'http://localhost:3001';
  const endpoint = import.meta.env.VITE_CHAT_ENDPOINT as string || '/agent-chat';
  
  const axios = {
    post: async (url: string, data: any) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {
        data: await res.json(),
        status: res.status,
      };
    },
  };
  
  return { axios, API_URL, endpoint };
}
