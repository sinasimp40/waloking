/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        neon: {
          orange: 'rgb(var(--accent-rgb) / <alpha-value>)',
          dark: 'rgb(var(--accent-dark-rgb) / <alpha-value>)',
          glow: 'rgb(var(--accent-rgb) / 0.5)',
          light: 'rgb(var(--accent-light-rgb) / <alpha-value>)',
        },
        dark: {
          100: '#1a1410',
          200: '#151010',
          300: '#1a0f05',
          400: '#0a0806',
          500: '#050403',
        }
      },
      fontFamily: {
        orbitron: ['Orbitron', 'monospace'],
        rajdhani: ['Rajdhani', 'sans-serif'],
      },
      boxShadow: {
        neon: '0 0 10px rgb(var(--accent-rgb)), 0 0 20px rgb(var(--accent-rgb)), 0 0 40px rgb(var(--accent-rgb) / 0.5)',
        'neon-sm': '0 0 5px rgb(var(--accent-rgb)), 0 0 10px rgb(var(--accent-rgb) / 0.5)',
        'neon-lg': '0 0 20px rgb(var(--accent-rgb)), 0 0 40px rgb(var(--accent-rgb)), 0 0 80px rgb(var(--accent-rgb) / 0.25)',
      },
      animation: {
        'pulse-neon': 'pulseNeon 2s ease-in-out infinite',
        'scan': 'scan 3s linear infinite',
        'float': 'float 3s ease-in-out infinite',
        'glow-border': 'glowBorder 2s ease-in-out infinite',
      },
      keyframes: {
        pulseNeon: {
          '0%, 100%': { boxShadow: '0 0 5px rgb(var(--accent-rgb)), 0 0 10px rgb(var(--accent-rgb))' },
          '50%': { boxShadow: '0 0 20px rgb(var(--accent-rgb)), 0 0 40px rgb(var(--accent-rgb)), 0 0 60px rgb(var(--accent-rgb) / 0.5)' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        glowBorder: {
          '0%, 100%': { borderColor: 'rgb(var(--accent-rgb) / 0.5)' },
          '50%': { borderColor: 'rgb(var(--accent-rgb))' },
        }
      }
    },
  },
  plugins: [],
}
