import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#141216",       // warm charcoal, not pure black
        surface: "#1C191E",    // panel background
        "surface-2": "#26222A",
        border: "#332E37",
        ink: "#F1EDE6",        // warm off-white text
        muted: "#928C97",
        brass: {
          DEFAULT: "#D9A441",  // primary action / mint accent
          hover: "#E8B657",
          dim: "#8A6B2E",
        },
        ember: {
          DEFAULT: "#C6584A",  // sell / negative
          hover: "#D6695A",
        },
        plum: "#3A2233",        // secondary panel accent
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        sm: "3px",
        DEFAULT: "4px",
        md: "6px",
      },
    },
  },
  plugins: [],
};
export default config;
