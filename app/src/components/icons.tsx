// A small hand-drawn icon set (24px grid, stroke icons).

import type { SVGProps } from "react";

const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
type P = SVGProps<SVGSVGElement>;

export const Search = (p: P) => (<svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>);
export const Wallet = (p: P) => (<svg {...base} {...p}><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M16 13h2M3 10h18M6 6l9-3 1 3" /></svg>);
export const Compass = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></svg>);
export const Gear = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z" /></svg>);
export const Back = (p: P) => (<svg {...base} {...p}><path d="m15 18-6-6 6-6" /></svg>);
export const Check = (p: P) => (<svg {...base} strokeWidth={3} {...p}><path d="m5 12 5 5 9-10" /></svg>);
export const Shield = (p: P) => (<svg {...base} {...p}><path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z" /><path d="m9 12 2 2 4-4" /></svg>);
export const Key = (p: P) => (<svg {...base} {...p}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></svg>);
export const Eye = (p: P) => (<svg {...base} {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>);
export const Lock = (p: P) => (<svg {...base} {...p}><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>);
export const Spark = (p: P) => (<svg {...base} {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></svg>);

/** The Revolve mark: a ring with one body in orbit around a shielded core. */
export const Mark = (p: P) => (
  <svg viewBox="0 0 64 64" {...p}>
    <circle cx="32" cy="32" r="30" fill="var(--accent)" />
    <path d="M32 12a20 20 0 1 1-17.3 10" fill="none" stroke="var(--on-accent)" strokeWidth="5" strokeLinecap="round" />
    <circle cx="22" cy="14.7" r="3.4" fill="var(--on-accent)" />
    <path d="M32 22 24 25v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10v-6z" fill="var(--on-accent)" />
  </svg>
);
