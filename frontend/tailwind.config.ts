import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}",
    "./providers/**/*.{ts,tsx}",
    "./shared/**/*.{ts,tsx}",
    "./state/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace']
      },
      colors: {
        brand: {
          50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe',
          300: '#a5b4fc', 400: '#818cf8',
          500: '#6366f1', 600: '#4f46e5', 700: '#4338ca',
          800: '#3730a3', 900: '#312e81', 950: '#1e1b4b',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          card: 'var(--surface-card)',
          raised: 'var(--surface-raised)',
          overlay: 'var(--surface-overlay)',
        },
        sidebar: {
          bg: 'var(--sidebar-bg)',
          border: 'var(--sidebar-border)',
          text: 'var(--sidebar-text)',
          'text-active': 'var(--sidebar-text-active)',
          'active-bg': 'var(--sidebar-active-bg)',
        },
        border: { DEFAULT: 'var(--border)', subtle: 'var(--border-subtle)' },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          placeholder: 'var(--text-placeholder)',
        },
        success: { DEFAULT: 'var(--success)', bg: 'var(--success-bg)', border: 'var(--success-border)' },
        warning: { DEFAULT: 'var(--warning)', bg: 'var(--warning-bg)', border: 'var(--warning-border)' },
        danger: { DEFAULT: 'var(--danger)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
        info: { DEFAULT: 'var(--info)', bg: 'var(--info-bg)', border: 'var(--info-border)' },
      },
      borderRadius: {
        sm: 'var(--radius-sm)', md: 'var(--radius-md)',
        lg: 'var(--radius-lg)', xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)', pill: '9999px',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)', sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)', lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)', brand: 'var(--shadow-brand)',
        focus: 'var(--shadow-focus)',
      },
      animation: {
        'fade-in': 'fadeIn 0.18s ease forwards',
        'fade-up': 'fadeUp 0.22s ease forwards',
        'slide-in-right': 'slideInRight 0.22s cubic-bezier(0.16,1,0.3,1) forwards',
        'slide-in-up': 'slideInUp 0.22s cubic-bezier(0.16,1,0.3,1) forwards',
        'scale-in': 'scaleIn 0.16s cubic-bezier(0.16,1,0.3,1) forwards',
        shimmer: 'shimmer 1.6s infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        fadeUp: { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideInRight: { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        slideInUp: { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        scaleIn: { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      }
    }
  },
  plugins: []
} satisfies Config;
