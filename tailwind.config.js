/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
      colors: {
        'brand-blue': '#0052FF',
        'neutral-900': '#111827',
        'neutral-700': '#374151',
        'neutral-500': '#6B7280',
        'neutral-200': '#E5E7EB',
        'neutral-100': '#F3F4F6',
        'neutral-50': '#F9FAFB',
      }
    },
  },
  plugins: [],
}
