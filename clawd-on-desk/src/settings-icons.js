"use strict";
// Settings sidebar icons — inline SVG strings keyed by tab id.
//
// All icons use a 24x24 viewBox, `stroke="currentColor"`, fill="none",
// stroke-width 1.5, so they inherit the sidebar text color (works in
// both light and dark mode) and visually match each other.
//
// Why inline SVG and not <img src="...">?
//  - The settings renderer escapes / innerHTMLs the icon string in
//    place; inline SVG side-steps any path resolution (asar / file://)
//    that bites packaged builds.
//  - Each icon is small (~200-500 bytes); the whole file weighs <5 KB.

const ICONS = {
  // ⚙ — gear
  general:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>' +
    '</svg>',

  // MiniCPM — official brand mark (sparkle / burst).
  // Source: assets/svg/minicpm-logo.svg. Filled path; we keep the
  // original 483x486 viewBox and let CSS shrink it into the 18x18
  // sidebar slot. fill=currentColor so it picks up the sidebar text
  // colour in both light and dark mode.
  minicpm:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 483 486" fill="currentColor" width="100%" height="100%">' +
    '<path d="M377.155 0L342.607 89.4753L278.432 255.678L372.466 264.715L423.047 269.575L380.443 297.333L317.266 338.491L430.581 409.397L483 442.198L421.206 442.271L234.596 442.489L241.294 479.049L206.392 485.475L195.85 427.942L192.007 406.969L213.28 406.944L359.37 406.771L274.848 353.882L251.22 339.097L274.574 323.882L318.499 295.263L251.743 288.849L228.439 286.61L236.889 264.725L274.966 166.109L203.457 245.266L184.916 265.79L174.005 240.353L148.719 181.411L141.971 249.893L138.774 282.326L113.293 262.083L79.638 235.344L102.221 295.148L113.983 326.294L81.6193 318.771L0.798157 299.985L8.81415 265.333L57.2705 276.594L23.6994 187.692L0.948303 127.445L51.314 167.457L109.852 213.961L120.175 109.251L126.942 40.5891L154.132 103.974L195.692 200.864L312.909 71.1169L377.155 0Z"/>' +
    '</svg>',

  // ⚡ — bolt
  agents:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>' +
    '</svg>',

  // 🎨 — palette
  theme:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M12 22a10 10 0 1 1 10-10c0 2.5-2 4-4 4h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 22Z"/>' +
    '<circle cx="7.5" cy="10.5" r="1" fill="currentColor"/>' +
    '<circle cx="12" cy="7.5" r="1" fill="currentColor"/>' +
    '<circle cx="16.5" cy="10.5" r="1" fill="currentColor"/>' +
    '</svg>',

  // 🎬 — clapperboard
  animMap:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="2" y="7" width="20" height="13" rx="2"/>' +
    '<path d="m4 7 3-4M10 7l3-4M16 7l3-4"/>' +
    '</svg>',

  // 🎞 — film strip
  animOverrides:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="M7 4v16M17 4v16"/>' +
    '<path d="M3 9h4M17 9h4M3 15h4M17 15h4"/>' +
    '</svg>',

  // ⌨ — keyboard
  shortcuts:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
    '<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>' +
    '</svg>',

  "telegram-approval":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M21 4 3.8 11.2c-.8.3-.8 1.5.1 1.8l4.4 1.5 1.8 5c.3.8 1.4.9 1.8.2L21 4Z"/>' +
    '<path d="m8.3 14.5 5.2-4.2"/>' +
    '</svg>',

  // 🔌 — plug
  "remote-ssh":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M9 2v6M15 2v6"/>' +
    '<path d="M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8Z"/>' +
    '<path d="M12 16v6"/>' +
    '</svg>',

  mobile:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="7" y="2.5" width="10" height="19" rx="2"/>' +
    '<path d="M10.5 18.5h3"/>' +
    '</svg>',

  // ℹ — info circle
  about:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 11v6M12 7.5v.01"/>' +
    '</svg>',

  // 🛠 — wrench-and-screwdriver (placeholder when a tab is missing one)
  placeholder:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="m14.5 5.5 4 4-9 9-4 .5.5-4 8.5-9.5Z"/>' +
    '<path d="m18.5 5.5-3 3"/>' +
    '</svg>',
};

function getIcon(id) {
  return ICONS[id] || ICONS.placeholder;
}

globalThis.ClawdSettingsIcons = { getIcon, ICONS };
