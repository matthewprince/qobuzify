export type Theme = {
  name: string;
  slug: string;
  author: string;
  description: string;
  preview: { bg: string; surface: string; accent: string; text: string };
};

// Display metadata for the gallery. The real theme files live in ../../themes/
// and are what `qobuzify apply <slug>` reads; this list mirrors them so the site
// stays standalone.
export const THEMES: Theme[] = [
  {
    name: "Glass",
    slug: "glass",
    author: "matthewprince",
    description: "Electric Blue glassmorphism: frosted chrome over a deep navy. The default.",
    preview: { bg: "#060A12", surface: "#0b0f19", accent: "#3DA8FE", text: "#F0F6FC" },
  },
  {
    name: "Electric Blue",
    slug: "electric-blue",
    author: "matthewprince",
    description: "Qobuz gold swapped for Electric Blue. The stock dark UI, just bluer.",
    preview: { bg: "#121212", surface: "#181818", accent: "#3DA8FE", text: "#f3f3f3" },
  },
  {
    name: "Neon",
    slug: "neon",
    author: "matthewprince",
    description: "Cyberpunk lime on near-black, with an accent glow.",
    preview: { bg: "#0A0A0A", surface: "#111111", accent: "#BBF351", text: "#F0F0F0" },
  },
  {
    name: "Matrix",
    slug: "matrix",
    author: "matthewprince",
    description: "The green-on-black hacker classic.",
    preview: { bg: "#0A0D14", surface: "#11141D", accent: "#26A17B", text: "#E6E9EF" },
  },
  {
    name: "Cosmic",
    slug: "cosmic",
    author: "matthewprince",
    description: "Deep space navy with a golden-star accent and frosted glass.",
    preview: { bg: "#040B17", surface: "#071420", accent: "#FACC15", text: "#E2E8F0" },
  },
  {
    name: "Dramatic",
    slug: "dramatic",
    author: "matthewprince",
    description: "High-contrast near-black with a hot-red accent.",
    preview: { bg: "#080604", surface: "#1E1A16", accent: "#FF2A52", text: "#FDFBF9" },
  },
  {
    name: "Terracotta",
    slug: "terracotta",
    author: "matthewprince",
    description: "Warm earthy browns and terracotta, a cozy listening theme.",
    preview: { bg: "#18110B", surface: "#2B1D14", accent: "#D8825A", text: "#FBF4E7" },
  },
  {
    name: "OLED Black",
    slug: "oled-black",
    author: "matthewprince",
    description: "True black background for OLED screens; the Qobuz gold accent kept.",
    preview: { bg: "#000000", surface: "#0d0d0d", accent: "#dea442", text: "#f3f3f3" },
  },
  {
    name: "Nord",
    slug: "nord",
    author: "matthewprince",
    description: "The Nord palette: polar-night background with a frost accent.",
    preview: { bg: "#2e3440", surface: "#3b4252", accent: "#88c0d0", text: "#eceff4" },
  },
  {
    name: "Dracula",
    slug: "dracula",
    author: "matthewprince",
    description: "The classic Dracula theme: dark slate background, purple accent.",
    preview: { bg: "#282a36", surface: "#343746", accent: "#bd93f9", text: "#f8f8f2" },
  },
];
