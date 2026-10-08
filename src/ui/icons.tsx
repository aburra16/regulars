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

/** The head and shoulders: the You tab, and the account button. */
export function PersonIcon(props: IconProps): JSX.Element {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
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
