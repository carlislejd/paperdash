export interface SiteBootstrapOptions {
  production: boolean;
  siteUrl?: string;
  analyticsToken?: string;
}

export interface SiteBootstrapEnvironment {
  location: Pick<
    Location,
    "origin" | "hostname" | "pathname" | "search" | "hash" | "replace"
  >;
  document: Pick<Document, "querySelector" | "createElement" | "head">;
}

const legacyHostname = "paperdash-web.onrender.com";
const beaconSource = "https://static.cloudflareinsights.com/beacon.min.js";
const beaconId = "paperdash-cloudflare-beacon";

function canonicalOrigin(siteUrl: string | undefined): URL | null {
  if (!siteUrl?.trim()) return null;
  try {
    const url = new URL(siteUrl.trim());
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !host.includes(".") ||
      host.endsWith(".localhost") ||
      host === "localhost" ||
      host.startsWith("[") ||
      /^\d+(?:\.\d+){3}$/.test(host) ||
      host === "onrender.com" ||
      host.endsWith(".onrender.com")
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Run once before rendering. Returns true only after initiating a redirect. */
export function runSiteBootstrap(
  options: SiteBootstrapOptions,
  environment: SiteBootstrapEnvironment = {
    location: window.location,
    document: window.document,
  },
): boolean {
  if (!options.production) return false;
  const target = canonicalOrigin(options.siteUrl);
  if (!target) return false;
  const { location, document } = environment;

  if (
    location.hostname === legacyHostname &&
    location.origin !== target.origin
  ) {
    // Assign URL components instead of resolving a path: a pathname beginning
    // with // must remain a path, never replace the configured authority.
    target.pathname = location.pathname;
    target.search = location.search;
    target.hash = location.hash;
    try {
      location.replace(target.href);
      return true;
    } catch {
      // A restricted browsing context can deny navigation. Keep the dashboard
      // usable there, without sending analytics from the legacy origin.
      return false;
    }
  }

  const token = options.analyticsToken?.trim();
  if (
    location.origin !== target.origin ||
    !token ||
    !/^[\da-f]{32}$/i.test(token)
  )
    return false;

  // Respect both our own beacon and Cloudflare's separately injected beacon.
  // Initializing outside React also avoids StrictMode's repeated effects.
  if (
    document.querySelector(
      `script#${beaconId},script[data-cf-beacon],script[src^="${beaconSource}"]`,
    )
  )
    return false;
  try {
    const script = document.createElement("script");
    script.id = beaconId;
    script.src = beaconSource;
    script.type = "module";
    script.defer = true;
    script.setAttribute("data-cf-beacon", JSON.stringify({ token }));
    document.head?.appendChild(script);
  } catch {
    // Optional analytics must never prevent the application from rendering.
  }
  return false;
}
