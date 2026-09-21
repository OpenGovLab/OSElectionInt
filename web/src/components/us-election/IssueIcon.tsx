/**
 * One glyph per issue category.
 *
 * The icon name arrives from the server alongside the axis, so the mapping
 * lives in one place (scripts/data/issue_axes.json) rather than being a
 * second copy here that drifts from it. An unrecognised name falls back to a
 * neutral dot instead of rendering nothing, so a category added server-side
 * still gets a row rather than a hole.
 *
 * Inline SVG only: the page's CSP blocks external hosts, so an icon font or a
 * CDN sprite would silently fail to load. Same idiom as the toolbar —
 * 24x24 viewBox, no fill, stroke from currentColor.
 */

const PATHS: Record<string, string> = {
  // Gun Policy
  shield: "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z",
  // Climate Change and Environment
  leaf: "M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6",
  // Social Justice and Civil Rights
  scales: "M12 3v18M8 21h8M3 7h18M6 7l-3 6h6l-3-6zm12 0l-3 6h6l-3-6z",
  // Immigration
  route: "M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-14a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 19h6a3 3 0 0 0 3-3V8",
  // Healthcare and Public Health
  heart: "M19 14c1.5-1.5 3-3.2 3-5.5A4.5 4.5 0 0 0 12 6a4.5 4.5 0 0 0-10 2.5c0 2.3 1.5 4 3 5.5l7 7 7-7z",
  // Economy and Finance
  chart: "M3 3v18h18M7 15l4-5 3 3 5-7",
  // Education
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  // Foreign Policy and National Security
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z",
  // Government Reform
  gavel: "M14 3l7 7-3 3-7-7 3-3zM10 9l-7 7 3 3 7-7M3 21h8",
  // Labor and Employment
  hardhat: "M4 16a8 8 0 0 1 16 0M2 16h20v3H2v-3zM10 4h4v5h-4z",
  // Drug Policy
  pill: "M10.5 20.5a5 5 0 0 1-7-7l7-7a5 5 0 0 1 7 7l-7 7zM8.5 8.5l7 7",
  // Social Welfare Programs
  hands: "M12 21c4 0 7-3 7-7v-5a2 2 0 0 0-4 0M12 21c-4 0-7-3-7-7v-5a2 2 0 0 1 4 0M9 9V5a2 2 0 0 1 4 0v4M15 9V6a2 2 0 0 1 4 0v3",
  // Science and Technology
  cpu: "M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4",
  // Abortion and Reproductive Rights
  stethoscope: "M4 3v6a5 5 0 0 0 10 0V3M9 14v2a5 5 0 0 0 10 0v-2M19 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  dot: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
};

export default function IssueIcon({
  name, className = "h-3.5 w-3.5",
}: { name?: string | null; className?: string }) {
  const d = PATHS[String(name ?? "")] ?? PATHS.dot;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}
