import { useCallback, useState } from "react";

import SplashScreen from "@/components/SplashScreen";
import USElectionPage from "@/pages/USElectionPage";
import { useIsDark } from "@/lib/theme";

export type IntroPhase = "splash" | "flyto" | "done";

export default function App() {
  useIsDark();
  const [introPhase, setIntroPhase] = useState<IntroPhase>("splash");

  const onSplashDone = useCallback(() => setIntroPhase("flyto"), []);
  const onIntroDone = useCallback(() => setIntroPhase("done"), []);

  return (
    <div className="h-full w-full bg-slate-950">
      {introPhase === "splash" && <SplashScreen onDone={onSplashDone} />}
      <USElectionPage introPhase={introPhase} onIntroDone={onIntroDone} />
    </div>
  );
}
