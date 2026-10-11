import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function shareMetadata(siteUrl: string, usingLocalOrigin: boolean): Plugin {
  return {
    name: "paperdash-share-metadata",
    configResolved(config) {
      if (config.command === "build" && usingLocalOrigin) {
        config.logger.warn(
          "[paperdash] VITE_SITE_URL and RENDER_EXTERNAL_URL are unset; share URLs use http://localhost:5173. Set VITE_SITE_URL before publishing outside Render.",
        );
      }
    },
    transformIndexHtml() {
      const imageUrl = new URL("/art/paperclub-social-v3.png", siteUrl).href;
      return [
        { tag: "link", attrs: { rel: "canonical", href: siteUrl } },
        { tag: "meta", attrs: { property: "og:url", content: siteUrl } },
        { tag: "meta", attrs: { property: "og:image", content: imageUrl } },
        { tag: "meta", attrs: { name: "twitter:image", content: imageUrl } },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), [
    "VITE_SITE_URL",
    "RENDER_EXTERNAL_URL",
    "VITE_CF_WEB_ANALYTICS_TOKEN",
  ]);
  const configuredOrigin =
    env.VITE_SITE_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  const origin = new URL(configuredOrigin || "http://localhost:5173");
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error(
      "VITE_SITE_URL or RENDER_EXTERNAL_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  const analyticsToken = env.VITE_CF_WEB_ANALYTICS_TOKEN?.trim() ?? "";
  if (analyticsToken && !/^[a-f0-9]{32}$/i.test(analyticsToken)) {
    throw new Error(
      "VITE_CF_WEB_ANALYTICS_TOKEN must be the 32-character public token from Cloudflare Web Analytics.",
    );
  }
  if (analyticsToken && origin.protocol !== "https:") {
    throw new Error(
      "Cloudflare Web Analytics requires an explicitly configured HTTPS site origin.",
    );
  }

  return {
    root: "apps/web",
    envDir: process.cwd(),
    plugins: [react(), shareMetadata(`${origin.origin}/`, !configuredOrigin)],
    define: {
      "import.meta.env.VITE_SITE_URL": JSON.stringify(`${origin.origin}/`),
      "import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN":
        JSON.stringify(analyticsToken),
    },
    build: { outDir: "dist", sourcemap: false },
    server: {
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:8787",
        "/health": "http://127.0.0.1:8787",
      },
    },
  };
});
