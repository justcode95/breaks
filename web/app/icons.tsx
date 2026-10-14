// The small pictures of the site, drawn as SVG so they look the same everywhere (no emoji fonts, no image files). All of
// them are decoration: the words next to them say the same thing, so they are hidden from screen readers.

const HIDDEN = { "aria-hidden": true, focusable: false } as const;

/** The capsule that stands for the brand: two halves, a seam and a shine. A placeholder like the name. */
export function CapsuleIcon() {
  return (
    <svg viewBox="0 0 32 32" {...HIDDEN}>
      <path d="M2 16a14 14 0 0 1 28 0z" fill="#ff4fa3" />
      <path d="M2 16a14 14 0 0 0 28 0z" fill="#f4f0ff" />
      <rect x="2" y="14.5" width="28" height="3" fill="#2a0b4d" />
      <circle cx="16" cy="16" r="14" fill="none" stroke="#2a0b4d" strokeWidth="2.2" />
      <ellipse cx="10.5" cy="9" rx="3.6" ry="2" transform="rotate(-32 10.5 9)" fill="#fff" opacity="0.8" />
    </svg>
  );
}

/** A five-pointed star: the free spots for holders. */
export function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" {...HIDDEN}>
      <path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21.1 7 14.2 2 9.3l6.9-1z" fill="currentColor" stroke="#2a0b4d" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** A tick: a paid spot that is taken. */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" {...HIDDEN}>
      <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SPARKLE = "M12 0c.9 6.2 3.8 9.1 12 12-8.2 2.9-11.1 5.8-12 12-.9-6.2-3.8-9.1-12-12 8.2-2.9 11.1-5.8 12-12z";

/** The gacha machine of the home page: a glass dome of capsules on a candy-pink body. */
export function MachineArt() {
  return (
    <svg className="machine" viewBox="0 0 260 340" {...HIDDEN}>
      <defs>
        <radialGradient id="m-glass" cx="35%" cy="28%" r="85%">
          <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
          <stop offset="0.45" stopColor="#bfe9ff" stopOpacity="0.18" />
          <stop offset="1" stopColor="#8fb8ff" stopOpacity="0.14" />
        </radialGradient>
        <linearGradient id="m-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff6db3" />
          <stop offset="1" stopColor="#d6246f" />
        </linearGradient>
        <linearGradient id="m-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe27a" />
          <stop offset="1" stopColor="#ff9d2e" />
        </linearGradient>
        <clipPath id="m-dome">
          <circle cx="130" cy="118" r="92" />
        </clipPath>
        <g id="m-cap">
          <path d="M-26 0a26 26 0 0 1 52 0z" fill="currentColor" />
          <path d="M-26 0a26 26 0 0 0 52 0z" fill="#f4f0ff" />
          <rect x="-26" y="-2.5" width="52" height="5" fill="#2a0b4d" opacity="0.6" />
          <circle r="26" fill="none" stroke="#2a0b4d" strokeWidth="3.5" opacity="0.75" />
          <ellipse cx="-10" cy="-14" rx="7" ry="4" transform="rotate(-35 -10 -14)" fill="#fff" opacity="0.8" />
        </g>
      </defs>

      <ellipse cx="130" cy="326" rx="96" ry="9" fill="#000" opacity="0.3" />

      {/* the body */}
      <rect x="36" y="196" width="188" height="122" rx="28" fill="url(#m-body)" stroke="#2a0b4d" strokeWidth="5" />
      <rect x="52" y="206" width="156" height="10" rx="5" fill="#fff" opacity="0.22" />
      <circle cx="82" cy="254" r="22" fill="url(#m-gold)" stroke="#2a0b4d" strokeWidth="5" />
      <rect x="64" y="250" width="36" height="8" rx="4" fill="#2a0b4d" transform="rotate(-30 82 254)" />
      <rect x="146" y="232" width="48" height="44" rx="10" fill="#2a0b4d" />
      <rect x="160" y="242" width="20" height="5" rx="2.5" fill="#ffc93c" />
      <circle cx="170" cy="262" r="5" fill="#ff4fa3" />
      <rect x="94" y="280" width="72" height="38" rx="14" fill="#1a0638" stroke="#2a0b4d" strokeWidth="4" />

      {/* the capsules in the dome */}
      <g clipPath="url(#m-dome)">
        <circle cx="130" cy="118" r="92" fill="#3a1f86" />
        <use href="#m-cap" transform="translate(96 74) rotate(-20)" color="#ff4fa3" />
        <use href="#m-cap" transform="translate(154 66) rotate(25)" color="#ffc93c" />
        <use href="#m-cap" transform="translate(190 112) rotate(-35)" color="#3fe0ff" />
        <use href="#m-cap" transform="translate(70 120) rotate(30)" color="#8bf45a" />
        <use href="#m-cap" transform="translate(128 112) rotate(-10)" color="#a283ff" />
        <use href="#m-cap" transform="translate(166 156) rotate(40)" color="#ff8a3d" />
        <use href="#m-cap" transform="translate(94 162) rotate(-45)" color="#ffc93c" />
        <use href="#m-cap" transform="translate(130 186) rotate(15)" color="#ff4fa3" />
      </g>
      <circle cx="130" cy="118" r="92" fill="url(#m-glass)" stroke="#fff" strokeOpacity="0.65" strokeWidth="4" />
      <rect x="84" y="14" width="92" height="24" rx="12" fill="url(#m-gold)" stroke="#2a0b4d" strokeWidth="4.5" />
      <rect x="50" y="192" width="160" height="20" rx="10" fill="url(#m-gold)" stroke="#2a0b4d" strokeWidth="4.5" />

      {/* a capsule that has just dropped */}
      <use href="#m-cap" transform="translate(130 302) scale(0.62) rotate(-12)" color="#3fe0ff" />

      <path className="twinkle" d={SPARKLE} transform="translate(8 52) scale(1.1)" fill="#ffe27a" />
      <path className="twinkle" d={SPARKLE} transform="translate(226 30) scale(0.9)" fill="#3fe0ff" />
      <path className="twinkle" d={SPARKLE} transform="translate(232 188) scale(1.2)" fill="#ff8ad0" />
    </svg>
  );
}
