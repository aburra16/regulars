import type { JSX } from "react";

/** The line icons of the design: 24-unit, round caps and joins, drawn in the text colour. */
function Icon({
  size,
  children,
  className,
  strokeWidth = 2.2,
}: {
  size: number;
  children: JSX.Element[] | JSX.Element;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
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

/** The clock: the Recent tab. */
export function RecentIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
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

/** The crescent moon: the dark mode switch, while the page is light. */
export function MoonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a8 8 0 0 0 10 10z" />
    </Icon>
  );
}

/** The sun and its rays: the dark mode switch, while the page is dark. */
export function SunIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Icon>
  );
}

/** The chevron pointing right: a card that opens a list of places. */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M9 5l7 7-7 7" />
    </Icon>
  );
}

/** Three lines, shortest last: the More chip, which opens the filters. */
export function FilterIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 7h16M7 12h10M10 17h4" />
    </Icon>
  );
}

/** The chevron pointing left: the way back, at the top left of the search results. */
export function BackIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M15 5l-7 7 7 7" />
    </Icon>
  );
}

/** The cross: closes the filters, and clears the search field. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

/** The chevron pointing down: a menu that opens below its button (the desktop's filter menus). */
export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

/** A crosshair: the map's button that goes to where the person is. */
export function LocateIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Icon>
  );
}

/**
 * A pin inside the corners of a frame: on a phone, the map's way back to the place it is about,
 * framed again. Not the crosshair, which is where the person is.
 */
export function BackToPlaceIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <path d="M4 8.5V4h4.5M15.5 4H20v4.5M20 15.5V20h-4.5M8.5 20H4v-4.5" />
      <path d="M12 17.5s4.5-4.1 4.5-7.6a4.5 4.5 0 0 0-9 0c0 3.5 4.5 7.6 4.5 7.6z" />
      <circle cx="12" cy="9.9" r="1.4" />
    </Icon>
  );
}

/** The plus: zooms the map in. */
export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** The minus: zooms the map out. */
export function MinusIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M5 12h14" />
    </Icon>
  );
}

/** Three quarters of a circle: the circle being worked out (Tuning.dc.html's banner). */
export function WorkingIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </Icon>
  );
}
