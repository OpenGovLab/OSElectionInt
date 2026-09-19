import { useState } from "react";

import SplashScreen from "@/components/SplashScreen";
import USElectionPage from "@/pages/USElectionPage";
import { useIsDark } from "@/lib/theme";

/**
 * The whole app is the map. No router: there is one page, and routing for it
 * would be scaffolding with nothing to hold up.
 *
 * The map mounts immediately and initialises BEHIND the splash rather than
 * after it, so the seconds the splash holds are spent fetching tiles, margins
 * and race points. A boot screen that delays the boot is just a delay.
 */
export default function App() {
  useIsDark();
  const [booting, setBooting] = useState(true);
  return (
    <div className="h-full w-full bg-slate-950">
      {booting && <SplashScreen onDone={() => setBooting(false)} />}
      <USElectionPage />
    </div>
  );
}
