/** @type {import('tailwindcss').Config} */

// Day/night theme (P7): every palette resolves to CSS variables defined in src/style.css, so the same
// classes render both themes. Neutral greys use the `slate` name the components were written with; all
// accent hues (sky, indigo, violet…) map to the single study accent blue.
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const scale = name => Object.fromEntries(STEPS.map(s => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`]));
const blue = scale('blue');

export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Larger phones (≥ 400px wide); sm / md / lg stay Tailwind's 640 / 768 / 1024
      screens: { xs: '400px' },
      colors: {
        slate: scale('n'),
        gray: scale('n'),
        sky: blue,
        blue,
        indigo: blue,
        violet: blue,
        purple: blue,
        fuchsia: blue,
        pink: blue,
        cyan: blue,
        amber: scale('amber'),
        yellow: scale('amber'),
        orange: scale('amber'),
        emerald: scale('emerald'),
        green: scale('emerald'),
        rose: scale('rose'),
        red: scale('rose'),
        // Strongest text colour of the current theme (white at night, near-black by day)
        ink: 'rgb(var(--c-ink) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['"Segoe UI"', '"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"', 'system-ui', '-apple-system', 'sans-serif']
      }
    },
    // Calm shapes: small radii and soft shadows (floating panels only)
    borderRadius: {
      none: '0',
      sm: '0.25rem',
      DEFAULT: '0.375rem',
      md: '0.375rem',
      lg: '0.375rem',
      xl: '0.5rem',
      '2xl': '0.625rem',
      '3xl': '0.75rem',
      full: '9999px'
    },
    boxShadow: {
      none: 'none',
      xs: '0 1px 1px 0 rgb(0 0 0 / 0.04)',
      sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
      DEFAULT: '0 1px 3px 0 rgb(0 0 0 / 0.08)',
      md: '0 2px 6px -1px rgb(0 0 0 / 0.08)',
      lg: '0 4px 12px -2px rgb(0 0 0 / 0.10)',
      xl: '0 8px 20px -4px rgb(0 0 0 / 0.12)',
      '2xl': '0 12px 28px -6px rgb(0 0 0 / 0.16)',
      inner: 'inset 0 1px 2px 0 rgb(0 0 0 / 0.05)'
    },
    // Headings stay modest (largest sizes capped)
    fontSize: {
      '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      xs: ['0.75rem', { lineHeight: '1rem' }],
      sm: ['0.875rem', { lineHeight: '1.25rem' }],
      base: ['1rem', { lineHeight: '1.5rem' }],
      lg: ['1.0625rem', { lineHeight: '1.5rem' }],
      xl: ['1.125rem', { lineHeight: '1.625rem' }],
      '2xl': ['1.25rem', { lineHeight: '1.75rem' }],
      '3xl': ['1.25rem', { lineHeight: '1.75rem' }],
      '4xl': ['1.375rem', { lineHeight: '1.875rem' }],
      '5xl': ['1.5rem', { lineHeight: '2rem' }],
      '6xl': ['1.5rem', { lineHeight: '2rem' }]
    }
  },
  plugins: [
    // Touch screens (phones, tablets): `pointer-coarse:` for finger-sized targets
    ({ addVariant }) => addVariant('pointer-coarse', '@media (pointer: coarse)')
  ]
};
