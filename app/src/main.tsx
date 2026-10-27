import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/besley/700.css";
import "@fontsource/work-sans/400.css";
import "@fontsource/work-sans/600.css";
import "./theme.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
