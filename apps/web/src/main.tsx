import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { runSiteBootstrap } from "./lib/site-bootstrap";
import "./styles.css";
import "./components/analytics.css";

const redirecting = runSiteBootstrap({
  production: import.meta.env.PROD,
  siteUrl: import.meta.env.VITE_SITE_URL,
  analyticsToken: import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN,
});

if (!redirecting) {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
