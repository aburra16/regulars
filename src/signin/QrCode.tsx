import { type JSX, useMemo } from "react";
import { encode } from "uqr";

/*
 * A QR code, drawn as SVG in the colour of the words around it (`currentColor`), over the light
 * colour of its box: a token's, set by whatever holds it, never a colour of its own. The QR library
 * (uqr, MIT) comes with this module, in the chunk of what Continue opens on the sign-in page
 * (./ChooseHow.tsx), never the first screen's.
 */

/** The dark modules of a code, as one path in module units: each run of them along a row is one rectangle. */
function pathOf(modules: readonly (readonly boolean[])[]): string {
  let path = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end += 1;
      path += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return path;
}

/**
 * The quiet zone around the code, in modules: the light margin a scanner needs to find it. The QR
 * standard asks for 4. It is part of the drawing, so it is 4 modules at any size the code is drawn.
 */
export const QUIET_ZONE = 4;

/**
 * `text` as a QR code that fills its box, quiet zone and all, named `label` for a screen reader. The
 * box behind it gives the light colour; the code adds no margin of its own beyond `QUIET_ZONE`.
 */
export function QrCode({ text, label }: { text: string; label: string }): JSX.Element {
  const { size, path } = useMemo(() => {
    const code = encode(text, { ecc: "L", border: QUIET_ZONE });
    return { size: code.size, path: pathOf(code.data) };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="block size-full">
      <path d={path} fill="currentColor" />
    </svg>
  );
}
