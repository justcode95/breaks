import Link from "next/link";

export const LINKS = [
  { href: "/breaks", label: "Breaks" },
  { href: "/treasury", label: "Treasury" },
  { href: "/me", label: "My spots" },
  { href: "/verify", label: "Verify a draw" },
] as const;

/** Whether `pathname` is the page of `href` or a page below it (`/breaks/7` is under `/breaks`). */
export function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The main navigation for the page at `pathname`. The page you are on is marked, for the eye and for screen readers. */
export function NavLinks({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Main">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={isCurrent(pathname, l.href) ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
