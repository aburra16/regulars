import type { JSX } from "react";

/** The line icons of the design: 24-unit, round caps and joins, drawn in the text colour. */
function Icon({ size, children, className }: { size: number; children: JSX.Element[] | JSX.Element; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

type IconProps = { size: number; className?: string };

/** The magnifier: the search field, and the Explore tab. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Icon>
  );
}

/** The folded map: the Map tab. */
export function MapIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 4L3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </Icon>
  );
}

/** The bookmark: the Saved tab. */
export function SavedIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M6 4h12v16l-6-4-6 4z" />
    </Icon>
  );
}

/** The head and shoulders: the You tab, and the account button. */
export function PersonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </Icon>
  );
}
