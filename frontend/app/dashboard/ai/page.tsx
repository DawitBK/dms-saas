'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { TopBar } from '../../../shared/components/TopBar';
import { PageHeader } from '../../../shared/components/PageHeader';
import { PermissionGate } from '../../../shared/components/PermissionGate';
import { PERMISSIONS } from '../../../shared/lib/permissions';
import { apiClient } from '../../../shared/lib/apiClient';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

export default function AIPage() {
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const chat = useMutation({
    mutationFn: (text: string) => apiClient<{ response: string; model?: string }>('/ai/chat', { method: 'POST', body: JSON.stringify({ message: text, history }) }),
    onSuccess: (res, text) => {
      setHistory((h) => [...h, { role: 'user', content: text }, { role: 'assistant', content: res.response || 'No response returned.' }]);
      setMessage('');
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'AI chat unavailable'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    chat.mutate(text);
  };

  return (
    <PermissionGate permission={PERMISSIONS.AUDIT_READ}>
      <div className="h-full flex flex-col" style={{ background: 'var(--surface-base)' }}>
        <TopBar title="AI Assistant" />
        <div className="flex-1 overflow-y-auto min-h-0 px-6 py-8">
          <div className="max-w-4xl mx-auto">
            <PageHeader title="Compliance Assistant" subtitle="Ask about document activity, audit events, and compliance signals scoped to your tenant." />
            <div className="ui-card mt-5 min-h-[560px] flex flex-col">
              <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                {history.length === 0 ? <div className="h-full min-h-[360px] flex flex-col items-center justify-center text-center"><Bot className="h-10 w-10 mb-3" style={{ color: 'var(--brand-600)' }} /><p className="text-sm" style={{ color: 'var(--text-muted)' }}>Try asking: Which documents had unusual access this week?</p></div> : history.map((m, i) => <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className="max-w-[78%] rounded-xl px-4 py-3 text-sm whitespace-pre-wrap" style={{ background: m.role === 'user' ? 'var(--brand-600)' : 'var(--surface-raised)', color: m.role === 'user' ? '#fff' : 'var(--text-primary)' }}>{m.content}</div></div>)}
                {chat.isPending && <div className="text-sm" style={{ color: 'var(--text-muted)' }}>Thinking...</div>}
              </div>
              <form onSubmit={submit} className="mt-4 flex gap-2">
                <input value={message} onChange={(e) => setMessage(e.target.value)} className="ui-input flex-1" placeholder="Ask a compliance question" />
                <button disabled={chat.isPending || !message.trim()} className="ui-btn ui-btn-primary"><Send className="h-4 w-4" /> Send</button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}