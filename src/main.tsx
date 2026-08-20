import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadHost } from "./host";

// Which OS we are on decides shortcut labels, path separators, install commands
// and whether PDF export exists at all. It costs one IPC round trip, and every
// one of those answers is baked into the very first paint — so the render waits
// for it rather than repainting a moment later with different key glyphs.
// Outside Tauri the call rejects at once and the user-agent guess stands.
const render = () =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

loadHost().then(render, render);
