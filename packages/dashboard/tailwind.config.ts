import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-muted": "var(--surface-muted)",
        fg: "var(--fg)",
        "fg-muted": "var(--fg-muted)",
        "fg-faint": "var(--fg-faint)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        "cta-bg": "var(--cta-bg)",
        "cta-fg": "var(--cta-fg)",
        "state-success": "var(--state-success)",
        "state-warn": "var(--state-warn)",
        "state-err": "var(--state-err)",
        scrim: "var(--scrim)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "ui-sans-serif", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "Menlo", "monospace"],
      },
      fontSize: {
        xs: ["0.75rem", { lineHeight: "1.3" }],
        sm: ["0.8125rem", { lineHeight: "1.4" }],
        base: ["0.875rem", { lineHeight: "1.5" }],
        md: ["0.9375rem", { lineHeight: "1.4" }],
        lg: ["1.125rem", { lineHeight: "1.4" }],
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        pill: "var(--radius-pill)",
      },
      spacing: {
        "sidebar-w": "var(--sidebar-w)",
        "topbar-h": "var(--topbar-h)",
        "content-px": "var(--content-px)",
        "content-py": "var(--content-py)",
        "gap-section": "var(--gap-section)",
        "gap-block": "var(--gap-block)",
      },
      height: {
        row: "var(--row-h)",
        input: "var(--input-h)",
        "input-sm": "var(--input-h-sm)",
      },
      minHeight: {
        row: "var(--row-h)",
      },
      transitionDuration: {
        fast: "120ms",
        medium: "200ms",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "cross-fade": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-in-right": {
          from: { transform: "translateX(100%)" },
          to: { transform: "translateX(0)" },
        },
        "slide-out-right": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms cubic-bezier(0.4,0,0.2,1) forwards",
        "cross-fade": "cross-fade 200ms cubic-bezier(0.4,0,0.2,1) forwards",
        "slide-in-right": "slide-in-right 200ms cubic-bezier(0.4,0,0.2,1) forwards",
        "slide-out-right": "slide-out-right 200ms cubic-bezier(0.4,0,0.2,1) forwards",
      },
    },
  },
  plugins: [],
};

export default config;
