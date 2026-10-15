'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark-black' | 'dark-blue';

type ThemeState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'light',
      setTheme: (theme) => set({ theme }),
    }),
    {
      // DO NOT RENAME: localStorage key for the persisted theme preference.
      // Kept as `edams-theme` through the rebrand (invisible storage key).
      name: 'edams-theme',
    },
  ),
);
