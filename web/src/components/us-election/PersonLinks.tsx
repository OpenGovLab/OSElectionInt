/**
 * Where to go and hear a candidate in their own words.
 *
 * Everything this dashboard shows about a person is filtered through someone
 * else's record-keeping: roll-call votes, FEC filings, press coverage. These
 * links are the one place a reader can leave and check the primary source —
 * the candidate's own channels, their encyclopedia entry, their funding.
 * That matters most for challengers, who have the least derived data and the
 * most to say for themselves.
 *
 * Handles come from unitedstates/congress-legislators (members) and Wikidata
 * (everyone else), joined on bioguide or FEC id rather than on names, because
 * the FEC files Ted Cruz as "Rafael Edward Ted Cruz".
 *
 * Icons are inline SVG on purpose: the page's CSP blocks external hosts, so
 * an icon font or sprite sheet would silently render nothing.
 */

export interface Social {
  twitter?: string | null;
  twitter_id?: string | null;
  facebook?: string | null;
  instagram?: string | null;
  youtube?: string | null;
  youtube_id?: string | null;
  tiktok?: string | null;
  mastodon?: string | null;
}

interface Link {
  key: string;
  href: string;
  title: string;
  icon: JSX.Element;
}

/** Stroke idiom shared with the map toolbar: 24-unit box, no fill. */
const svg = (children: JSX.Element) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
    aria-hidden
  >
    {children}
  </svg>
);

const ICON = {
  x: svg(<><path d="M4 4l16 16M20 4L4 20" /></>),
  facebook: svg(<><path d="M15 3h-2.5A3.5 3.5 0 0 0 9 6.5V9H6.5v3H9v9h3v-9h2.5l.5-3H12V6.5a.5.5 0 0 1 .5-.5H15V3Z" /></>),
  instagram: svg(<><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="3.6" /><path d="M17.5 6.6h.01" /></>),
  youtube: svg(<><rect x="2.5" y="5.5" width="19" height="13" rx="3.5" /><path d="M10.5 9.5l5 2.5-5 2.5v-5Z" /></>),
  tiktok: svg(<><path d="M14 4v9.5a3.5 3.5 0 1 1-3-3.46" /><path d="M14 4c.4 2.3 1.9 3.7 4.5 4" /></>),
  mastodon: svg(<><path d="M12 15.5c-3 0-5.5-.8-5.5-.8" /><path d="M4.8 13.2c-.5-2-.6-5 .3-6.6C6.2 4.7 9 4 12 4s5.8.7 6.9 2.6c.9 1.6.8 4.6.3 6.6-.6 2.4-3.6 3.6-7.2 3.6-1.3 0-2.6-.2-3.6-.5" /><path d="M9 11V9.4a1.9 1.9 0 0 1 3-1.5 1.9 1.9 0 0 1 3 1.5V11" /></>),
  wikipedia: svg(<><path d="M3 6h4M17 6h4M10.5 6h3" /><path d="M5 6l4 12 3-8 3 8 4-12" /></>),
  ballotpedia: svg(<><rect x="4" y="3.5" width="16" height="17" rx="2" /><path d="M8 9.5l2.2 2.2L16 6.5" /><path d="M8 15.5h8" /></>),
  opensecrets: svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M14.3 9.7a2.6 2.6 0 0 0-2.3-1.2c-1.4 0-2.4.8-2.4 1.9 0 2.6 5 1.5 5 4.1 0 1.2-1.1 2-2.6 2a2.8 2.8 0 0 1-2.5-1.3" /></>),
} as const;

/** Wikipedia and Ballotpedia both use underscored titles in their paths. */
const wikiPath = (title: string) =>
  encodeURIComponent(title.trim().replace(/\s+/g, "_"));

/**
 * A handle may arrive already shaped as a URL or with a leading @, depending
 * on which source supplied it. Strip both rather than building a broken link.
 */
const handle = (v: string) =>
  v.trim().replace(/^@/, "").replace(/^https?:\/\/[^/]+\//, "").replace(/\/$/, "");

export function buildLinks({
  social, wikipedia, ballotpedia, opensecrets,
}: {
  social?: Social | null;
  wikipedia?: string | null;
  ballotpedia?: string | null;
  opensecrets?: string | null;
}): Link[] {
  const s = social ?? {};
  const out: Link[] = [];

  if (s.twitter) {
    out.push({ key: "x", title: "X (Twitter)", icon: ICON.x,
      href: `https://x.com/${handle(s.twitter)}` });
  }
  if (s.facebook) {
    out.push({ key: "facebook", title: "Facebook", icon: ICON.facebook,
      href: `https://facebook.com/${handle(s.facebook)}` });
  }
  if (s.instagram) {
    out.push({ key: "instagram", title: "Instagram", icon: ICON.instagram,
      href: `https://instagram.com/${handle(s.instagram)}` });
  }
  // A handle is friendlier and more durable than a channel id, so it wins
  // when both are present; the id is the fallback because members of
  // Congress frequently have only that.
  if (s.youtube || s.youtube_id) {
    out.push({ key: "youtube", title: "YouTube", icon: ICON.youtube,
      href: s.youtube
        ? `https://www.youtube.com/@${handle(s.youtube)}`
        : `https://www.youtube.com/channel/${handle(s.youtube_id as string)}` });
  }
  if (s.tiktok) {
    out.push({ key: "tiktok", title: "TikTok", icon: ICON.tiktok,
      href: `https://tiktok.com/@${handle(s.tiktok)}` });
  }
  // Mastodon handles are stored fully qualified (@user@server) or as a URL.
  if (s.mastodon) {
    const m = s.mastodon.trim();
    const href = /^https?:\/\//.test(m)
      ? m
      : (() => {
          const [, user, server] = /^@?([^@]+)@(.+)$/.exec(m) ?? [];
          return user && server ? `https://${server}/@${user}` : null;
        })();
    if (href) out.push({ key: "mastodon", title: "Mastodon", icon: ICON.mastodon, href });
  }
  if (wikipedia) {
    out.push({ key: "wikipedia", title: "Wikipedia", icon: ICON.wikipedia,
      href: `https://en.wikipedia.org/wiki/${wikiPath(wikipedia)}` });
  }
  if (ballotpedia) {
    out.push({ key: "ballotpedia", title: "Ballotpedia", icon: ICON.ballotpedia,
      href: `https://ballotpedia.org/${wikiPath(ballotpedia)}` });
  }
  if (opensecrets) {
    out.push({ key: "opensecrets", title: "OpenSecrets — who funds them",
      icon: ICON.opensecrets,
      href: `https://www.opensecrets.org/members-of-congress/summary?cid=${encodeURIComponent(opensecrets.trim())}` });
  }
  return out;
}

export default function PersonLinks({
  social, wikipedia, ballotpedia, opensecrets, className = "",
}: {
  social?: Social | null;
  wikipedia?: string | null;
  ballotpedia?: string | null;
  opensecrets?: string | null;
  className?: string;
}) {
  const links = buildLinks({ social, wikipedia, ballotpedia, opensecrets });
  // Coverage is partial — 3,250 candidates have no handle anywhere — so an
  // absent bar is the normal case and must not leave a gap behind.
  if (!links.length) return null;

  return (
    <span className={`flex flex-wrap items-center gap-1 ${className}`}>
      {links.map((l) => (
        <a
          key={l.key}
          href={l.href}
          title={l.title}
          aria-label={l.title}
          target="_blank"
          rel="noopener noreferrer"
          // These rows sit inside clickable parents in some panels; a link
          // click must open the link, not also select the row behind it.
          onClick={(e) => e.stopPropagation()}
          className="rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          {l.icon}
        </a>
      ))}
    </span>
  );
}
