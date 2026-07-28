export type ThemeDefinition = {
  id: string;
  name: string;
  base: "light" | "soft-light" | "dark";
  colors: Record<string, string>;
  components: Record<string, string>;
  fonts?: { ui: string; code: string };
  monaco: Record<string, string>;
  /** Optional Monaco token palette. Omitted tokens use Agent K's base palette. */
  monacoSyntax?: Record<string, string>;
  terminal: Record<string, string>;
  builtin?: boolean;
};
