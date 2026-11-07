## 2025-02-14 - Missing ARIA Labels on Icon-Only Buttons
**Learning:** Found multiple icon-only buttons across the app (Settings, Library, Close modals) lacking `aria-label`s, creating an accessibility issue for screen readers.
**Action:** Always verify that buttons relying solely on an SVG/icon component have a descriptive `aria-label` utilizing the `t()` string localization.
