import { useEffect } from "react";

/**
 * ElectionIntOS is dark, always.
 *
 * The parent app follows the reader's OS preference because it is a news site
 * and a light reading surface is a legitimate choice there. This is a console:
 * the vignette, the hairline borders and the cyan accents are all calibrated
 * against near-black, and the same chrome on white reads as an unfinished
 * form. So the preference is not consulted — the class is simply set.
 */
export function useIsDark(): boolean {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.documentElement.style.colorScheme = "dark";
  }, []);
  return true;
}
