import { describe, expect, it, vi } from "vitest";
import {
  runSiteBootstrap,
  type SiteBootstrapEnvironment,
} from "../apps/web/src/lib/site-bootstrap";

const canonical = "https://canonical.example";
const token = "0123456789abcdef0123456789abcdef";
const options = { production: true, siteUrl: canonical, analyticsToken: token };
interface Script {
  id: string;
  src: string;
  type: string;
  defer: boolean;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
}
function browser(href: string) {
  const url = new URL(href),
    scripts: Script[] = [];
  const replace = vi.fn();
  const document = {
    querySelector: vi.fn(
      (selectors: string) =>
        scripts.find((script) =>
          selectors.split(",").some((selector) => {
            const id = /^script#(.+)$/.exec(selector)?.[1];
            if (id) return script.id === id;
            const attribute = /^script\[([^=\]]+)\]$/.exec(selector)?.[1];
            if (attribute) return script.attrs.has(attribute);
            const source = /^script\[src\^="([^"]+)"\]$/.exec(selector)?.[1];
            return source ? script.src.startsWith(source) : false;
          }),
        ) ?? null,
    ),
    createElement: vi.fn(
      () =>
        ({
          id: "",
          src: "",
          type: "",
          defer: false,
          attrs: new Map<string, string>(),
          setAttribute(name: string, value: string) {
            this.attrs.set(name, value);
          },
        }) as Script,
    ),
    head: {
      appendChild: vi.fn((script: Script) => {
        scripts.push(script);
        return script;
      }),
    },
  };
  const environment = {
    location: {
      origin: url.origin,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace,
    },
    document,
  } as unknown as SiteBootstrapEnvironment;
  return { environment, document, scripts, replace };
}

describe("production site bootstrap", () => {
  it("redirects only the legacy host and preserves encoded path, query and fragment before loading analytics", () => {
    const source =
      "https://paperdash-web.onrender.com/wallets/a%2Fb?view=assets&asset=1&wallet=0x123&name=a%26b#trade-42";
    const { environment, replace, document } = browser(source);
    expect(runSiteBootstrap(options, environment)).toBe(true);
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(
      `${canonical}/wallets/a%2Fb?view=assets&asset=1&wallet=0x123&name=a%26b#trade-42`,
    );
    expect(document.querySelector).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it("does not let a protocol-relative pathname change the redirect authority", () => {
    const { environment, replace } = browser(
      "https://paperdash-web.onrender.com//untrusted.example/path?next=https://elsewhere.example#section",
    );
    expect(runSiteBootstrap(options, environment)).toBe(true);
    const destination = new URL(replace.mock.calls[0][0]);
    expect(destination.origin).toBe(canonical);
    expect(destination.pathname).toBe("//untrusted.example/path");
    expect(destination.search).toBe("?next=https://elsewhere.example");
    expect(destination.hash).toBe("#section");
  });

  it.each([
    "http://localhost:5173/?view=assets",
    "https://localhost/?view=assets",
    "http://127.0.0.1:4173/",
    "http://[::1]:4173/",
    "https://paperdash-web-pr-42.onrender.com/",
    "https://elsewhere.example/",
    "https://canonical.example.attacker.invalid/",
    "https://canonical.example:444/",
    "http://canonical.example/",
  ])("does not redirect or track an unrelated origin: %s", (href) => {
    const { environment, replace, scripts } = browser(href);
    expect(runSiteBootstrap(options, environment)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(scripts).toEqual([]);
  });

  it.each(["https://paperdash-web.onrender.com/", `${canonical}/`])(
    "does nothing in development at %s",
    (href) => {
      const { environment, replace, scripts } = browser(href);
      expect(
        runSiteBootstrap({ ...options, production: false }, environment),
      ).toBe(false);
      expect(replace).not.toHaveBeenCalled();
      expect(scripts).toEqual([]);
    },
  );

  it.each([
    undefined,
    "",
    "not a URL",
    "//canonical.example",
    "http://canonical.example",
    "javascript:alert(1)",
    "https://user:password@canonical.example",
    "https://canonical.example/path",
    "https://canonical.example?query=1",
    "https://canonical.example#fragment",
    "https://localhost",
    "https://test.localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://paperdash-web.onrender.com",
    "https://preview.onrender.com",
  ])(
    "safely rejects an invalid/custom-origin-ineligible site setting: %s",
    (siteUrl) => {
      const { environment, replace, scripts } = browser(
        "https://paperdash-web.onrender.com/",
      );
      expect(runSiteBootstrap({ ...options, siteUrl }, environment)).toBe(
        false,
      );
      expect(replace).not.toHaveBeenCalled();
      expect(scripts).toEqual([]);
    },
  );

  it("injects one deferred Cloudflare beacon on the exact canonical origin", () => {
    const { environment, replace, scripts } = browser(
      `${canonical}/?view=assets#chart`,
    );
    expect(runSiteBootstrap(options, environment)).toBe(false);
    expect(runSiteBootstrap(options, environment)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      id: "paperdash-cloudflare-beacon",
      src: "https://static.cloudflareinsights.com/beacon.min.js",
      type: "module",
      defer: true,
    });
    expect(JSON.parse(scripts[0].attrs.get("data-cf-beacon")!)).toEqual({
      token,
    });
  });

  it.each([
    undefined,
    "",
    " ",
    "abc",
    "0".repeat(31),
    "0".repeat(33),
    "g".repeat(32),
    `${token}\" onload=alert(1)`,
  ])("does not inject an invalid analytics token", (analyticsToken) => {
    const { environment, scripts } = browser(canonical);
    expect(runSiteBootstrap({ ...options, analyticsToken }, environment)).toBe(
      false,
    );
    expect(scripts).toEqual([]);
  });

  it.each(["id", "attribute", "source"])(
    "does not duplicate an existing Cloudflare beacon detected by %s",
    (guard) => {
      const { environment, document, scripts } = browser(canonical);
      const existing = document.createElement();
      if (guard === "id") existing.id = "paperdash-cloudflare-beacon";
      if (guard === "attribute") existing.setAttribute("data-cf-beacon", "{}");
      if (guard === "source")
        existing.src =
          "https://static.cloudflareinsights.com/beacon.min.js/version";
      document.head.appendChild(existing);
      runSiteBootstrap(options, environment);
      expect(scripts).toEqual([existing]);
    },
  );

  it("does not let unrelated scripts suppress the beacon and tolerates uppercase valid tokens", () => {
    const { environment, document, scripts } = browser(canonical);
    const unrelated = document.createElement();
    unrelated.src = "https://canonical.example/assets/app.js";
    document.head.appendChild(unrelated);
    runSiteBootstrap(
      { ...options, analyticsToken: ` ${token.toUpperCase()} ` },
      environment,
    );
    expect(scripts).toHaveLength(2);
    expect(JSON.parse(scripts[1].attrs.get("data-cf-beacon")!)).toEqual({
      token: token.toUpperCase(),
    });
  });

  it("leaves the app usable when a restricted context rejects navigation or optional analytics insertion", () => {
    const legacy = browser("https://paperdash-web.onrender.com/");
    legacy.replace.mockImplementation(() => {
      throw new Error("navigation denied");
    });
    expect(runSiteBootstrap(options, legacy.environment)).toBe(false);
    expect(legacy.scripts).toEqual([]);
    const canonicalBrowser = browser(canonical);
    canonicalBrowser.document.head.appendChild.mockImplementation(() => {
      throw new Error("insertion denied");
    });
    expect(runSiteBootstrap(options, canonicalBrowser.environment)).toBe(false);
  });
});
