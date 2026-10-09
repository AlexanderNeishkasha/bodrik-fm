"use client";

import { Suspense } from "react";
import StudioWorkspace from "./components/StudioWorkspace";
import useStudioPageState from "./hooks/useStudioPageState";

function StudioPageContent() {
  const workspaceProps = useStudioPageState();
  return <StudioWorkspace {...workspaceProps} />;
}

export default function DmPage() {
  return (
    <Suspense fallback={<div className="hero-bg min-h-screen" />}>
      <StudioPageContent />
    </Suspense>
  );
}
