"use client";

import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiClient } from '../lib/apiClient';
import { useResetOnChange } from '../hooks/useResetOnChange';

export interface PickedDocument {
  id: string;
  label: string;
  documentNumber?: string | null;
}

interface DocumentSearchResult {
  id: string;
  title?: string;
  documentName?: string;
  documentNumber?: string | null;
}

/**
 * Searchable multi-select for documents. Queries GET /documents?q=… (debounced)
 * and renders the selection as removable chips. Used by the legal-hold console;
 * reusable anywhere a list of document ids must be collected.
 */
export function DocumentMultiPicker({
  selected,
  onChange,
  placeholder = 'Search documents by name or number...',
}: {
  selected: PickedDocument[];
  onChange: (docs: PickedDocument[]) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DocumentSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Emptying the list for a too-short query is derived from `query`, so it is
  // a render-time adjustment; only the debounced fetch below is a real effect.
  useResetOnChange([query], () => {
    if (query.trim().length < 2) setResults([]);
  });

  useEffect(() => {
    if (query.trim().length < 2) return;
    const t = setTimeout(async () => {
      try {
        const res = await apiClient<{ data: DocumentSearchResult[] }>(
          `/documents?q=${encodeURIComponent(query.trim())}&take=10`,
        );
        setResults(res.data || []);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const add = (doc: DocumentSearchResult) => {
    if (!selected.some((s) => s.id === doc.id)) {
      onChange([
        ...selected,
        { id: doc.id, label: doc.title || doc.documentName || doc.id, documentNumber: doc.documentNumber },
      ]);
    }
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const remove = (id: string) => onChange(selected.filter((s) => s.id !== id));

  return (
    <div ref={containerRef} className="relative">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((doc) => (
            <span
              key={doc.id}
              className="inline-flex items-center gap-1 pl-2 pr-1 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
            >
              <span className="max-w-[220px] truncate" title={doc.label}>{doc.label}</span>
              {doc.documentNumber && <span className="opacity-70">#{doc.documentNumber}</span>}
              <button
                type="button"
                onClick={() => remove(doc.id)}
                className="p-0.5 rounded hover:bg-blue-200 dark:hover:bg-blue-800"
                aria-label={`Remove ${doc.label}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((doc) => {
            const alreadySelected = selected.some((s) => s.id === doc.id);
            return (
              <li
                key={doc.id}
                onMouseDown={() => !alreadySelected && add(doc)}
                className={`px-3 py-2 text-sm ${
                  alreadySelected
                    ? 'opacity-50 cursor-default'
                    : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                <span className="font-medium">{doc.title || doc.documentName}</span>
                {doc.documentNumber && <span className="ml-2 text-gray-500 text-xs">#{doc.documentNumber}</span>}
                {alreadySelected && <span className="ml-2 text-xs text-gray-400">selected</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
