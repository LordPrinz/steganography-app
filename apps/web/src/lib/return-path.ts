const FALLBACK = "/";
const AUTH_PAGES = ["/sign-in", "/sign-up"];
const ORIGIN = "http://localhost";

/**
 * Turns a `next` query value into a path that is safe to redirect to: same-origin and relative,
 * never an auth page (that would loop). Anything else becomes "/".
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return FALLBACK;
  // Parsers strip tabs and newlines, so "/\t/evil.com" would become "//evil.com".
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return FALLBACK;
  }
  if (/%(2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== ORIGIN) return FALLBACK;
  // Dot segments are resolved by the parser: "/.//evil.com" becomes "//evil.com", which a browser
  // treats as another host.
  if (url.pathname.startsWith("//") || url.pathname.includes("\\")) return FALLBACK;
  if (AUTH_PAGES.some((page) => url.pathname === page || url.pathname.startsWith(`${page}/`))) {
    return FALLBACK;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Sign-in URL that brings the user back to `returnTo` afterwards. */
export function signInHref(returnTo: string): string {
  const path = safeReturnPath(returnTo);
  return path === FALLBACK ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`;
}
