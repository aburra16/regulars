import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { useCircle } from "./CircleProvider.tsx";
import { WHY_PATH } from "./paths.ts";

/**
 * Lets go of what Update now came to ("updated recently", "couldn't be updated", and the rest) once
 * the person leaves the Why page, where it is said (ruling R13): coming back, the page says nothing
 * stale. An update under way is not touched, and one that ends while they are away is said when they
 * come back. For the shell, which is there on every page: the Why page itself goes when it is left.
 */
export function useClearUpdateOffWhy(): void {
  const onWhy = useLocation().pathname === WHY_PATH;
  const { clearUpdate } = useCircle();
  const wasOnWhy = useRef(onWhy);
  useEffect(() => {
    if (wasOnWhy.current && !onWhy) clearUpdate();
    wasOnWhy.current = onWhy;
  }, [onWhy, clearUpdate]);
}
