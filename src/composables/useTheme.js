import { ref, onMounted } from "vue";

const THEME_KEY = "tm_theme";

export function useTheme() {
  const theme = ref("system"); // 'system' | 'light' | 'dark'

  const applyTheme = (next) => {
    const root = document.documentElement;
    if (next === "light") {
      root.setAttribute("data-theme", "light");
    } else if (next === "dark") {
      root.setAttribute("data-theme", "dark");
    } else {
      root.removeAttribute("data-theme"); // fall back to media query
    }
  };

  const load = () => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved) theme.value = saved;
    } catch {}
    applyTheme(theme.value);
  };

  const cycle = () => {
    const order = ["system", "light", "dark"];
    const idx = order.indexOf(theme.value);
    const next = order[(idx + 1) % order.length];
    theme.value = next;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
  };

  onMounted(load);

  // Back-compat alias
  const toggle = cycle;

  return { theme, cycle, toggle, applyTheme };
}
