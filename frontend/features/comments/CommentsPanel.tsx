'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { MessageSquare, Trash2, Send, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiClient } from '../../shared/lib/apiClient';
import { useAuthStore } from '../../state/auth.store';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { PERMISSIONS } from '../../shared/lib/permissions';
import { Avatar } from '../../shared/components/Avatar';

interface CommentAuthor {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

interface DocComment {
  id: string;
  documentId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: CommentAuthor | null;
}

export function CommentsPanel({ documentId }: { documentId: string }) {
  const qc = useQueryClient();
  const { userId } = useAuthStore();
  const { can } = usePermissions();
  const canModerate = can(PERMISSIONS.DOCUMENT_ARCHIVE);
  const [draft, setDraft] = useState('');

  const queryKey = ['comments', documentId];

  const { data: comments = [], isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      apiClient<{ data: DocComment[] }>(`/documents/${documentId}/comments`).then((r) => r.data),
    staleTime: 15_000,
  });

  const addComment = useMutation({
    mutationFn: (body: string) =>
      apiClient(`/documents/${documentId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to post comment'),
  });

  const deleteComment = useMutation({
    mutationFn: (commentId: string) =>
      apiClient(`/comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to delete comment'),
  });

  const authorName = (a: CommentAuthor | null) =>
    a ? `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() || a.email || 'Unknown' : 'Unknown';

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    addComment.mutate(text);
  };

  return (
    <div className="ui-card">
      <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary mb-4">
        <MessageSquare className="h-4 w-4 text-brand-600" /> Comments
        <span className="ml-auto text-xs font-bold text-text-muted bg-surface-raised px-2 py-0.5 rounded">
          {comments.length}
        </span>
      </h2>

      {/* Composer */}
      <div className="flex gap-3 mb-6">
        <div className="flex-1">
          <textarea
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
            }}
            placeholder="Add a comment…  (⌘/Ctrl + Enter to post)"
            className="ui-input resize-none text-sm"
          />
          <div className="flex justify-end mt-2">
            <button
              onClick={submit}
              disabled={addComment.isPending || !draft.trim()}
              className="ui-btn ui-btn-primary text-xs"
            >
              {addComment.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Comment
            </button>
          </div>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="py-8 flex justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-brand-600" />
        </div>
      ) : comments.length === 0 ? (
        <div className="py-10 text-center">
          <MessageSquare className="h-10 w-10 text-text-muted mx-auto mb-3" />
          <p className="text-sm text-text-muted">No comments yet. Start the discussion.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {comments.map((c) => {
            const canDelete = canModerate || c.author?.id === userId;
            return (
              <div
                key={c.id}
                className={c.parentId ? 'flex gap-3 ml-8' : 'flex gap-3'}
              >
                <Avatar
                  firstName={c.author?.firstName}
                  lastName={c.author?.lastName}
                  email={c.author?.email}
                  size="sm"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-text-primary">
                      {authorName(c.author)}
                    </span>
                    <span className="text-xs text-text-muted">
                      {format(new Date(c.createdAt), 'PPp')}
                    </span>
                    {canDelete && (
                      <button
                        onClick={() => deleteComment.mutate(c.id)}
                        disabled={deleteComment.isPending}
                        className="ml-auto text-text-muted hover:text-rose-600 transition-colors"
                        aria-label="Delete comment"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-text-secondary whitespace-pre-wrap mt-0.5 break-words">
                    {c.body}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
