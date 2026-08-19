/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        aurora: {
          violet: 'rgb(var(--accent-rgb) / <alpha-value>)',
          cyan: 'rgb(var(--accent2-rgb) / <alpha-value>)',
          gold: '#F59E0B',
        },
        void: {
          950: '#03040E',
          900: '#07081A',
          800: '#0D0F26',
          700: '#131530',
          600: '#1A1D3A',
          500: '#222548',
        }
      },
      fontFamily: {
        syne: ['Syne', 'sans-serif'],
        jakarta: ['"Plus Jakarta Sans"', 'sans-serif'],
      },
      boxShadow: {
        'aurora-sm': '0 0 12px rgb(var(--accent-rgb) / 0.25), 0 0 4px rgb(var(--accent-rgb) / 0.15)',
        'aurora': '0 0 24px rgb(var(--accent-rgb) / 0.35), 0 0 8px rgb(var(--accent-rgb) / 0.2)',
        'aurora-lg': '0 0 40px rgb(var(--accent-rgb) / 0.4), 0 0 16px rgb(var(--accent-rgb) / 0.25)',
        'glow-cyan': '0 0 20px rgb(var(--accent2-rgb) / 0.3)',
      },
      animation: {
        'aurora-drift': 'auroraDrift 12s ease-in-out infinite',
        'fade-up': 'fadeUp 0.5s ease-out forwards',
        'card-enter': 'cardEnter 0.4s cubic-bezier(0.22,1,0.36,1) forwards',
      },
      keyframes: {
        auroraDrift: {
          '0%, 100%': { transform: 'translate(0%, 0%) rotate(0deg)' },
          '33%': { transform: 'translate(3%, -2%) rotate(1deg)' },
          '66%': { transform: 'translate(-2%, 1%) rotate(-1deg)' },
        },
        fadeUp: {
          from: { opacity: 0, transform: 'translateY(12px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        cardEnter: {
          from: { opacity: 0, transform: 'scale(0.96) translateY(8px)' },
          to: { opacity: 1, transform: 'scale(1) translateY(0)' },
        }
      }
    },
  },
  plugins: [],
}
