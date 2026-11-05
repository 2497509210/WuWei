import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./pwaInstall";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/workspace.css";
import "./styles/mobile.css";
import "./styles/inventory.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
