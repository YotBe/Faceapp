// Small line icons drawn for Gloss, in the weight and proportions iOS uses.
import type { ReactNode } from 'react';

const Svg = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ShareIcon = () => (
  <Svg>
    <path d="M12 15V3.5M7.8 7.4 12 3.2l4.2 4.2M7 10.5H5.8A1.8 1.8 0 0 0 4 12.3v6.9A1.8 1.8 0 0 0 5.8 21h12.4a1.8 1.8 0 0 0 1.8-1.8v-6.9a1.8 1.8 0 0 0-1.8-1.8H17" />
  </Svg>
);
export const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4.2" height="14" rx="1.3" /><rect x="13.8" y="5" width="4.2" height="14" rx="1.3" /></svg>
);
export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 5.3v13.4a.9.9 0 0 0 1.4.8l10-6.7a.9.9 0 0 0 0-1.6l-10-6.7A.9.9 0 0 0 8 5.3z" /></svg>
);
export const Chevron = ({ down = false }: { down?: boolean }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`chev ${down ? 'down' : ''}`}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);
export const PinIcon = ({ filled = false }: { filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <path d="M9 3.5h6l-.8 6 3.3 3.6v1.4h-11v-1.4l3.3-3.6z" /><path d="M12 14.5V21" />
  </svg>
);
export const CheckIcon = () => (
  <Svg size={17}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>
);
export const LinkIcon = () => (
  <Svg size={17}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" /></Svg>
);
export const WaveIcon = () => (
  <Svg size={44}><path d="M4 10v4M8 6.5v11M12 3.5v17M16 7.5v9M20 10v4" /></Svg>
);
export const SpeakerIcon = () => (
  <Svg><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" /></Svg>
);
export const ScreenIcon = () => (
  <Svg><rect x="6.5" y="2.8" width="11" height="18.4" rx="2.6" /><path d="M10.5 5.6h3" /></Svg>
);
export const CardsIcon = () => (
  <Svg><rect x="3.5" y="8" width="17" height="12" rx="2.4" /><path d="M6.5 5h11M8.5 2.5h7" /></Svg>
);
