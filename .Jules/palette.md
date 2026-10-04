## 2025-03-09 - Added missing ARIA labels to icon-only close/action buttons
**Learning:** Found that numerous icon-only buttons (`<button><IconClose /></button>`, `<button><IconSliders /></button>`, etc.) throughout the app's modals, toolbars, and popovers lacked proper ARIA labels, making them inaccessible to screen readers, though they had `title` attributes.
**Action:** Always ensure icon-only buttons get an explicit `aria-label` (usually duplicating the `title` attribute logic) so their purpose is announced to assistive technologies.
